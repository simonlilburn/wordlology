use wl_core::{hard_mode_ok, WordId};

use crate::schema::{ParamField, ParamSchema, ParamType};
use crate::spec::{Pool, StrategySpec, SwitchRule};
use crate::{Ctx, Dist, Resources, State, StateKey, Strategy};

/// Deterministic: plays a listed sequence in order.
///
/// The sequence is indexed by turn: guess number `t + 1` (after `t` guesses,
/// the opener included) plays `words[t]`. So with an opener set, the opener
/// takes the place of the first listed word and the sequence continues from
/// the second, just as any strategy continues after an opener.
///
/// - **Solve when one**: with `solve_when_one`, a single remaining candidate
///   is guessed at once.
/// - **Skipping**: a listed word already played, or invalid in hard mode, is
///   skipped, and the next listed word is played in its place (the sequence
///   then continues after it, never replaying a word).
/// - **Exhausted**: once no listed word is left to play, the strategy plays
///   the first candidate (the lowest word id); inside a `Switch` with the
///   `sequence_exhausted` rule, the next strategy takes over instead.
pub struct FixedSequence {
    id: &'static str,
    words: Vec<WordId>,
    solve_when_one: bool,
}

impl FixedSequence {
    /// `id` is the phase label: `fixed_sequence` on its own, `sequence` inside `sequence_then`.
    pub fn new(id: &'static str, words: Vec<WordId>, solve_when_one: bool) -> FixedSequence {
        FixedSequence { id, words, solve_when_one }
    }

    /// The next listed word to play at this state, if any is left.
    fn next_listed(&self, ctx: &Ctx, state: &State) -> Option<WordId> {
        self.words.iter().skip(state.turn as usize).copied().find(|&w| {
            !state.history.iter().any(|&(g, _)| g == w)
                && (!ctx.rules.hard_mode || hard_mode_ok(ctx.list, w, &state.history))
        })
    }

    fn choice(&self, ctx: &Ctx, state: &State) -> WordId {
        if self.solve_when_one && state.candidates.len() == 1 {
            return ctx.first_candidate(state);
        }
        self.next_listed(ctx, state).unwrap_or_else(|| ctx.first_candidate(state))
    }
}

impl Strategy for FixedSequence {
    fn id(&self) -> &str {
        self.id
    }

    fn is_deterministic(&self) -> bool {
        true
    }

    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist {
        Dist::single(self.choice(ctx, state), 0)
    }

    /// The choice depends on the turn (the position in the sequence), the
    /// words played and hard mode (the history), and C (solving, fallback).
    fn state_key(&self, state: &State) -> StateKey {
        StateKey::history(state)
    }

    fn scores(&self, ctx: &Ctx, state: &State, _top_k: usize) -> Vec<(WordId, f64)> {
        vec![(self.choice(ctx, state), 1.0)]
    }

    fn schema() -> ParamSchema {
        ParamSchema {
            kind: "fixed_sequence",
            label: "Fixed sequence",
            description: "Plays a listed sequence of words in order, one per guess (an opener replaces the first). Afterwards, or when one candidate is left, it guesses a candidate.",
            determinism: "deterministic",
            needs: Resources::default(),
            params: vec![
                ParamField {
                    name: "words",
                    label: "Words",
                    help: "Allowed guesses, played in order. Words already played or invalid in hard mode are skipped.",
                    ty: ParamType::Words { min: 1, max: 10 },
                    default: serde_json::json!(["slate", "crony", "build"]),
                },
                ParamField {
                    name: "solve_when_one",
                    label: "Solve when one is left",
                    help: "Guess the last remaining candidate instead of continuing the sequence.",
                    ty: ParamType::Boolean,
                    default: serde_json::json!(true),
                },
            ],
        }
    }

    fn exhausted(&self, ctx: &Ctx, state: &State) -> bool {
        self.next_listed(ctx, state).is_none()
    }
}

/// Schema of `sequence_then`: a fixed sequence (solving when one candidate
/// is left), then a switch to another strategy.
pub fn sequence_then_schema() -> ParamSchema {
    ParamSchema {
        kind: "sequence_then",
        label: "Sequence, then…",
        description: "Plays a fixed sequence of words, then switches to another strategy by a rule, by default when the sequence runs out.",
        determinism: "hybrid",
        needs: Resources::default(),
        params: vec![
            ParamField {
                name: "words",
                label: "Words",
                help: "Allowed guesses, played in order (an opener replaces the first).",
                ty: ParamType::Words { min: 1, max: 10 },
                default: serde_json::json!(["saint", "older"]),
            },
            ParamField {
                name: "switch",
                label: "Switch when",
                help: "When to hand over to the next strategy.",
                ty: ParamType::SwitchRule,
                default: serde_json::to_value(SwitchRule::SequenceExhausted).unwrap(),
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
