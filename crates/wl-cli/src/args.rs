//! A tiny command-line parser: `--name value`, `--name=value` and boolean
//! `--flag`s, with options allowed to repeat.

use std::collections::HashMap;

/// Options that take no value.
const FLAGS: &[&str] = &["hard", "json", "one-step", "help", "only-matching", "quick", "y-vowel", "any", "no-pairs"];

#[derive(Debug, Default)]
pub struct Args {
    values: HashMap<String, Vec<String>>,
    flags: Vec<String>,
    pub positionals: Vec<String>,
}

impl Args {
    pub fn parse(raw: impl IntoIterator<Item = String>) -> Result<Args, String> {
        let mut args = Args::default();
        let mut it = raw.into_iter();
        while let Some(a) = it.next() {
            if let Some(name) = a.strip_prefix("--") {
                if let Some((k, v)) = name.split_once('=') {
                    args.values.entry(k.to_string()).or_default().push(v.to_string());
                } else if FLAGS.contains(&name) {
                    args.flags.push(name.to_string());
                } else {
                    let v = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
                    args.values.entry(name.to_string()).or_default().push(v);
                }
            } else if a == "-h" {
                args.flags.push("help".into());
            } else {
                args.positionals.push(a);
            }
        }
        Ok(args)
    }

    /// The last value of an option.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).and_then(|v| v.last()).map(String::as_str)
    }

    /// Every value of a repeated option.
    pub fn all(&self, name: &str) -> Vec<&str> {
        self.values.get(name).map(|v| v.iter().map(String::as_str).collect()).unwrap_or_default()
    }

    pub fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }

    /// Parse an option's value.
    pub fn parsed<T: std::str::FromStr>(&self, name: &str) -> Result<Option<T>, String> {
        self.get(name)
            .map(|v| v.parse::<T>().map_err(|_| format!("--{name}: cannot parse {v:?}")))
            .transpose()
    }

    /// Names of options given that are not in `known` (typos).
    pub fn unknown(&self, known: &[&str]) -> Vec<String> {
        self.values.keys().chain(self.flags.iter()).filter(|k| !known.contains(&k.as_str())).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        let a = Args::parse(
            ["card", "--opener", "crane", "--hard", "--strategy={\"kind\":\"max_info\"}", "--opener", "slate", "x"]
                .map(String::from),
        )
        .unwrap();
        assert_eq!(a.positionals, vec!["card", "x"]);
        assert_eq!(a.get("opener"), Some("slate"));
        assert_eq!(a.all("opener"), vec!["crane", "slate"]);
        assert_eq!(a.get("strategy"), Some("{\"kind\":\"max_info\"}"));
        assert!(a.flag("hard") && !a.flag("json"));
        assert_eq!(a.unknown(&["opener", "strategy"]), vec!["hard".to_string()]);
        assert!(Args::parse(["--opener".to_string()]).is_err());
    }
}
