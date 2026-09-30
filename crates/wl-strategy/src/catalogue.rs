//! The preset catalogue shown in the Strategy Lab and used by rankings.

use serde::Serialize;

use crate::spec::{Pool, StrategySpec};

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

/// Presets in display order.
pub fn presets() -> Vec<Preset> {
    vec![
        Preset { id: "info_proportional", label: "Info-proportional (β = 1)", colour: "#7c5cff", spec: default_arrival() },
        Preset { id: "max_info", label: "Max information", colour: "#1f9d8b", spec: StrategySpec::MaxInfo { pool: Pool::Candidates } },
        Preset { id: "max_info_allowed", label: "Max information (all guesses)", colour: "#0f6b8f", spec: StrategySpec::MaxInfo { pool: Pool::Allowed } },
        Preset { id: "random", label: "Random candidate", colour: "#d9822b", spec: StrategySpec::Random { pool: Pool::Candidates } },
    ]
}
