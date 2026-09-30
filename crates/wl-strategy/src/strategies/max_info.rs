use wl_core::WordId;

use crate::info::{score_words, Equivalence, FastSet, InfoScorer};
use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::Pool;
use crate::{rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

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
        let words = ctx.pool_words(state, self.pool);
        let scores = score_words(ctx, state, &words);
        words.into_iter().zip(scores).collect()
    }

    /// The choice: exactly `argmax_tiebreak` over every pool word's expected
    /// information (highest score, then words in C, then the lower id), found
    /// with less work.
    ///
    /// No word scores above log2 |C| (every candidate alone in its bucket),
    /// and a word's score is computed identically however it is reached. So:
    ///
    /// 1. Candidates are scored first (they are in either pool). The
    ///    lowest-id candidate reaching log2 |C| wins outright: nothing beats
    ///    it, and ties prefer candidates, then lower ids.
    /// 2. Otherwise, over the allowed pool, the other words are scanned in
    ///    increasing id order. The first to reach log2 |C| wins (no candidate
    ///    reached it, and every later word has a higher id), so the scan
    ///    stops there; small candidate sets usually have such a word early.
    ///    A word [equivalent](Equivalence) to a candidate or to an earlier
    ///    word scores the same and loses the tie, so it is skipped.
    /// 3. Otherwise the best of the rest competes with the best candidate
    ///    under the same tie-break.
    fn best(&self, ctx: &Ctx, state: &State) -> WordId {
        let mut scorer = InfoScorer::new(ctx.matrix, &state.candidates);
        let max = scorer.max_score();
        let mut cands = ctx.candidate_words(state);
        cands.sort_unstable(); // answer order is id order for sorted lists; don't rely on it
        let mut best_cand: Option<(WordId, f64)> = None;
        for &w in &cands {
            let s = scorer.score(ctx.matrix, w);
            if s == max {
                return w;
            }
            if best_cand.is_none_or(|(_, b)| s > b) {
                best_cand = Some((w, s));
            }
        }
        let (cand, cand_score) = best_cand.expect("no candidates");
        if self.pool == Pool::Candidates {
            return cand;
        }
        let eq = Equivalence::new(ctx.list, &state.candidates);
        let mut seen = FastSet::default();
        if eq.useful() {
            seen.extend(cands.iter().map(|&w| eq.key(ctx.list.letters(w))));
        }
        let mut best_other: Option<(WordId, f64)> = None;
        for w in ctx.allowed_words(state) {
            if ctx.is_candidate(state, w) || (eq.useful() && !seen.insert(eq.key(ctx.list.letters(w)))) {
                continue;
            }
            let s = scorer.score(ctx.matrix, w);
            if s == max {
                return w;
            }
            if best_other.is_none_or(|(_, b)| s > b) {
                best_other = Some((w, s));
            }
        }
        match best_other {
            // Strictly better than every candidate; ties go to the candidate.
            Some((w, s)) if s > cand_score => w,
            _ => cand,
        }
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
