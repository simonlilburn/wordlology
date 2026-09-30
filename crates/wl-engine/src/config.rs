//! Configurations, their canonical JSON and config IDs, and answer selections.
//!
//! See docs/architecture.md, "Configuration and config ID". A configuration is
//! everything that determines the games played; its ID is the first 16 hex
//! digits of `BLAKE3(canonical_json + "\n" + SOLVER_VERSION)`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use wl_core::{WordList, SOLVER_VERSION};
use wl_strategy::{Rules, StrategySpec};

use crate::EngineError;

/// Which answers a configuration uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AnswerSelection {
    /// The list's `answers.txt`.
    #[default]
    Default,
    /// The `n` most frequent reviewed answers (the first n lines of
    /// `answers-ranked.txt`, re-sorted alphabetically).
    Top { n: u32 },
    /// A pasted list. `sha256` is the hex SHA-256 of the normalised words
    /// (see [`normalise_words`]) joined by `"\n"`. Canonicalisation drops the
    /// words and keeps the hash.
    Pasted {
        #[serde(default)]
        sha256: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        words: Option<Vec<String>>,
    },
}

/// The word list a configuration plays on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WordListRef {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub answers: AnswerSelection,
}

/// Target weighting for cards.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Weighting {
    /// Every answer counts `1/|A|`.
    #[default]
    Equal,
    /// Each answer counts its share of total frequency `10^zipf`.
    Frequency,
}

fn default_replicates() -> u32 {
    20
}

fn default_seed() -> u64 {
    1
}

/// A configuration: word list, rules, strategy, opener, replicates, seed and
/// weighting. Mirrors `Config` in web/src/backend/types.ts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub word_list: WordListRef,
    #[serde(default)]
    pub rules: Rules,
    pub strategy: StrategySpec,
    /// Lowercase opener, or `None` for the strategy's own choice.
    #[serde(default)]
    pub opener: Option<String>,
    /// Replicates per target (canonicalised to 1 for deterministic strategies).
    #[serde(default = "default_replicates")]
    pub replicates: u32,
    #[serde(default = "default_seed")]
    pub base_seed: u64,
    #[serde(default)]
    pub weighting: Weighting,
}

/// Largest supported max guesses (a game's turn count is a u8 in batches).
pub const MAX_MAX_GUESSES: u8 = 20;
/// Largest replicate count (replicate indices are u16 in batches).
pub const MAX_REPLICATES: u32 = 65_535;

impl Config {
    /// Parse a configuration from JSON.
    pub fn from_json(json: &str) -> Result<Config, EngineError> {
        serde_json::from_str(json).map_err(|e| EngineError::Config(format!("bad configuration: {e}")))
    }

    /// A configuration with default settings for a word list and strategy.
    pub fn new(list: &WordList, strategy: StrategySpec) -> Config {
        Config {
            word_list: WordListRef {
                id: list.manifest.id.clone(),
                version: list.manifest.version.clone(),
                answers: AnswerSelection::Default,
            },
            rules: Rules::default(),
            strategy,
            opener: None,
            replicates: default_replicates(),
            base_seed: default_seed(),
            weighting: Weighting::Equal,
        }
    }

