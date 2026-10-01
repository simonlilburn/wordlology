//! `StrategySpec`: the serde-tagged enum naming every strategy and its parameters.
//!
//! JSON form: `{"kind": "info_proportional", "beta": 1.0, "pool": "candidates"}`.
//! The canonical JSON (sorted keys, no whitespace) is part of the config ID.

use serde::{Deserialize, Serialize};

use crate::strategies;
use crate::{ParamSchema, Strategy};

/// Which words a strategy may guess.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Pool {
    /// Words still consistent with the feedback (the answer candidates C).
    #[default]
    Candidates,
    /// Every allowed guess (narrowed by hard mode).
    Allowed,
}

/// When a `Switch` moves from its first strategy to the next.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "when", rename_all = "snake_case")]
pub enum SwitchRule {
    /// After k guesses have been made.
    AfterTurns { k: u8 },
    /// Once |C| <= n.
    CandidatesLe { n: u32 },
    /// Once the remaining uncertainty log2 |C| <= h bits.
    BitsLe { h: f64 },
    /// When the first strategy's sequence runs out.
    SequenceExhausted,
}

fn default_beta() -> f64 {
    1.0
}

fn default_true() -> bool {
    true
}

/// Every strategy the solver can build. Adding one: implement `Strategy`,
/// add a variant here with its schema, and add a golden test.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StrategySpec {
    /// Word with the highest expected information.
    MaxInfo {
        #[serde(default)]
        pool: Pool,
    },
    /// Most frequent word in C.
    MostFrequent {},
    /// Plays a listed sequence in order.
    FixedSequence {
        words: Vec<String>,
        /// Solve (guess the candidate) as soon as one candidate is left.
        #[serde(default = "default_true")]
        solve_when_one: bool,
    },
    /// Uniform over the pool.
    Random {
        #[serde(default)]
        pool: Pool,
    },
    /// P(w) proportional to I(w)^beta.
    InfoProportional {
        #[serde(default = "default_beta")]
        beta: f64,
        #[serde(default)]
        pool: Pool,
    },
    /// P(w) proportional to f(w)^beta over C, with f the word frequency.
    FreqProportional {
        #[serde(default = "default_beta")]
        beta: f64,
    },
    /// Greedy letter coverage (no repeats), then switch.
    CoverageThen { switch: SwitchRule, then: Box<StrategySpec> },
    /// A fixed sequence, then switch.
    SequenceThen { words: Vec<String>, switch: SwitchRule, then: Box<StrategySpec> },
    /// Combinator: play `first` until `when`, then `then`.
    Switch { first: Box<StrategySpec>, then: Box<StrategySpec>, when: SwitchRule },
    /// Combinator: pick a component with probability proportional to its weight.
    Mixture { weights: Vec<f64>, strategies: Vec<StrategySpec> },
    /// Modifier: guess from C once |C| <= n.
    SolveWhenLe { n: u32, inner: Box<StrategySpec> },
}

impl StrategySpec {
    /// The `kind` tag.
    pub fn kind(&self) -> &'static str {
        match self {
            StrategySpec::MaxInfo { .. } => "max_info",
            StrategySpec::MostFrequent { .. } => "most_frequent",
            StrategySpec::FixedSequence { .. } => "fixed_sequence",
            StrategySpec::Random { .. } => "random",
            StrategySpec::InfoProportional { .. } => "info_proportional",
            StrategySpec::FreqProportional { .. } => "freq_proportional",
            StrategySpec::CoverageThen { .. } => "coverage_then",
            StrategySpec::SequenceThen { .. } => "sequence_then",
            StrategySpec::Switch { .. } => "switch",
            StrategySpec::Mixture { .. } => "mixture",
            StrategySpec::SolveWhenLe { .. } => "solve_when_le",
        }
    }

    /// Canonical JSON: keys sorted, no whitespace. Stable across builds.
    pub fn canonical_json(&self) -> String {
        let v = serde_json::to_value(self).expect("spec serialises");
        // serde_json::Value maps are BTreeMaps (sorted) without preserve_order.
        serde_json::to_string(&v).expect("value serialises")
    }

    /// Parse from JSON.
    pub fn from_json(s: &str) -> Result<StrategySpec, serde_json::Error> {
        serde_json::from_str(s)
    }

    /// Build the strategy for a word list. Fails if a listed word is not an
    /// allowed guess or a needed resource (such as frequencies) is missing.
    pub fn build(&self, list: &wl_core::WordList) -> Result<Box<dyn Strategy>, BuildError> {
        strategies::build(self, list)
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum BuildError {
    #[error("{0:?} is not an allowed guess")]
    UnknownWord(String),
    #[error("this word list has no frequencies, which {0} needs")]
    NeedsFrequencies(&'static str),
    #[error("invalid parameter: {0}")]
    Invalid(String),
    #[error("strategy {0} is not implemented yet")]
    NotImplemented(&'static str),
}

/// Schemas for every strategy kind, in catalogue order.
pub fn all_schemas() -> Vec<ParamSchema> {
    strategies::all_schemas()
}
