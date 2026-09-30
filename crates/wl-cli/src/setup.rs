//! Turning command-line options into word lists, engines, configurations and scopes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use wl_core::{AnswerIdx, WordList};
use wl_engine::config::{canonical_json, resolve_answers};
use wl_engine::{Config, Engine, Prepared, Scope, Targets};
use wl_strategy::catalogue;

use crate::args::Args;

pub type Result<T> = std::result::Result<T, String>;

/// Options every command that plays games accepts.
pub const CONFIG_OPTIONS: &[&str] =
    &["config", "list", "strategy", "opener", "answers", "replicates", "seed", "hard", "max-guesses", "weighting"];
/// Options that choose a scope.
pub const SCOPE_OPTIONS: &[&str] = &["scope", "targets", "reps"];

/// The directory holding `data/wordlists`: found above the working
/// directory, or else the one this binary was built from.
pub fn repo_root() -> PathBuf {
    if let Ok(mut dir) = std::env::current_dir() {
        loop {
            if dir.join("data/wordlists").is_dir() {
                return dir;
            }
            if !dir.pop() {
                break;
            }
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A word list loaded from a directory, with its ranked answers if any.
pub struct ListDir {
    pub base: WordList,
    pub ranked: Option<Vec<String>>,
}

impl ListDir {
    pub fn load(dir: &Path) -> Result<ListDir> {
        let base = wl_core::load_dir(dir).map_err(|e| format!("cannot load word list {}: {e}", dir.display()))?;
        let ranked = match &base.manifest.answers_ranked {
            Some(f) => Some(
                std::fs::read_to_string(dir.join(f))
                    .map_err(|e| format!("cannot read {f}: {e}"))?
                    .lines()
                    .map(|l| l.trim().to_ascii_lowercase())
                    .filter(|l| !l.is_empty())
                    .collect(),
            ),
            None => None,
        };
        Ok(ListDir { base, ranked })
    }
}

/// Engines per answer selection, built on demand (building the matrix is the costly part).
pub struct Engines {
    pub list: ListDir,
    built: HashMap<String, Arc<Engine>>,
}

impl Engines {
    pub fn new(list: ListDir) -> Engines {
        Engines { list, built: HashMap::new() }
    }

    /// The engine playing a configuration's answer selection.
    pub fn for_config(&mut self, config: &Config) -> Result<Arc<Engine>> {
        let sel = &config.word_list.answers;
        let key = serde_json::to_string(sel).expect("selection serialises");
        if let Some(e) = self.built.get(&key) {
            return Ok(e.clone());
        }
        let list = resolve_answers(&self.list.base, self.list.ranked.as_deref(), sel).map_err(|e| e.to_string())?;
        let engine = Arc::new(Engine::new(list));
        self.built.insert(key, engine.clone());
        Ok(engine)
    }
}

/// Read a JSON option: inline JSON, or a file holding it.
pub fn json_arg(name: &str, v: &str) -> Result<Value> {
    let text = if v.trim_start().starts_with(['{', '[', '"']) {
        v.to_string()
    } else {
        std::fs::read_to_string(v).map_err(|e| format!("--{name}: cannot read {v}: {e}"))?
    };
    serde_json::from_str(&text).map_err(|e| format!("--{name}: bad JSON: {e}"))
}

/// A strategy option: spec JSON (inline or a file), a preset id, or a bare kind.
pub fn strategy_arg(v: &str) -> Result<Value> {
    if v.trim_start().starts_with('{') || v.ends_with(".json") {
        return json_arg("strategy", v);
    }
    if let Some(p) = catalogue::presets().into_iter().find(|p| p.id == v) {
        return Ok(serde_json::to_value(&p.spec).expect("spec serialises"));
    }
    Ok(json!({ "kind": v }))
}

/// An answers option: `default`, `top:N`, or a file of pasted words.
pub fn answers_arg(v: &str) -> Result<Value> {
    if v == "default" {
        return Ok(json!({"kind": "default"}));
    }
    if let Some(n) = v.strip_prefix("top:") {
        let n: u32 = n.parse().map_err(|_| format!("--answers: bad cutoff {n:?}"))?;
        return Ok(json!({"kind": "top", "n": n}));
    }
    let text = std::fs::read_to_string(v).map_err(|e| format!("--answers: cannot read {v}: {e}"))?;
    let words: Vec<&str> = text.split_whitespace().collect();
    Ok(json!({"kind": "pasted", "sha256": "", "words": words}))
}

/// The word list directory for the options: `--list`, else the base
/// configuration's list under data/wordlists, else open-en-5.
pub fn list_dir(args: &Args, base: Option<&Value>) -> PathBuf {
    if let Some(d) = args.get("list") {
        return PathBuf::from(d);
    }
    let id = base.and_then(|b| b.pointer("/word_list/id")).and_then(Value::as_str).unwrap_or("open-en-5");
    repo_root().join("data/wordlists").join(id)
}

/// The base configuration of `--config` (for one configuration).
pub fn base_config(args: &Args) -> Result<Option<Value>> {
    args.get("config").map(|v| json_arg("config", v)).transpose()
}

/// Configurations from the options: the base (`--config`) with overrides.
/// Repeating `--strategy` and `--opener` gives their cross product
/// (strategies outermost), as an atlas lays them out.
pub fn configs(args: &Args, list: &WordList, base: Option<Value>) -> Result<Vec<Config>> {
    let mut obj = match base {
        Some(Value::Object(m)) => m,
        Some(_) => return Err("--config must be a JSON object".into()),
        None => Map::new(),
    };
    let wl = obj.entry("word_list").or_insert_with(|| json!({}));
    let wl = wl.as_object_mut().ok_or("word_list must be an object")?;
    wl.entry("id").or_insert_with(|| json!(list.manifest.id));
    wl.entry("version").or_insert_with(|| json!(list.manifest.version));
    if let Some(a) = args.get("answers") {
        wl.insert("answers".into(), answers_arg(a)?);
    }
    let rules = obj.entry("rules").or_insert_with(|| json!({}));
    let rules = rules.as_object_mut().ok_or("rules must be an object")?;
    if args.flag("hard") {
        rules.insert("hard_mode".into(), json!(true));
    }
    if let Some(m) = args.parsed::<u8>("max-guesses")? {
        rules.insert("max_guesses".into(), json!(m));
    }
    rules.entry("hard_mode").or_insert(json!(false));
    rules.entry("max_guesses").or_insert(json!(6));
    if let Some(r) = args.parsed::<u32>("replicates")? {
        obj.insert("replicates".into(), json!(r));
    }
    if let Some(s) = args.parsed::<u64>("seed")? {
        obj.insert("base_seed".into(), json!(s));
    }
    if let Some(w) = args.get("weighting") {
        obj.insert("weighting".into(), json!(w));
    }
    let strategies: Vec<Value> = match args.all("strategy").as_slice() {
        [] => vec![obj
            .get("strategy")
            .cloned()
            .unwrap_or_else(|| serde_json::to_value(catalogue::default_arrival()).expect("spec serialises"))],
        list => list.iter().map(|s| strategy_arg(s)).collect::<Result<_>>()?,
    };
    let openers: Vec<Value> = match args.all("opener").as_slice() {
        [] => vec![obj.get("opener").cloned().unwrap_or(Value::Null)],
        list => list.iter().map(|o| if *o == "none" || o.is_empty() { Value::Null } else { json!(o) }).collect(),
    };
    let mut out = Vec::new();
    for s in &strategies {
        for o in &openers {
            let mut c = obj.clone();
            c.insert("strategy".into(), s.clone());
            c.insert("opener".into(), o.clone());
            let text = canonical_json(&Value::Object(c));
            out.push(Config::from_json(&text).map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

/// The scope from `--scope`, or `--targets` (`all`, `sample:N`, or comma
/// separated words or answer indices) and `--reps A:B`.
pub fn scope(args: &Args, engine: &Engine) -> Result<Scope> {
    if let Some(s) = args.get("scope") {
        let v = json_arg("scope", s)?;
        return Scope::from_json(&v.to_string()).map_err(|e| e.to_string());
    }
    let targets = match args.get("targets").unwrap_or("all") {
        "all" => Targets::All,
        t if t.starts_with("sample:") => {
            Targets::Sample(t[7..].parse().map_err(|_| format!("--targets: bad sample size {t:?}"))?)
        }
        t => Targets::List(t.split(',').map(|w| target_arg(engine, w.trim())).collect::<Result<_>>()?),
    };
    let replicates = match args.get("reps") {
        None => None,
        Some(r) => {
            let (a, b) = r.split_once(':').ok_or("--reps: expected A:B")?;
            Some([a.parse().map_err(|_| "--reps: bad start")?, b.parse().map_err(|_| "--reps: bad end")?])
        }
    };
    Ok(Scope { targets, replicates })
}

/// A target: an answer word or an answer index.
pub fn target_arg(engine: &Engine, w: &str) -> Result<AnswerIdx> {
    if let Ok(i) = w.parse::<usize>() {
        return if i < engine.list.n_answers() {
            Ok(i as AnswerIdx)
        } else {
            Err(format!("answer index {i} is out of range"))
        };
    }
    engine.list.answer_of_word(w).ok_or_else(|| format!("{w:?} is not an answer"))
}

/// Prepare a configuration, reporting errors as strings.
pub fn prepare(engine: &Engine, config: &Config) -> Result<Prepared> {
    engine.prepare(config).map_err(|e| e.to_string())
}

/// ISO 8601 UTC time with seconds, e.g. `2026-09-30T15:33:00Z`.
pub fn iso_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    iso_from_unix(secs)
}

/// Format seconds since the Unix epoch as ISO 8601 UTC.
pub fn iso_from_unix(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_times() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_790_782_380), "2026-09-30T15:33:00Z");
        assert_eq!(iso_from_unix(951_782_400), "2000-02-29T00:00:00Z");
    }
}
