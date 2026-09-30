//! Strategy implementations and the spec -> strategy builder.

use wl_core::{WordId, WordList};

use crate::spec::{BuildError, StrategySpec, SwitchRule};
use crate::{ParamSchema, Strategy};

mod coverage;
mod fixed_sequence;
mod freq_proportional;
mod info_proportional;
mod max_info;
mod mixture;
mod most_frequent;
mod random;
mod solve_when_le;
mod switch;

pub use coverage::Coverage;
pub use fixed_sequence::{sequence_then_schema, FixedSequence};
pub use freq_proportional::FreqProportional;
pub use info_proportional::InfoProportional;
pub use max_info::MaxInfo;
pub use mixture::Mixture;
pub use most_frequent::MostFrequent;
pub use random::Random;
pub use solve_when_le::SolveWhenLe;
pub use switch::Switch;

/// Phase numbers 254 and 255 mark player and opener turns.
const MAX_PHASES: usize = 254;

pub(crate) fn build(spec: &StrategySpec, list: &WordList) -> Result<Box<dyn Strategy>, BuildError> {
    let s = build_part(spec, list)?;
    if s.resources().frequencies && list.zipf().is_none() {
        return Err(BuildError::NeedsFrequencies(needs_frequencies(spec).unwrap_or("this strategy")));
    }
    Ok(s)
}

/// The kind of the first part of a spec that needs frequencies.
fn needs_frequencies(spec: &StrategySpec) -> Option<&'static str> {
    match spec {
        StrategySpec::MostFrequent {} | StrategySpec::FreqProportional { .. } => Some(spec.kind()),
        StrategySpec::CoverageThen { then, .. } | StrategySpec::SequenceThen { then, .. } => needs_frequencies(then),
        StrategySpec::Switch { first, then, .. } => needs_frequencies(first).or_else(|| needs_frequencies(then)),
        StrategySpec::Mixture { strategies, .. } => strategies.iter().find_map(needs_frequencies),
        StrategySpec::SolveWhenLe { inner, .. } => needs_frequencies(inner),
        _ => None,
    }
}

fn check_beta(beta: f64) -> Result<(), BuildError> {
    if beta.is_finite() && beta >= 0.0 {
        Ok(())
    } else {
        Err(BuildError::Invalid(format!("beta must be a non-negative number, got {beta}")))
    }
}

fn check_rule(rule: &SwitchRule) -> Result<SwitchRule, BuildError> {
    if let SwitchRule::BitsLe { h } = rule {
        if !(h.is_finite() && *h >= 0.0) {
            return Err(BuildError::Invalid(format!("the bits threshold must be a non-negative number, got {h}")));
        }
    }
    Ok(rule.clone())
}

fn word_ids(list: &WordList, words: &[String]) -> Result<Vec<WordId>, BuildError> {
    if words.is_empty() {
        return Err(BuildError::Invalid("a sequence needs at least one word".into()));
    }
    words.iter().map(|w| list.id(w).ok_or_else(|| BuildError::UnknownWord(w.clone()))).collect()
}

fn build_part(spec: &StrategySpec, list: &WordList) -> Result<Box<dyn Strategy>, BuildError> {
    let s: Box<dyn Strategy> = match spec {
        StrategySpec::MaxInfo { pool } => Box::new(MaxInfo::new(*pool)),
        StrategySpec::MostFrequent {} => Box::new(MostFrequent),
        StrategySpec::FixedSequence { words, solve_when_one } => {
            Box::new(FixedSequence::new("fixed_sequence", word_ids(list, words)?, *solve_when_one))
        }
        StrategySpec::Random { pool } => Box::new(Random::new(*pool)),
        StrategySpec::InfoProportional { beta, pool } => {
            check_beta(*beta)?;
            Box::new(InfoProportional::new(*beta, *pool))
        }
        StrategySpec::FreqProportional { beta } => {
            check_beta(*beta)?;
            Box::new(FreqProportional::new(*beta))
        }
        // The two hybrids are plain switches around their first part.
        StrategySpec::CoverageThen { switch, then } => {
            Box::new(Switch::new("coverage_then", Box::new(Coverage), build_part(then, list)?, check_rule(switch)?))
        }
        StrategySpec::SequenceThen { words, switch, then } => {
            let seq = FixedSequence::new("sequence", word_ids(list, words)?, true);
            Box::new(Switch::new("sequence_then", Box::new(seq), build_part(then, list)?, check_rule(switch)?))
        }
        StrategySpec::Switch { first, then, when } => {
            Box::new(Switch::new("switch", build_part(first, list)?, build_part(then, list)?, check_rule(when)?))
        }
        StrategySpec::Mixture { weights, strategies } => {
            if strategies.is_empty() || weights.len() != strategies.len() {
                return Err(BuildError::Invalid(format!(
                    "a mixture needs one weight per strategy ({} weights, {} strategies)",
                    weights.len(),
                    strategies.len()
                )));
            }
            if weights.iter().any(|w| !(w.is_finite() && *w >= 0.0)) || weights.iter().sum::<f64>() <= 0.0 {
                return Err(BuildError::Invalid("mixture weights must be non-negative with a positive sum".into()));
            }
            let parts = strategies.iter().map(|s| build_part(s, list)).collect::<Result<Vec<_>, _>>()?;
            check_phases(&parts)?;
            Box::new(Mixture::new(weights, parts))
        }
        StrategySpec::SolveWhenLe { n, inner } => {
            if *n == 0 {
                return Err(BuildError::Invalid("solve_when_le needs n of at least 1".into()));
            }
            Box::new(SolveWhenLe::new(*n, build_part(inner, list)?))
        }
    };
    check_phases(std::slice::from_ref(&s))?;
    Ok(s)
}

/// Phase numbers are u8 (254 and 255 reserved), so nesting is bounded.
fn check_phases(parts: &[Box<dyn Strategy>]) -> Result<(), BuildError> {
    // Components are checked before they are combined, so the sum cannot
    // overflow a constructor's u8 offsets unnoticed.
    let n: usize = parts.iter().map(|p| p.phases().len()).sum();
    if n + 1 > MAX_PHASES {
        return Err(BuildError::Invalid(format!("the strategy has too many parts ({n} phases)")));
    }
    Ok(())
}

pub(crate) fn all_schemas() -> Vec<ParamSchema> {
    vec![
        MaxInfo::schema(),
        MostFrequent::schema(),
        FixedSequence::schema(),
        Random::schema(),
        InfoProportional::schema(),
        FreqProportional::schema(),
        Coverage::schema(),
        sequence_then_schema(),
        Switch::schema(),
        Mixture::schema(),
        SolveWhenLe::schema(),
    ]
}
