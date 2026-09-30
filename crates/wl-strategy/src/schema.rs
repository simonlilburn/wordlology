//! Parameter schemas: JSON descriptions that drive the Strategy Lab form.
//!
//! Serialised shape (consumed by web/src/lab):
//! ```json
//! { "kind": "info_proportional", "label": "Information-proportional",
//!   "description": "...", "determinism": "stochastic",
//!   "needs": { "frequencies": false },
//!   "params": [ { "name": "beta", "label": "β", "help": "...",
//!                 "type": { "type": "number", "min": 0, "max": 20, "step": 0.1 },
//!                 "default": 1.0 } ] }
//! ```

use serde::Serialize;

use crate::Resources;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ParamSchema {
    /// The `kind` tag of the matching `StrategySpec` variant.
    pub kind: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// "deterministic", "stochastic" or "hybrid".
    pub determinism: &'static str,
    pub needs: Resources,
    pub params: Vec<ParamField>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ParamField {
    pub name: &'static str,
    pub label: &'static str,
    pub help: &'static str,
    #[serde(rename = "type")]
    pub ty: ParamType,
    pub default: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ParamType {
    Number { min: f64, max: f64, step: f64 },
    Integer { min: i64, max: i64 },
    Boolean,
    /// One of a fixed set of string values.
    Choice { options: Vec<ChoiceOption> },
    /// A list of words from the guess list.
    Words { min: usize, max: usize },
    /// A nested strategy spec.
    Strategy,
    /// A list of nested strategy specs.
    Strategies,
    /// A list of non-negative weights (paired with a `strategies` field).
    Weights,
    /// A switch rule (see `SwitchRule`).
    SwitchRule,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ChoiceOption {
    pub value: &'static str,
    pub label: &'static str,
}

impl ParamType {
    pub fn pool() -> ParamType {
        ParamType::Choice {
            options: vec![
                ChoiceOption { value: "candidates", label: "Candidates (words still possible)" },
                ChoiceOption { value: "allowed", label: "All allowed guesses" },
            ],
        }
    }
}
