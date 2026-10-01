use wl_core::WordId;

use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::{Pool, StrategySpec, SwitchRule};
use crate::{argmax_tiebreak, rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

/// Deterministic letter coverage, the first part of `coverage_then`.
///
/// Each letter's frequency is the number of candidates containing it. Letters
/// in any earlier guess count as tested. The guess is the allowed word (after
/// hard mode) with no repeated letter whose untested letters have the highest
/// total frequency; ties go to words in C, then the lower word id. If no
/// allowed word lacks repeats (possible only in hard mode), words with
/// repeats are scored by their distinct letters. A single remaining
/// candidate is guessed at once.
pub struct Coverage;

/// Bit mask of a word's letters and whether any repeats.
fn letter_mask(letters: &[u8]) -> (u32, bool) {
    let mut mask = 0u32;
    let mut repeat = false;
    for &b in letters {
        let bit = 1u32 << (b - b'a');
        repeat |= mask & bit != 0;
        mask |= bit;
    }
    (mask, repeat)
}

impl Coverage {
    /// Coverage scores of the pool words eligible at this state.
    fn scored(ctx: &Ctx, state: &State) -> Vec<(WordId, f64)> {
        let mut freq = [0u32; 26];
        for a in state.candidates.iter() {
            let (mask, _) = letter_mask(ctx.list.letters(ctx.list.answer_word(a)));
            for (i, f) in freq.iter_mut().enumerate() {
                *f += mask >> i & 1;
            }
        }
        let tested = state.history.iter().fold(0u32, |m, &(g, _)| m | letter_mask(ctx.list.letters(g)).0);
        let score = |mask: u32| -> f64 {
            let fresh = mask & !tested;
            (0..26).filter(|i| fresh >> i & 1 == 1).map(|i| freq[i] as f64).sum()
        };
        let pool = ctx.allowed_words(state);
        let masks: Vec<(WordId, u32, bool)> = pool
            .iter()
            .map(|&w| {
                let (m, r) = letter_mask(ctx.list.letters(w));
                (w, m, r)
            })
            .collect();
        let any_plain = masks.iter().any(|&(_, _, r)| !r);
        masks.into_iter().filter(|&(_, _, r)| !r || !any_plain).map(|(w, m, _)| (w, score(m))).collect()
    }
}

impl Strategy for Coverage {
    fn id(&self) -> &str {
        "coverage"
    }

    fn is_deterministic(&self) -> bool {
        true
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        if state.candidates.len() == 1 {
            return Dist::single(ctx.first_candidate(state), 0);
        }
        let best = argmax_tiebreak(ctx, state, Self::scored(ctx, state).into_iter())
            .unwrap_or_else(|| ctx.first_candidate(state));
        Dist::single(best, 0)
    }

    /// Letter frequencies depend on C, tested letters and hard mode on the history.
    fn state_key(&self, state: &State) -> StateKey {
        StateKey::history(state)
    }

    /// Eligible words ranked by the total frequency of their untested letters.
    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)> {
        rank_scores(ctx, state, Self::scored(ctx, state), top_k)
    }

    /// The coverage part only appears inside `coverage_then`, so this is its schema.
    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "coverage_then",
            label: "Coverage, then…",
            description: "Greedily plays words (no repeated letters) covering the most frequent untested letters among the remaining candidates, then switches to another strategy by a rule.",
            determinism: "hybrid",
            needs: Resources::default(),
            params: vec![
                ParamField {
                    name: "switch",
                    label: "Switch when",
                    help: "When to stop covering letters and hand over to the next strategy.",
                    ty: ParamType::SwitchRule,
                    default: serde_json::to_value(SwitchRule::AfterTurns { k: 2 }).unwrap(),
                },
                ParamField {
                    name: "then",
                    label: "Then",
                    help: "The strategy that plays after the switch.",
                    ty: ParamType::Strategy,
                    default: serde_json::to_value(StrategySpec::MaxInfo { pool: Pool::Candidates }).unwrap(),
                },
            ],
        }
    }
}
