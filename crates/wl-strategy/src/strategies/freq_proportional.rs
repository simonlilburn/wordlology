use wl_core::{math, WordId};

use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::{rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

/// Stochastic: P(w) ∝ f(w)^β over C, with f = 10^zipf the word frequency.
/// β = 0 is uniform over C; as β grows it approaches `most_frequent`.
/// Needs frequencies.
pub struct FreqProportional {
    beta: f64,
}

impl FreqProportional {
    pub fn new(beta: f64) -> FreqProportional {
        FreqProportional { beta }
    }
}

impl Strategy for FreqProportional {
    fn id(&self) -> &str {
        "freq_proportional"
    }

    fn is_deterministic(&self) -> bool {
        false
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        let words = ctx.candidate_words(state);
        let zipf: Vec<f64> = words.iter().map(|&w| ctx.list.zipf_of(w) as f64).collect();
        // f^β = 10^(β·zipf). Dividing every weight by the largest,
        // 10^(β·max zipf), keeps them in (0, 1] so large β cannot overflow;
        // at β = 0 every weight is exactly 1.
        let max = zipf.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let weights: Vec<f64> = zipf.iter().map(|&z| math::pow(10.0, self.beta * (z - max))).collect();
        Dist::from_weights(&words, &weights, 0)
    }

    fn state_key(&self, state: &State) -> StateKey {
        StateKey::candidates(state)
    }

    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)> {
        let d = self.distribution(ctx, state);
        rank_scores(ctx, state, d.entries.iter().map(|e| (e.word, e.p)).collect(), top_k)
    }

    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "freq_proportional",
            label: "Frequency-proportional",
            description: "Guesses a remaining candidate at random with probability proportional to its frequency raised to the power β. β = 0 is uniform; large β approaches the most frequent word.",
            determinism: "stochastic",
            needs: Resources { frequencies: true },
            params: vec![ParamField {
                name: "beta",
                label: "β",
                help: "Sharpness: 0 is uniform over candidates, 1 follows word frequency, higher favours common words more.",
                ty: ParamType::Number { min: 0.0, max: 20.0, step: 0.1 },
                default: serde_json::json!(1.0),
            }],
        }
    }

    fn resources(&self) -> Resources {
        Resources { frequencies: true }
    }
}
