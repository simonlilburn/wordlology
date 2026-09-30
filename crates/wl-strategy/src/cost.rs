//! Cost guard: a rough per-state cost estimate, so the UI can warn before
//! running information-based strategies over the full allowed pool.

use crate::spec::{Pool, StrategySpec};

/// Rough number of feedback lookups a strategy makes to choose a guess at a
/// new state, at the worst case of every answer still a candidate
/// (`|C| = n_answers`). Multiply by the number of distinct states a run
/// reaches (about the number of answers for a deterministic card, far more
/// for a stochastic one) and by the time per lookup (a few nanoseconds
/// natively, somewhat more in WASM) for a run-time estimate.
///
/// Information-based strategies cost |pool| × |C|: over the allowed pool of
/// open-en-5 that is 8,636 × 2,500 ≈ 2.2 × 10⁷ at the root.
pub fn estimated_ops_per_state(spec: &StrategySpec, n_guesses: usize, n_answers: usize) -> f64 {
    let (g, a) = (n_guesses as f64, n_answers as f64);
    let pool = |p: &Pool| match p {
        Pool::Candidates => a,
        Pool::Allowed => g,
    };
    let cost = |s: &StrategySpec| estimated_ops_per_state(s, n_guesses, n_answers);
    match spec {
        StrategySpec::MaxInfo { pool: p } | StrategySpec::InfoProportional { pool: p, .. } => pool(p) * a,
        StrategySpec::Random { pool: p } => pool(p),
        StrategySpec::MostFrequent {} | StrategySpec::FreqProportional { .. } | StrategySpec::FixedSequence { .. } => a,
        // Letter counts over C, then one pass over the allowed pool.
        StrategySpec::CoverageThen { then, .. } => (g + a).max(cost(then)),
        StrategySpec::SequenceThen { then, .. } => a.max(cost(then)),
        // Only one side of a switch runs at a state.
        StrategySpec::Switch { first, then, .. } => cost(first).max(cost(then)),
        // Every component with positive weight runs at every state.
        StrategySpec::Mixture { weights, strategies } => {
            strategies.iter().zip(weights).filter(|(_, &w)| w > 0.0).map(|(s, _)| cost(s)).sum()
        }
        StrategySpec::SolveWhenLe { inner, .. } => cost(inner),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalogue::presets;

    #[test]
    fn allowed_pool_is_expensive() {
        let (g, a) = (8636, 2500);
        let cheap = estimated_ops_per_state(&StrategySpec::MaxInfo { pool: Pool::Candidates }, g, a);
        let dear = estimated_ops_per_state(&StrategySpec::MaxInfo { pool: Pool::Allowed }, g, a);
        assert_eq!(dear, 8636.0 * 2500.0);
        assert_eq!(cheap, 2500.0 * 2500.0);
        assert!(estimated_ops_per_state(&StrategySpec::Random { pool: Pool::Candidates }, g, a) < cheap);
        for p in presets() {
            let c = estimated_ops_per_state(&p.spec, g, a);
            assert!(c.is_finite() && c >= 1.0 && c <= dear, "{}: {c}", p.id);
        }
    }
}
