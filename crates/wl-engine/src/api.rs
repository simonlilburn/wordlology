//! Requests shared by the WASM API and the CLI: states from a history, hint
//! scores, one-step opener information and history parsing.
//!
//! Keeping them here means `wl-wasm` is a thin binding layer and native
//! tests cover the same code the browser runs.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use wl_core::{Pattern, WordId};
use wl_strategy::info::InfoScorer;
use wl_strategy::State;

use crate::game::PHASE_OPENER;
use crate::{Engine, EngineError, Prepared};

/// One ranked alternative (`ScoresResult.entries` in web/src/backend/types.ts).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ScoreEntry {
    pub word: WordId,
    /// The strategy's score: expected information for deterministic
    /// strategies, the probability for stochastic ones.
    pub score: f64,
    /// Total probability the strategy gives the word.
    pub p: f64,
}

/// Ranked alternatives for a state, for hint chips and annotations.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ScoresResult {
    /// The strategy's own choice (deterministic) or most likely word
    /// (stochastic) first, then the other alternatives.
    pub entries: Vec<ScoreEntry>,
    pub deterministic: bool,
    /// Phase label of the first entry.
    pub phase: String,
    /// Candidates left in the state.
    pub candidates: usize,
}

impl Prepared {
    /// The state after a history of guesses with their feedback.
    ///
    /// Fails on unknown word ids or pattern codes, on a history longer than
    /// max guesses or continuing after a solve, and on feedback that no
    /// answer is consistent with.
    pub fn state_after(&self, engine: &Engine, history: &[(WordId, Pattern)]) -> Result<State, EngineError> {
        let ctx = self.ctx(engine);
        let len = engine.list.word_len();
        if history.len() >= self.config.rules.max_guesses as usize {
            return Err(EngineError::Scope("the game is already over (max guesses reached)".into()));
        }
        let mut state = State::initial(&engine.list);
        for (i, &(g, p)) in history.iter().enumerate() {
            if g as usize >= engine.list.n_guesses() {
                return Err(EngineError::Scope(format!("guess id {g} is not in the guess list")));
            }
            if p.0 as usize >= engine.matrix.n_patterns() {
                return Err(EngineError::Scope(format!("pattern {} is not a feedback code", p.0)));
            }
            if p.is_all_correct(len) {
                return Err(EngineError::Scope(format!("the game was solved at guess {}", i + 1)));
            }
            state = state.apply(&ctx, g, p);
            if state.candidates.is_empty() {
                return Err(EngineError::Scope("no answer is consistent with this feedback".into()));
            }
        }
        Ok(state)
    }

    /// Hint scores after `history`: at most `top_k` entries (at least one).
    ///
    /// With an opener and an empty history, the only entry is the opener
    /// (phase `"opener"`, p = 1), since that is what the configuration plays.
    pub fn scores(&self, engine: &Engine, history: &[(WordId, Pattern)], top_k: usize) -> Result<ScoresResult, EngineError> {
        let state = self.state_after(engine, history)?;
        let top_k = top_k.max(1);
        let candidates = state.candidates.len();
        if let (Some(o), true) = (self.opener, history.is_empty()) {
            return Ok(ScoresResult {
                entries: vec![ScoreEntry { word: o, score: 1.0, p: 1.0 }],
                deterministic: self.deterministic,
                phase: self.phase_label(PHASE_OPENER),
                candidates,
            });
        }
        let ctx = self.ctx(engine);
        let dist = self.strategy.distribution(&ctx, &state);
        let choice = dist.mode();
        let entries = if self.deterministic {
            // The strategy's ranking, with its actual choice first (combinators
            // may rank differently from what they play).
            let mut entries = vec![ScoreEntry {
                word: choice.word,
                score: f64::NAN,
                p: choice.p,
            }];
            for (w, s) in self.strategy.scores(&ctx, &state, top_k + 1) {
                if w == choice.word {
                    entries[0].score = s;
                } else if entries.len() < top_k {
                    entries.push(ScoreEntry { word: w, score: s, p: dist.prob_of(w) });
                }
            }
            if entries[0].score.is_nan() {
                entries[0].score = expected_bits(engine, choice.word, &state);
            }
            entries
        } else {
            // Total probability per word (mixtures list a word once per part).
            let mut total: HashMap<WordId, f64> = HashMap::with_capacity(dist.entries.len());
            let mut order = Vec::with_capacity(dist.entries.len());
            for e in &dist.entries {
                *total.entry(e.word).or_insert_with(|| {
                    order.push(e.word);
                    0.0
                }) += e.p;
            }
            let mut ranked: Vec<(WordId, f64)> = order.into_iter().map(|w| (w, total[&w])).collect();
            ranked.sort_by(|a, b| {
                b.1.total_cmp(&a.1)
                    .then_with(|| ctx.is_candidate(&state, b.0).cmp(&ctx.is_candidate(&state, a.0)))
                    .then_with(|| a.0.cmp(&b.0))
            });
            ranked.truncate(top_k);
            ranked.into_iter().map(|(word, p)| ScoreEntry { word, score: p, p }).collect()
        };
        let first = entries[0].word;
        let phase = dist.entries.iter().find(|e| e.word == first).map_or(choice.phase, |e| e.phase);
        Ok(ScoresResult { entries, deterministic: self.deterministic, phase: self.phase_label(phase), candidates })
    }
}

