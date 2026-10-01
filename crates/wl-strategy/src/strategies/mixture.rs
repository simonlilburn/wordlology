use std::collections::HashMap;

use wl_core::WordId;

use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::{Pool, StrategySpec};
use crate::{rank_scores, Ctx, Dist, Resources, State, StateKey, Strategy};

/// Combinator: at each turn, pick component i with probability `weights[i]`
/// (normalised) and play its choice. For example ε-greedy: 0.9 `max_info`,
/// 0.1 `random`.
///
/// The distribution lists every component's entries scaled by its weight,
/// each with that component's phase (offset into the flattened phase list),
/// so one word can appear under several phases; its `p_chosen` is its total
/// probability. Components with zero weight are never consulted. The
/// mixture is deterministic only when a single deterministic component has
/// all the weight.
pub struct Mixture {
    weights: Vec<f64>,
    parts: Vec<Box<dyn Strategy>>,
    offsets: Vec<u8>,
}

impl Mixture {
    /// `weights` must be non-negative with a positive sum (checked by the builder).
    pub fn new(weights: &[f64], parts: Vec<Box<dyn Strategy>>) -> Mixture {
        assert_eq!(weights.len(), parts.len());
        let total: f64 = weights.iter().sum();
        let mut offsets = Vec::with_capacity(parts.len());
        let mut n = 0usize;
        for p in &parts {
            offsets.push(u8::try_from(n).expect("too many phases"));
            n += p.phases().len();
        }
        Mixture { weights: weights.iter().map(|w| w / total).collect(), parts, offsets }
    }

    fn active(&self) -> impl Iterator<Item = (usize, f64, &dyn Strategy)> {
        self.weights.iter().zip(&self.parts).enumerate().filter(|(_, (&w, _))| w > 0.0).map(|(i, (&w, p))| (i, w, &**p))
    }
}

impl Strategy for Mixture {
    fn id(&self) -> &str {
        "mixture"
    }

    fn is_deterministic(&self) -> bool {
        let mut active = self.active();
        matches!((active.next(), active.next()), (Some((_, _, p)), None) if p.is_deterministic())
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        let mut entries = Vec::new();
        for (i, w, part) in self.active() {
            entries.extend(part.distribution(ctx, state).scaled(w, self.offsets[i]).entries);
        }
        Dist { entries }
    }

    fn state_key(&self, state: &State) -> StateKey {
        self.active().fold(StateKey(0, 0), |k, (i, _, part)| k.combine(part.state_key(state).mix(i as u64 + 1))).mix(4)
    }

    /// Words ranked by their total probability.
    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)> {
        let mut total: HashMap<WordId, f64> = HashMap::new();
        for e in self.distribution(ctx, state).entries {
            *total.entry(e.word).or_default() += e.p;
        }
        rank_scores(ctx, state, total.into_iter().collect(), top_k)
    }

    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "mixture",
            label: "Mixture",
            description: "At each guess, picks one of several strategies at random in proportion to its weight and plays its choice. For example ε-greedy: 0.9 maximum information, 0.1 random.",
            determinism: "stochastic",
            needs: Resources::default(),
            params: vec![
                ParamField {
                    name: "weights",
                    label: "Weights",
                    help: "One non-negative weight per strategy; they are normalised to sum to 1.",
                    ty: ParamType::Weights,
                    default: serde_json::json!([0.9, 0.1]),
                },
                ParamField {
                    name: "strategies",
                    label: "Strategies",
                    help: "The strategies to mix, in the same order as the weights.",
                    ty: ParamType::Strategies,
                    default: serde_json::to_value([
                        StrategySpec::MaxInfo { pool: Pool::Candidates },
                        StrategySpec::Random { pool: Pool::Candidates },
                    ])
                    .unwrap(),
                },
            ],
        }
    }

    fn phases(&self) -> Vec<String> {
        self.parts.iter().flat_map(|p| p.phases()).collect()
    }

    fn resources(&self) -> Resources {
        self.parts.iter().fold(Resources::default(), |r, p| r.union(p.resources()))
    }

    fn exhausted(&self, ctx: &Ctx, state: &State) -> bool {
        self.active().all(|(_, _, p)| p.exhausted(ctx, state))
    }
}
