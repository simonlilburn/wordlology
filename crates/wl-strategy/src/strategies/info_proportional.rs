use wl_core::{math, WordId};

use crate::info::InfoScorer;
use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::Pool;
use crate::{rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

/// Stochastic: P(w) proportional to I(w)^beta, with I(w) the expected
/// information. At beta = 0 it is uniform; as beta grows it approaches max_info.
pub struct InfoProportional {
    beta: f64,
    pool: Pool,
}

impl InfoProportional {
    pub fn new(beta: f64, pool: Pool) -> InfoProportional {
        InfoProportional { beta, pool }
    }

    fn infos(&self, ctx: &Ctx, state: &State) -> (Vec<WordId>, Vec<f64>) {
        let mut scorer = InfoScorer::new(ctx.matrix, &state.candidates);
        let words = ctx.pool_words(state, self.pool);
        let infos = words.iter().map(|&w| scorer.score(ctx.matrix, w)).collect();
        (words, infos)
    }
}

impl Strategy for InfoProportional {
    fn id(&self) -> &str {
        "info_proportional"
    }

    fn is_deterministic(&self) -> bool {
        false
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        if state.candidates.len() == 1 {
            let a = state.candidates.first().unwrap();
            return Dist::single(ctx.list.answer_word(a), 0);
        }
        let (words, infos) = self.infos(ctx, state);
        let weights: Vec<f64> = if self.beta == 0.0 {
            vec![1.0; words.len()]
        } else {
            let w: Vec<f64> = infos.iter().map(|&i| if i > 0.0 { math::pow(i, self.beta) } else { 0.0 }).collect();
            if w.iter().sum::<f64>().is_finite() {
                w
            } else {
                // I^beta overflowed (beta in the hundreds): scale by the
                // largest I first, which leaves the distribution unchanged.
                let max = infos.iter().copied().fold(0.0, f64::max);
                infos.iter().map(|&i| if i > 0.0 { math::pow(i / max, self.beta) } else { 0.0 }).collect()
            }
        };
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
            kind: "info_proportional",
            label: "Information-proportional",
            description: "Guesses at random with probability proportional to expected information raised to the power β. β = 0 is uniform; large β approaches maximum information.",
            determinism: "stochastic",
            needs: Resources::default(),
            params: vec![
                ParamField {
                    name: "beta",
                    label: "β",
                    help: "Sharpness: 0 is uniform, higher concentrates on informative words.",
                    ty: ParamType::Number { min: 0.0, max: 20.0, step: 0.1 },
                    default: serde_json::json!(1.0),
                },
                ParamField {
                    name: "pool",
                    label: "Guess pool",
                    help: "Candidates only (fast), or every allowed guess (slow: shows an estimate first).",
                    ty: ParamType::pool(),
                    default: serde_json::json!("candidates"),
                },
            ],
        }
    }
}
