use wl_core::WordId;

use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::Pool;
use crate::{rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

/// Stochastic: uniform over the pool.
pub struct Random {
    pool: Pool,
}

impl Random {
    pub fn new(pool: Pool) -> Random {
        Random { pool }
    }
}

impl Strategy for Random {
    fn id(&self) -> &str {
        "random"
    }

    fn is_deterministic(&self) -> bool {
        false
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        let words = ctx.pool_words(state, self.pool);
        let weights = vec![1.0; words.len()];
        Dist::from_weights(&words, &weights, 0)
    }

    fn state_key(&self, state: &State) -> StateKey {
        match self.pool {
            Pool::Candidates => StateKey::candidates(state),
            Pool::Allowed => StateKey::history(state),
        }
    }

    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)> {
        let d = self.distribution(ctx, state);
        rank_scores(ctx, state, d.entries.iter().map(|e| (e.word, e.p)).collect(), top_k)
    }

    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "random",
            label: "Random",
            description: "Guesses uniformly at random from the pool.",
            determinism: "stochastic",
            needs: Resources::default(),
            params: vec![ParamField {
                name: "pool",
                label: "Guess pool",
                help: "Candidates only, or every allowed guess.",
                ty: ParamType::pool(),
                default: serde_json::json!("candidates"),
            }],
        }
    }
}
