use wl_core::{remaining_bits, WordId};

use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::{Pool, StrategySpec, SwitchRule};
use crate::{Ctx, Dist, Resources, State, StateKey, Strategy};

/// Combinator: play `first` until the rule `when` holds, then `then`.
///
/// Every rule is monotone over a game (turns only grow, C only shrinks, a
/// sequence never refills), so the switch is evaluated afresh at each state
/// and never switches back. Phases are `first`'s followed by `then`'s.
/// `coverage_then` and `sequence_then` are built as switches.
pub struct Switch {
    id: &'static str,
    first: Box<dyn Strategy>,
    then: Box<dyn Strategy>,
    when: SwitchRule,
    /// Phase offset of `then`: the number of `first`'s phases.
    offset: u8,
}

impl Switch {
    /// `id` names the hybrid: `switch`, `coverage_then` or `sequence_then`.
    pub fn new(id: &'static str, first: Box<dyn Strategy>, then: Box<dyn Strategy>, when: SwitchRule) -> Switch {
        let offset = u8::try_from(first.phases().len()).expect("too many phases");
        Switch { id, first, then, when, offset }
    }

    /// Whether `then` plays at this state.
    pub fn switched(&self, ctx: &Ctx, state: &State) -> bool {
        self.switched_by_state(state).unwrap_or_else(|| self.first.exhausted(ctx, state))
    }

    /// The rule's verdict when the state alone decides it (all rules but
    /// `sequence_exhausted`, which asks `first` and may depend on hard mode).
    fn switched_by_state(&self, state: &State) -> Option<bool> {
        match self.when {
            SwitchRule::AfterTurns { k } => Some(state.turn >= k),
            SwitchRule::CandidatesLe { n } => Some(state.candidates.len() as u64 <= n as u64),
            SwitchRule::BitsLe { h } => Some(remaining_bits(state.candidates.len()) <= h),
            SwitchRule::SequenceExhausted => None,
        }
    }
}

impl Strategy for Switch {
    fn id(&self) -> &str {
        self.id
    }

    fn is_deterministic(&self) -> bool {
        self.first.is_deterministic() && self.then.is_deterministic()
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        if self.switched(ctx, state) {
            self.then.distribution(ctx, state).scaled(1.0, self.offset)
        } else {
            self.first.distribution(ctx, state)
        }
    }

    /// The active part's key, tagged with the side. When the rule needs the
    /// context (`sequence_exhausted`), both parts' keys: `first`'s decides
    /// whether it is exhausted, and each side's decides its distribution.
    fn state_key(&self, state: &State) -> StateKey {
        match self.switched_by_state(state) {
            Some(false) => self.first.state_key(state).mix(1),
            Some(true) => self.then.state_key(state).mix(2),
            None => self.first.state_key(state).combine(self.then.state_key(state)).mix(3),
        }
    }

    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)> {
        if self.switched(ctx, state) {
            self.then.scores(ctx, state, top_k)
        } else {
            self.first.scores(ctx, state, top_k)
        }
    }

    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "switch",
            label: "Switch",
            description: "Plays one strategy until a rule holds (after k guesses, few candidates left, few bits left, or its sequence runs out), then another.",
            determinism: "hybrid",
            needs: Resources::default(),
            params: vec![
                ParamField {
                    name: "first",
                    label: "First",
                    help: "The strategy that plays until the switch.",
                    ty: ParamType::Strategy,
                    default: serde_json::to_value(StrategySpec::MaxInfo { pool: Pool::Allowed }).unwrap(),
                },
                ParamField {
                    name: "then",
                    label: "Then",
                    help: "The strategy that plays after the switch.",
                    ty: ParamType::Strategy,
                    default: serde_json::to_value(StrategySpec::MaxInfo { pool: Pool::Candidates }).unwrap(),
                },
                ParamField {
                    name: "when",
                    label: "Switch when",
                    help: "After k guesses, once at most n candidates or h bits remain, or when the first strategy's sequence runs out.",
                    ty: ParamType::SwitchRule,
                    default: serde_json::to_value(SwitchRule::CandidatesLe { n: 10 }).unwrap(),
                },
            ],
        }
    }

    fn phases(&self) -> Vec<String> {
        let mut p = self.first.phases();
        p.extend(self.then.phases());
        p
    }

    fn resources(&self) -> Resources {
        self.first.resources().union(self.then.resources())
    }

    fn exhausted(&self, ctx: &Ctx, state: &State) -> bool {
        self.switched(ctx, state) && self.then.exhausted(ctx, state)
    }
}
