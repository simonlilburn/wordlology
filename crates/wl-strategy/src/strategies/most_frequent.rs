use wl_core::WordId;

use crate::schema::ParamSchema;
use crate::{argmax_tiebreak, rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

/// Deterministic: the most frequent word in C by the list's Zipf values.
/// Ties break toward the lower word id. Needs frequencies.
pub struct MostFrequent;

impl MostFrequent {
    fn scored(ctx: &Ctx, state: &State) -> Vec<(WordId, f64)> {
        ctx.candidate_words(state).into_iter().map(|w| (w, ctx.list.zipf_of(w) as f64)).collect()
    }
}

impl Strategy for MostFrequent {
    fn id(&self) -> &str {
        "most_frequent"
    }

    fn is_deterministic(&self) -> bool {
        true
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        let best = argmax_tiebreak(ctx, state, Self::scored(ctx, state).into_iter()).expect("no candidates");
        Dist::single(best, 0)
    }

    fn state_key(&self, state: &State) -> StateKey {
        StateKey::candidates(state)
    }

    /// Candidates ranked by Zipf frequency.
    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)> {
        rank_scores(ctx, state, Self::scored(ctx, state), top_k)
    }

    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "most_frequent",
            label: "Most frequent",
            description: "Plays the most common word still possible, by the word list's frequencies (Zipf scale). Ties go to the alphabetically earlier word.",
            determinism: "deterministic",
            needs: Resources { frequencies: true },
            params: vec![],
        }
    }

    fn resources(&self) -> Resources {
        Resources { frequencies: true }
    }
}
