use wl_core::WordId;

use crate::info::InfoScorer;
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
        let mut scorer = InfoScorer::new(ctx.matrix, &state.candidates);
        ctx.pool_words(state, self.pool).into_iter().map(|w| (w, scorer.score(ctx.matrix, w))).collect()
    }

    /// The choice, equal to `argmax_tiebreak` over every pool word's
    /// expected information, found with less work.
    fn best(&self, ctx: &Ctx, state: &State) -> WordId {
        let mut scorer = InfoScorer::new(ctx.matrix, &state.candidates);
        let mut cands = ctx.candidate_words(state);
        cands.sort_unstable();
        let cand_scores: Vec<(WordId, f64)> = cands.iter().map(|&w| (w, scorer.score(ctx.matrix, w))).collect();
        // No word scores above log2 |C| (every candidate alone in its
        // bucket), and ties prefer candidates, then lower ids. So the
        // lowest-id candidate reaching that bound is the answer without
        // scanning the rest of the pool (candidates are in either pool).
        if let Some(&(w, _)) = cand_scores.iter().find(|&&(_, s)| s == scorer.max_score()) {
            return w;
        }
        match self.pool {
            Pool::Candidates => argmax_tiebreak(ctx, state, cand_scores.into_iter()),
            Pool::Allowed => {
                let scored = ctx.allowed_words(state).into_iter().map(|w| (w, scorer.score(ctx.matrix, w)));
                argmax_tiebreak(ctx, state, scored)
            }
        }
        .expect("empty pool")
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
        Dist::single(self.best(ctx, state), 0)
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