fn expected_bits(engine: &Engine, guess: WordId, state: &State) -> f64 {
    let mut scratch = vec![0; engine.matrix.n_patterns()];
    wl_core::expected_info(&engine.matrix, guess, &state.candidates, &mut scratch)
}

/// One-step expected information (bits) of every allowed guess, by word id,
/// from the initial state (every answer a candidate).
pub fn opener_info(engine: &Engine) -> Vec<f64> {
    let state = State::initial(&engine.list);
    let mut scorer = InfoScorer::new(&engine.matrix, &state.candidates);
    (0..engine.list.n_guesses()).map(|g| scorer.score(&engine.matrix, g as WordId)).collect()
}

/// A guess in a history: a word id or a word (case-insensitive).
fn guess_of(engine: &Engine, v: &Value) -> Result<WordId, EngineError> {
    match v {
        Value::Number(n) => n
            .as_u64()
            .filter(|&g| (g as usize) < engine.list.n_guesses())
            .map(|g| g as WordId)
            .ok_or_else(|| EngineError::Scope(format!("guess {n} is not a word id"))),
        Value::String(w) => engine.list.id(w).ok_or_else(|| EngineError::Scope(format!("{w:?} is not an allowed guess"))),
        other => Err(EngineError::Scope(format!("bad guess {other}"))),
    }
}

/// A pattern in a history: a feedback code or a `g`/`y`/`b` spelling.
fn pattern_of(engine: &Engine, v: &Value) -> Result<Pattern, EngineError> {
    let len = engine.list.word_len();
    match v {
        Value::Number(n) => n
            .as_u64()
            .filter(|&p| (p as usize) < engine.matrix.n_patterns())
            .map(|p| Pattern(p as u16))
            .ok_or_else(|| EngineError::Scope(format!("pattern {n} is not a feedback code"))),
        Value::String(s) if s.len() == len => {
            Pattern::from_letters(s).ok_or_else(|| EngineError::Scope(format!("bad feedback {s:?}")))
        }
        other => Err(EngineError::Scope(format!("bad feedback {other}"))),
    }
}

/// Parse a history of guesses with feedback: `[{"guess": id, "pattern": code}, …]`
/// (the web's form), or `[[guess, pattern], …]`. Guesses may be word ids or
/// words, patterns codes or `g`/`y`/`b` spellings.
pub fn parse_history(engine: &Engine, json: &str) -> Result<Vec<(WordId, Pattern)>, EngineError> {
    let v: Value = serde_json::from_str(json).map_err(|e| EngineError::Scope(format!("bad history: {e}")))?;
    let items = v.as_array().ok_or_else(|| EngineError::Scope("the history must be an array".into()))?;
    items
        .iter()
        .map(|item| match item {
            Value::Object(m) => {
                let g = m.get("guess").ok_or_else(|| EngineError::Scope("a history entry needs a guess".into()))?;
                let p = m.get("pattern").ok_or_else(|| EngineError::Scope("a history entry needs a pattern".into()))?;
                Ok((guess_of(engine, g)?, pattern_of(engine, p)?))
            }
            Value::Array(pair) if pair.len() == 2 => Ok((guess_of(engine, &pair[0])?, pattern_of(engine, &pair[1])?)),
            other => Err(EngineError::Scope(format!("bad history entry {other}"))),
        })
        .collect()
}

