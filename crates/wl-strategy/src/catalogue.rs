//! The preset catalogue shown in the Strategy Lab and used by rankings.
//!
//! One preset per row of the catalogue in docs/specification.md ("Strategy
//! Lab and catalogue"), plus the allowed-pool variant of max_info and an
//! ε-greedy mixture. Colours come from the Okabe–Ito palette (with a grey for
//! the random baseline and two colours from Paul Tol's muted palette), which
//! stays distinguishable under the common forms of colour blindness.

use serde::Serialize;

use crate::spec::{Pool, StrategySpec, SwitchRule};

#[derive(Clone, Debug, Serialize)]
pub struct Preset {
    /// Stable preset id.
    pub id: &'static str,
    pub label: &'static str,
    /// Display colour (hex).
    pub colour: &'static str,
    pub spec: StrategySpec,
}

/// The default arrival strategy: info_proportional, beta = 1, candidate pool.
pub fn default_arrival() -> StrategySpec {
    StrategySpec::InfoProportional { beta: 1.0, pool: Pool::Candidates }
}

fn words(w: &[&str]) -> Vec<String> {
    w.iter().map(|s| s.to_string()).collect()
}

fn max_info() -> Box<StrategySpec> {
    Box::new(StrategySpec::MaxInfo { pool: Pool::Candidates })
}

/// Presets in display order: the default arrival strategy first, then the
/// catalogue's order. The listed words are all allowed guesses in open-en-5
/// (a preset naming words another list lacks fails to build there with
/// `BuildError::UnknownWord`).
pub fn presets() -> Vec<Preset> {
    vec![
        Preset { id: "info_proportional", label: "Info-proportional (β = 1)", colour: "#0072b2", spec: default_arrival() },
        Preset { id: "max_info", label: "Max information", colour: "#009e73", spec: *max_info() },
        Preset {
            id: "max_info_allowed",
            label: "Max information (all guesses)",
            colour: "#56b4e9",
            spec: StrategySpec::MaxInfo { pool: Pool::Allowed },
        },
        Preset { id: "most_frequent", label: "Most frequent", colour: "#e69f00", spec: StrategySpec::MostFrequent {} },
        Preset {
            id: "fixed_sequence",
            label: "Slate, crony, build",
            colour: "#cc79a7",
            spec: StrategySpec::FixedSequence { words: words(&["slate", "crony", "build"]), solve_when_one: true },
        },
        Preset { id: "random", label: "Random candidate", colour: "#8c8c8c", spec: StrategySpec::Random { pool: Pool::Candidates } },
        Preset {
            id: "freq_proportional",
            label: "Frequency-proportional (β = 1)",
            colour: "#d55e00",
            spec: StrategySpec::FreqProportional { beta: 1.0 },
        },
        Preset {
            id: "coverage_then",
            label: "Coverage, then max info",
            colour: "#999933",
            spec: StrategySpec::CoverageThen { switch: SwitchRule::AfterTurns { k: 2 }, then: max_info() },
        },
        Preset {
            id: "sequence_then",
            label: "Saint, older, then max info",
            colour: "#882255",
            spec: StrategySpec::SequenceThen {
                words: words(&["saint", "older"]),
                switch: SwitchRule::SequenceExhausted,
                then: max_info(),
            },
        },
        Preset {
            id: "epsilon_greedy",
            label: "ε-greedy (10% random)",
            colour: "#f0e442",
            spec: StrategySpec::Mixture {
                weights: vec![0.9, 0.1],
                strategies: vec![*max_info(), StrategySpec::Random { pool: Pool::Candidates }],
            },
        },
    ]
}
