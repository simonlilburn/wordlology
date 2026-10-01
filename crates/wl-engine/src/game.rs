//! Games and turns, and playing one game against one target.
//!
//! See docs/architecture.md, "Playing a game".

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wl_core::{expected_info, AnswerIdx, WordId, WordList};
use wl_strategy::{Choice, Ctx, Dist, State};

use crate::cache::{DistCache, Stored};
use crate::{Engine, EngineError, Prepared};

/// `Turn::phase` of an opener set by the configuration.
pub const PHASE_OPENER: u8 = 255;
/// `Turn::phase` of a guess the player made (the strategy did not choose it).
pub const PHASE_PLAYER: u8 = 254;

/// One guess of a game. Probabilities and bits are f32, exactly as the
/// binary batches carry them, so every consumer sees identical values.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// Guess word id.
    pub guess: WordId,
    /// Feedback code (sum of `c_i · 3^i`).
    pub pattern: u16,
    pub cands_before: u16,
    pub cands_after: u16,
    /// Total probability the strategy gave this word (1 for openers).
    pub p_chosen: f32,
    /// Entropy of the guess's partition of the candidates before it, in bits.
    pub bits_expected: f32,
    /// Index into the strategy's phase labels; [`PHASE_OPENER`], [`PHASE_PLAYER`].
    pub phase: u8,
    /// Whether the guess was still a candidate answer.
    pub is_candidate: bool,
}

/// One game: every guess against one target.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    /// Answer index of the target.
    pub target: AnswerIdx,
    /// Replicate index; for player games, the player game number.
    pub replicate: u32,
    pub turns: Vec<Turn>,
    pub solved: bool,
    /// Player games carry no mass in trees and cards (not part of batches).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_player: bool,
}

impl Game {
    /// Guesses made; a failure counts max guesses.
    pub fn n_guesses(&self) -> usize {
        self.turns.len()
    }

    /// Row of the outcome: `k − 1` for solved in k, `max_guesses` for X.
    pub fn outcome_index(&self, max_guesses: u8) -> usize {
        if self.solved {
            (self.turns.len().max(1) - 1).min(max_guesses as usize - 1)
        } else {
            max_guesses as usize
        }
    }

    /// `"1"`…`"max"` or `"X"`.
    pub fn outcome_label(&self) -> String {
        if self.solved {
            self.turns.len().to_string()
        } else {
            "X".to_string()
        }
    }

    /// Guess words joined by `">"`.
    pub fn path(&self, list: &WordList) -> String {
        self.turns.iter().map(|t| list.word(t.guess)).collect::<Vec<_>>().join(">")
    }
}

