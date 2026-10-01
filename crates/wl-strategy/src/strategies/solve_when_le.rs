use wl_core::WordId;

use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::StrategySpec;
use crate::{catalogue, rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

/// Modifier: once at most `n` candidates remain, guess one of them instead
/// of asking the inner strategy.
///
/// Which candidate: if the inner strategy is deterministic, the first
/// candidate (the lowest word id), so the whole strategy stays
/// deterministic; otherwise uniformly at random over C, matching the inner
/// strategy's stochastic character. These guesses report the phase `solve`,
/// which follows the inner strategy's phases.
pub struct SolveWhenLe {
    n: u32,
    inner: Box<dyn Strategy>,
    solve_phase: u8,
}

impl SolveWhenLe {
    pub fn new(n: u32, inner: Box<dyn Strategy>) -> SolveWhenLe {
        let solve_phase = u8::try_from(inner.phases().len()).expect("too many phases");
        SolveWhenLe { n, inner, solve_phase }
    }

    fn solving(&self, state: &State) -> bool {
        state.candidates.len() as u64 <= self.n as u64
    }

    fn solve(&self, ctx: &Ctx, state: &State) -> Dist {
        if self.inner.is_deterministic() {
            Dist::single(ctx.first_candidate(state), self.solve_phase)
        } else {
            let words = ctx.candidate_words(state);
            Dist::from_weights(&words, &vec![1.0; words.len()], self.solve_phase)
        }
    }
}

impl Strategy for SolveWhenLe {
    fn id(&self) -> &str {
        "solve_when_le"
    }

    fn is_deterministic(&self) -> bool {
        self.inner.is_deterministic()
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        if self.solving(state) {
            self.solve(ctx, state)
        } else {
            self.inner.distribution(ctx, state)
        }
    }

    /// While solving, the choice depends on C alone, but the inner key is
    /// mixed in too: [`Strategy::exhausted`] passes through to the inner
    /// strategy and must stay a function of this key (a `sequence_exhausted`
    /// switch around this modifier asks it).
    fn state_key(&self, state: &State) -> StateKey {
        if self.solving(state) {
            StateKey::candidates(state).combine(self.inner.state_key(state)).mix(5)
        } else {
            self.inner.state_key(state).mix(6)
        }
    }

    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)> {
        if self.solving(state) {
            let d = self.solve(ctx, state);
            rank_scores(ctx, state, d.entries.iter().map(|e| (e.word, e.p)).collect(), top_k)
        } else {
            self.inner.scores(ctx, state, top_k)
        }
    }

    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "solve_when_le",
            label: "Solve when few remain",
            description: "Wraps a strategy: once at most n candidates remain, guesses one of them (the first if the strategy is deterministic, otherwise one at random).",
            determinism: "hybrid",
            needs: Resources::default(),
            params: vec![
                ParamField {
                    name: "n",
                    label: "At most n candidates",
                    help: "Start guessing candidates once this many or fewer remain.",
                    ty: ParamType::Integer { min: 1, max: 100 },
                    default: serde_json::json!(2),
                },
                ParamField {
                    name: "inner",
                    label: "Strategy",
                    help: "The strategy that plays until then.",
                    ty: ParamType::Strategy,
                    default: serde_json::to_value::<StrategySpec>(catalogue::default_arrival()).unwrap(),
                },
            ],
        }
    }

    fn phases(&self) -> Vec<String> {
        let mut p = self.inner.phases();
        p.push("solve".into());
        p
    }

    fn resources(&self) -> Resources {
        self.inner.resources()
    }

    fn exhausted(&self, ctx: &Ctx, state: &State) -> bool {
        self.inner.exhausted(ctx, state)
    }
}
