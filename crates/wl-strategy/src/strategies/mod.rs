//! Strategy implementations and the spec -> strategy builder.

use wl_core::WordList;

use crate::spec::{BuildError, StrategySpec};
use crate::{ParamSchema, Strategy};

mod info_proportional;
mod max_info;
mod random;

pub use info_proportional::InfoProportional;
pub use max_info::MaxInfo;
pub use random::Random;

pub(crate) fn build(spec: &StrategySpec, list: &WordList) -> Result<Box<dyn Strategy>, BuildError> {
    let _ = list;
    Ok(match spec {
        StrategySpec::MaxInfo { pool } => Box::new(MaxInfo::new(*pool)),
        StrategySpec::Random { pool } => Box::new(Random::new(*pool)),
        StrategySpec::InfoProportional { beta, pool } => {
            if !(beta.is_finite() && *beta >= 0.0) {
                return Err(BuildError::Invalid(format!("beta must be a non-negative number, got {beta}")));
            }
            Box::new(InfoProportional::new(*beta, *pool))
        }
        other => return Err(BuildError::NotImplemented(other.kind())),
    })
}

pub(crate) fn all_schemas() -> Vec<ParamSchema> {
    vec![MaxInfo::schema(), Random::schema(), InfoProportional::schema()]
}