/// Parse a prefix of guesses: `[id, …]` (the web's form), words, or
/// `[{"guess": …}, …]` (patterns, if present, are ignored: they follow from
/// the target).
pub fn parse_guesses(engine: &Engine, json: &str) -> Result<Vec<WordId>, EngineError> {
    let v: Value = serde_json::from_str(json).map_err(|e| EngineError::Scope(format!("bad history: {e}")))?;
    let items = v.as_array().ok_or_else(|| EngineError::Scope("the history must be an array".into()))?;
    items
        .iter()
        .map(|item| match item {
            Value::Object(m) => {
                guess_of(engine, m.get("guess").ok_or_else(|| EngineError::Scope("a history entry needs a guess".into()))?)
            }
            v => guess_of(engine, v),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Config;
    use wl_core::{Manifest, WordList};
    use wl_strategy::{Pool, StrategySpec};

    fn engine() -> Engine {
        let words = ["abide", "crane", "erase", "slate", "speed", "steal", "those", "trace", "eerie", "geese"];
        let answers = ["abide", "crane", "erase", "steal", "those", "eerie"];
        Engine::new(WordList::from_words(Manifest::adhoc("t", 5), &words, &answers).unwrap())
    }

    #[test]
    fn history_forms() {
        let e = engine();
        let a = parse_history(&e, r#"[{"guess":3,"pattern":17}]"#).unwrap();
        let b = parse_history(&e, r#"[["slate","ybbyb"]]"#).unwrap();
        assert_eq!(a, vec![(3, Pattern(17))]);
        assert_eq!(b, vec![(3, Pattern::from_letters("ybbyb").unwrap())]);
        assert!(parse_history(&e, r#"[{"guess":99,"pattern":0}]"#).is_err());
        assert!(parse_history(&e, r#"[{"guess":1,"pattern":243}]"#).is_err());
        assert_eq!(parse_guesses(&e, r#"[1,"slate",{"guess":2,"pattern":5}]"#).unwrap(), vec![1, 3, 2]);
    }

    #[test]
    fn scores_put_the_choice_first() {
        let e = engine();
        let mut c = Config::new(&e.list, StrategySpec::MaxInfo { pool: Pool::Allowed });
        let prep = e.prepare(&c).unwrap();
        let s = prep.scores(&e, &[], 3).unwrap();
        let choice = prep.play(&e, 0, 0, None).turns[0].guess;
        assert_eq!(s.entries[0].word, choice);
        assert_eq!((s.entries[0].p, s.phase.as_str(), s.candidates, s.deterministic), (1.0, "max_info", 6, true));
        assert!(s.entries.len() == 3 && s.entries[1].p == 0.0 && s.entries[1].score <= s.entries[0].score);
        // Opener first.
        c.opener = Some("speed".into());
        let prep = e.prepare(&c).unwrap();
        let s = prep.scores(&e, &[], 3).unwrap();
        assert_eq!((s.entries.len(), s.entries[0].word, s.phase.as_str()), (1, 4, "opener"));
        // Stochastic: probabilities, most likely first, summing to 1 over the whole distribution.
        let c = Config::new(&e.list, StrategySpec::InfoProportional { beta: 1.0, pool: Pool::Candidates });
        let prep = e.prepare(&c).unwrap();
        let s = prep.scores(&e, &[], 100).unwrap();
        assert_eq!(s.entries.len(), 6);
        assert!((s.entries.iter().map(|x| x.p).sum::<f64>() - 1.0).abs() < 1e-12);
        assert!(s.entries.windows(2).all(|w| w[0].p >= w[1].p));
        // Inconsistent feedback and solved states are rejected.
        assert!(prep.scores(&e, &[(3, Pattern(0)), (3, Pattern(1))], 3).is_err());
        assert!(prep.scores(&e, &[(1, Pattern::all_correct(5))], 3).is_err());
    }

    #[test]
    fn opener_info_matches_expected_info() {
        let e = engine();
        let info = opener_info(&e);
        let all = wl_core::CandidateSet::full(e.list.n_answers());
        let mut scratch = vec![0; 243];
        for (g, &x) in info.iter().enumerate() {
            assert_eq!(x, wl_core::expected_info(&e.matrix, g as WordId, &all, &mut scratch));
        }
    }
}