    /// The canonical form of this configuration.
    ///
    /// - strategy defaults are filled in (parsing into [`StrategySpec`] does this),
    /// - `replicates` is forced to 1 when the strategy is `deterministic`,
    /// - the opener is trimmed and lowercased (an empty opener means none),
    /// - pasted answer words are normalised, hashed and dropped (the
    ///   `sha256` identifies them; a given hash must match the words).
    ///
    /// Validation of values that do not need a word list happens here too.
    pub fn canonicalized(&self, deterministic: bool) -> Result<Config, EngineError> {
        let mut c = self.clone();
        if c.rules.max_guesses == 0 || c.rules.max_guesses > MAX_MAX_GUESSES {
            return Err(EngineError::Config(format!(
                "max_guesses must be between 1 and {MAX_MAX_GUESSES}, got {}",
                c.rules.max_guesses
            )));
        }
        if c.replicates == 0 || c.replicates > MAX_REPLICATES {
            return Err(EngineError::Config(format!(
                "replicates must be between 1 and {MAX_REPLICATES}, got {}",
                c.replicates
            )));
        }
        if deterministic {
            c.replicates = 1;
        }
        c.opener = c.opener.map(|o| o.trim().to_ascii_lowercase()).filter(|o| !o.is_empty());
        c.word_list.answers = match c.word_list.answers {
            AnswerSelection::Default => AnswerSelection::Default,
            AnswerSelection::Top { n } => {
                if n == 0 {
                    return Err(EngineError::Config("an answer cutoff must be at least 1".into()));
                }
                AnswerSelection::Top { n }
            }
            AnswerSelection::Pasted { sha256, words } => {
                let sha256 = sha256.trim().to_ascii_lowercase();
                let sha = match words {
                    Some(words) => {
                        let computed = answers_sha256(&words);
                        if !sha256.is_empty() && sha256 != computed {
                            return Err(EngineError::Config(format!(
                                "pasted answers: sha256 {sha256} does not match the words (expected {computed})"
                            )));
                        }
                        computed
                    }
                    None if sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()) => sha256,
                    None => return Err(EngineError::Config("pasted answers need words or a sha256".into())),
                };
                AnswerSelection::Pasted { sha256: sha, words: None }
            }
        };
        Ok(c)
    }

    /// Canonical JSON of this configuration as it stands (call
    /// [`Config::canonicalized`] first): keys sorted, no whitespace.
    pub fn to_canonical_json(&self) -> String {
        canonical_json(&serde_json::to_value(self).expect("config serialises"))
    }
}

/// The config ID for a canonical JSON string.
pub fn config_id(canonical: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(canonical.as_bytes());
    h.update(b"\n");
    h.update(SOLVER_VERSION.as_bytes());
    h.finalize().to_hex()[..16].to_string()
}

/// Canonical JSON of a strategy spec: defaults filled in, keys sorted, no whitespace.
pub fn strategy_canonical_json(spec: &StrategySpec) -> String {
    canonical_json(&serde_json::to_value(spec).expect("spec serialises"))
}

/// Serialise a JSON value with object keys sorted and no whitespace. Numbers
/// use serde_json's shortest round-trip form. Sorting is explicit, so the
/// output does not depend on serde_json's `preserve_order` feature.
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("string serialises"));
                out.push(':');
                write_canonical(&map[k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).expect("value serialises")),
    }
}

/// Normalise pasted words: trim, lowercase, drop empties and duplicates, sort
/// (as `normaliseWords` in web/src/model/sha256.ts).
pub fn normalise_words<S: AsRef<str>>(words: &[S]) -> Vec<String> {
    let mut out: Vec<String> =
        words.iter().map(|w| w.as_ref().trim().to_ascii_lowercase()).filter(|w| !w.is_empty()).collect();
    out.sort();
    out.dedup();
    out
}

