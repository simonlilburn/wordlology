use wl_core::{expected_info, WordId};

use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::Pool;
use crate::{argmax_tiebreak, rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

/// Deterministic: the word with the highest expected information, the
/// entropy of its feedback distribution over C. Ties break toward words in
/// C, then the lower word id.
pub struct MaxInfo {
    pool: Pool,
}

impl MaxInfo {
    pub fn new(pool: Pool) -> MaxInfo {
        MaxInfo { pool }
    }

    fn scored(&self, ctx: &Ctx, state: &State) -> Vec<(WordId, f64)> {
        let mut scratch = ctx.scratch();
        ctx.pool_words(state, self.pool)
            .into_iter()
            .map(|w| (w, expected_info(ctx.matrix, w, &state.candidates, &mut scratch)))
            .collect()
    }
}

impl Strategy for MaxInfo {
    fn id(&self) -> &str {
        "max_info"
    }

    fn is_deterministic(&self) -> bool {
        true
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        // With one or two candidates every candidate is optimal (0 or 1 bit,
        // and the tie-break prefers C then the lower id), so skip the scan.
        if state.candidates.len() <= 2 {
            let first = state.candidates.first().expect("no candidates");
            return Dist::single(ctx.list.answer_word(first), 0);
        }
        let best = argmax_tiebreak(ctx, state, self.scored(ctx, state).into_iter()).expect("empty pool");
        Dist::single(best, 0)
    }

    fn state_key(&self, state: &State) -> StateKey {
        match self.pool {
            Pool::Candidates => StateKey::candidates(state),
            // Hard mode narrows the allowed pool by history.
            Pool::Allowed => StateKey::history(state),
        }
    }

    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)> {
        rank_scores(ctx, state, self.scored(ctx, state), top_k)
    }

    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "max_info",
            label: "Maximum information",
            description: "Plays the word with the highest expected information: the entropy of its feedback over the remaining candidates.",
            determinism: "deterministic",
            needs: Resources::default(),
            params: vec![ParamField {
                name: "pool",
                label: "Guess pool",
                help: "Candidates only, or every allowed guess (slower, often better).",
                ty: ParamType::pool(),
                default: serde_json::json!("candidates"),
            }],
        }
    }
}