impl Prepared {
    /// The game context for this configuration.
    pub fn ctx<'a>(&self, engine: &'a Engine) -> Ctx<'a> {
        Ctx::new(&engine.list, &engine.matrix, self.config.rules)
    }

    /// The random stream of (target, replicate).
    pub fn rng(&self, engine: &Engine, target: AnswerIdx, replicate: u32) -> rand_chacha::ChaCha8Rng {
        let word = engine.list.word(engine.list.answer_word(target));
        crate::seed::game_rng(
            self.config.base_seed,
            &self.strategy_json,
            self.config.opener.as_deref(),
            word,
            replicate,
        )
    }

    /// The seeded target order of stochastic runs: a permutation of every answer.
    pub fn target_order(&self, n_answers: usize) -> Vec<AnswerIdx> {
        let seed = crate::seed::order_seed(self.config.base_seed, &self.strategy_json, self.config.opener.as_deref());
        crate::seed::permutation(n_answers, seed)
    }

    /// The strategy's distribution for a state, through the cache if given.
    pub fn distribution(&self, ctx: &Ctx, state: &State, cache: Option<&mut DistCache>) -> Arc<Dist> {
        match cache {
            Some(c) => c.get_or_insert_with(self.strategy.state_key(state), || self.strategy.distribution(ctx, state)),
            None => Arc::new(self.strategy.distribution(ctx, state)),
        }
    }

    /// [`Prepared::distribution`] in the form the cache holds.
    fn stored_distribution(&self, ctx: &Ctx, state: &State, cache: Option<&mut DistCache>) -> Arc<Stored> {
        match cache {
            Some(c) => c.get_stored(self.strategy.state_key(state), || self.strategy.distribution(ctx, state)),
            None => Arc::new(Stored::from_dist(&self.strategy.distribution(ctx, state))),
        }
    }

    /// Play replicate `replicate` against `target`.
    pub fn play(&self, engine: &Engine, target: AnswerIdx, replicate: u32, cache: Option<&mut DistCache>) -> Game {
        self.play_from(engine, target, replicate, &[], None, cache)
    }

    /// Continue a game from a prefix of guesses with the stream of
    /// (target, replicate): the rest of the game, or one more guess.
    ///
    /// Every prefix turn is recomputed as if the strategy were playing: its
    /// distribution is computed and sampled, drawing from the stream exactly
    /// as a strategy turn would (one `next_u64` unless the distribution has a
    /// single entry; an opener turn draws nothing). If the draw matches the
    /// prefix guess, the turn keeps the strategy's probability and phase;
    /// otherwise the turn is the player's: phase [`PHASE_PLAYER`] and
    /// `p_chosen` the probability the strategy gave that guess (0 for a guess
    /// other than the configured opener). So a prefix of the strategy's own
    /// game continues exactly as that game, and after a deviation the stream
    /// is still aligned turn by turn.
    pub fn continue_game(
        &self,
        engine: &Engine,
        prefix: &[WordId],
        target: AnswerIdx,
        replicate: u32,
        one_step: bool,
    ) -> Result<Game, EngineError> {
        let list = &engine.list;
        if target as usize >= list.n_answers() {
            return Err(EngineError::Scope(format!("target {target} is not an answer index")));
        }
        if prefix.len() > self.config.rules.max_guesses as usize {
            return Err(EngineError::Scope("the prefix is longer than max guesses".into()));
        }
        let target_word = list.answer_word(target);
        for (i, &g) in prefix.iter().enumerate() {
            if g as usize >= list.n_guesses() {
                return Err(EngineError::Scope(format!("guess id {g} is not in the guess list")));
            }
            if g == target_word && i + 1 < prefix.len() {
                return Err(EngineError::Scope("the prefix continues after finding the target".into()));
            }
        }
        Ok(self.play_from(engine, target, replicate, prefix, one_step.then_some(1), None))
    }

    /// Play with an optional forced prefix; `extra` limits strategy turns after it.
    fn play_from(
        &self,
        engine: &Engine,
        target: AnswerIdx,
        replicate: u32,
        prefix: &[WordId],
        extra: Option<usize>,
        mut cache: Option<&mut DistCache>,
    ) -> Game {
        let ctx = self.ctx(engine);
        let max = self.config.rules.max_guesses as usize;
        let limit = extra.map_or(max, |e| (prefix.len() + e).min(max));
        let len = engine.list.word_len();
        let mut rng = self.rng(engine, target, replicate);
        let mut scratch = ctx.scratch();
        let mut state = State::initial(&engine.list);
        let mut turns = Vec::with_capacity(max);
        let mut solved = false;
        while turns.len() < limit {
            let (choice, dist) = match self.opener {
                Some(o) if state.turn == 0 => (Choice { word: o, p: 1.0, phase: PHASE_OPENER }, None),
                _ => {
                    let d = self.stored_distribution(&ctx, &state, cache.as_deref_mut());
                    (d.sample(&mut rng), Some(d))
                }
            };
            let (word, p, phase) = match prefix.get(turns.len()) {
                Some(&g) if g != choice.word => (g, dist.map_or(0.0, |d| d.prob_of(g)), PHASE_PLAYER),
                _ => (choice.word, choice.p, choice.phase),
            };
            let pattern = engine.matrix.get(word, target);
            let bits = expected_info(&engine.matrix, word, &state.candidates, &mut scratch);
            turns.push(Turn {
                guess: word,
                pattern: pattern.0,
                cands_before: state.candidates.len() as u16,
                cands_after: scratch[pattern.0 as usize] as u16,
                p_chosen: p as f32,
                bits_expected: bits as f32,
                phase,
                is_candidate: ctx.is_candidate(&state, word),
            });
            if pattern.is_all_correct(len) {
                solved = true;
                break;
            }
            if turns.len() < limit {
                state = state.apply(&ctx, word, pattern);
            }
        }
        Game { target, replicate, turns, solved, is_player: false }
    }
}