/// The `sha256` of an answer list: hex SHA-256 of the normalised words joined by `"\n"`.
pub fn answers_sha256<S: AsRef<str>>(words: &[S]) -> String {
    let joined = normalise_words(words).join("\n");
    let digest = Sha256::digest(joined.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve an answer selection against a loaded word list (whose answers are
/// the list's default answers), returning the list to play on.
///
/// `ranked` holds `answers-ranked.txt`, most frequent first, if the list has
/// one. A cutoff above the number of ranked answers is clamped (as the web
/// app does). The answers of the result are always sorted alphabetically.
pub fn resolve_answers(
    base: &WordList,
    ranked: Option<&[String]>,
    selection: &AnswerSelection,
) -> Result<WordList, EngineError> {
    let words: Vec<String> = match selection {
        AnswerSelection::Default => base.answers().iter().map(|&id| base.word(id).to_string()).collect(),
        AnswerSelection::Top { n } => {
            let ranked = ranked.ok_or_else(|| {
                EngineError::Config(format!("word list {} has no ranked answers for a cutoff", base.manifest.id))
            })?;
            if *n == 0 {
                return Err(EngineError::Config("an answer cutoff must be at least 1".into()));
            }
            ranked[..(*n as usize).min(ranked.len())].to_vec()
        }
        AnswerSelection::Pasted { words: Some(words), sha256 } => {
            let words = normalise_words(words);
            if !sha256.is_empty() && answers_sha256(&words) != sha256.to_ascii_lowercase() {
                return Err(EngineError::Config("pasted answers: sha256 does not match the words".into()));
            }
            words
        }
        AnswerSelection::Pasted { words: None, .. } => {
            return Err(EngineError::Config("a pasted answer selection needs its words to be played".into()))
        }
    };
    let mut ids: Vec<u16> = Vec::with_capacity(words.len());
    for w in &words {
        ids.push(base.id(w).ok_or_else(|| EngineError::Config(format!("answer {w:?} is not in the guess list")))?);
    }
    // Sorted by word id is alphabetical, since guesses.txt is sorted.
    ids.sort_unstable();
    ids.dedup();
    let sorted: Vec<&str> = ids.iter().map(|&id| base.word(id)).collect();
    Ok(base.with_answers(&sorted)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys() {
        let v: Value = serde_json::from_str(r#"{"b":1,"a":{"z":[1,{"y":2,"x":1.5}],"c":null}}"#).unwrap();
        assert_eq!(canonical_json(&v), r#"{"a":{"c":null,"z":[1,{"x":1.5,"y":2}]},"b":1}"#);
    }

    #[test]
    fn strategy_json_matches_spec_canonical() {
        for p in wl_strategy::catalogue::presets() {
            assert_eq!(strategy_canonical_json(&p.spec), p.spec.canonical_json());
        }
    }

    fn sample() -> Config {
        Config::from_json(
            r#"{"word_list":{"id":"open-en-5","version":"1.0.0","answers":{"kind":"default"}},
                "rules":{"max_guesses":6,"hard_mode":false},
                "strategy":{"kind":"info_proportional"},
                "opener":" Crane ","replicates":200,"base_seed":1,"weighting":"equal"}"#,
        )
        .unwrap()
    }

    #[test]
    fn canonicalisation() {
        let c = sample().canonicalized(false).unwrap();
        let json = c.to_canonical_json();
        assert_eq!(
            json,
            r#"{"base_seed":1,"opener":"crane","replicates":200,"rules":{"hard_mode":false,"max_guesses":6},"strategy":{"beta":1.0,"kind":"info_proportional","pool":"candidates"},"weighting":"equal","word_list":{"answers":{"kind":"default"},"id":"open-en-5","version":"1.0.0"}}"#
        );
        let id = config_id(&json);
        assert_eq!(id.len(), 16);
        let full = blake3::hash(format!("{json}\n{SOLVER_VERSION}").as_bytes()).to_hex();
        assert_eq!(&full[..16], id);
        // Deterministic strategies drop replicates to 1.
        let det = sample().canonicalized(true).unwrap();
        assert_eq!(det.replicates, 1);
        // Canonicalisation is idempotent.
        assert_eq!(c.canonicalized(false).unwrap(), c);
    }

    #[test]
    fn pasted_words_are_dropped() {
        let mut c = sample();
        c.word_list.answers = AnswerSelection::Pasted { sha256: String::new(), words: Some(vec!["Slate".into(), "crane".into(), "crane".into()]) };
        let canon = c.canonicalized(false).unwrap();
        let expected = answers_sha256(&["crane", "slate"]);
        assert_eq!(canon.word_list.answers, AnswerSelection::Pasted { sha256: expected.clone(), words: None });
        assert!(!canon.to_canonical_json().contains("words"));
        // A wrong hash is rejected.
        c.word_list.answers = AnswerSelection::Pasted { sha256: "0".repeat(64), words: Some(vec!["crane".into()]) };
        assert!(c.canonicalized(false).is_err());
        // SHA-256 of "crane\nslate".
        assert_eq!(expected, format!("{:x}", Sha256::digest(b"crane\nslate")));
    }

    #[test]
    fn rejects_bad_values() {
        let mut c = sample();
        c.rules.max_guesses = 0;
        assert!(c.canonicalized(false).is_err());
        let mut c = sample();
        c.replicates = 0;
        assert!(c.canonicalized(false).is_err());
        assert!(Config::from_json(r#"{"word_list":{"id":"x","version":"1"},"strategy":{"kind":"max_info"},"typo":1}"#).is_err());
        // Defaults fill in everything but the word list and strategy.
        let c = Config::from_json(r#"{"word_list":{"id":"x","version":"1"},"strategy":{"kind":"max_info"}}"#).unwrap();
        assert_eq!(c.rules, Rules::default());
        assert_eq!((c.replicates, c.base_seed, c.opener.clone()), (20, 1, None));
    }
}
