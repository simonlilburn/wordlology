//! wl-engine: playing games, building target tries, aggregating cards and
//! pairs, producing export rows and binary game batches.
//!
//! The contracts are in docs/architecture.md. The entry points:
//!
//! - [`Engine`]: a word list with its pattern matrix.
//! - [`Engine::prepare`]: validate and canonicalise a [`Config`] into a
//!   [`Prepared`] configuration (config ID, built strategy, opener).
//! - [`Prepared::play`] / [`Prepared::continue_game`]: single games.
//! - [`Run`]: every game of a (configuration, [`Scope`]) in bounded steps.
//! - [`card::CardAccumulator`], [`trie::TargetTrie`], [`card::pair_rows`]:
//!   aggregates; [`export`]: CSV; [`batch`]: the binary batch format.

use std::sync::OnceLock;

use wl_core::{PatternMatrix, WordId, WordList, WordListError};
use wl_strategy::spec::BuildError;
use wl_strategy::Strategy;

pub mod batch;
pub mod cache;
pub mod card;
pub mod config;
pub mod export;
pub mod game;
pub mod run;
pub mod seed;
pub mod trie;

pub use card::{Card, CardAccumulator, PairRow};
pub use config::{config_id, AnswerSelection, Config, Weighting, WordListRef};
pub use game::{Game, Turn, PHASE_OPENER, PHASE_PLAYER};
pub use run::{Progress, Run, Scope, Summary, Targets};

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("{0}")]
    Config(String),
    #[error("{0}")]
    Scope(String),
    #[error("strategy: {0}")]
    Build(#[from] BuildError),
    #[error("word list: {0}")]
    WordList(#[from] WordListError),
    #[error("{0}")]
    Batch(String),
}

/// A word list with its pattern matrix: everything games are played on.
pub struct Engine {
    pub list: WordList,
    pub matrix: PatternMatrix,
    answers_sha256: OnceLock<String>,
}

impl Engine {
    /// Build the pattern matrix for a list.
    pub fn new(list: WordList) -> Engine {
        let matrix = PatternMatrix::build(&list);
        Engine::with_matrix(list, matrix)
    }

    /// Use an already built matrix (it must belong to `list`).
    pub fn with_matrix(list: WordList, matrix: PatternMatrix) -> Engine {
        assert_eq!((matrix.n_guesses(), matrix.n_answers()), (list.n_guesses(), list.n_answers()));
        Engine { list, matrix, answers_sha256: OnceLock::new() }
    }

    /// SHA-256 of this engine's answers (the `sha256` a pasted selection of them carries).
    pub fn answers_sha256(&self) -> &str {
        self.answers_sha256.get_or_init(|| {
            let words: Vec<&str> = self.list.answers().iter().map(|&id| self.list.word(id)).collect();
            config::answers_sha256(&words)
        })
    }

    /// Validate and canonicalise a configuration for this word list.
    ///
    /// The engine's answers are taken to be the configuration's answer
    /// selection (a solver is built per selection); only a pasted selection's
    /// hash can be, and is, checked.
    pub fn prepare(&self, config: &Config) -> Result<Prepared, EngineError> {
        let m = &self.list.manifest;
        if config.word_list.id != m.id || config.word_list.version != m.version {
            return Err(EngineError::Config(format!(
                "the configuration is for word list {} {}, but this solver has {} {}",
                config.word_list.id, config.word_list.version, m.id, m.version
            )));
        }
        let strategy = config.strategy.build(&self.list)?;
        let deterministic = strategy.is_deterministic();
        let config = config.canonicalized(deterministic)?;
        if let AnswerSelection::Pasted { sha256, .. } = &config.word_list.answers {
            if sha256 != self.answers_sha256() {
                return Err(EngineError::Config("this solver was not built for the pasted answer list".into()));
            }
        }
        if config.weighting == Weighting::Frequency && self.list.zipf().is_none() {
            return Err(EngineError::Config("frequency weighting needs a word list with frequencies".into()));
        }
        let opener = match &config.opener {
            Some(w) => Some(
                self.list.id(w).ok_or_else(|| EngineError::Config(format!("opener {w:?} is not an allowed guess")))?,
            ),
            None => None,
        };
        let canonical_json = config.to_canonical_json();
        let config_id = config::config_id(&canonical_json);
        let strategy_json = config::strategy_canonical_json(&config.strategy);
        let phases = strategy.phases();
        Ok(Prepared { config, canonical_json, config_id, strategy, strategy_json, opener, deterministic, phases })
    }

    /// Parse and prepare a configuration from JSON.
    pub fn prepare_json(&self, json: &str) -> Result<Prepared, EngineError> {
        self.prepare(&Config::from_json(json)?)
    }

    /// Weight of every answer for cards (see [`card::target_weights`]).
    pub fn target_weights(&self, weighting: Weighting) -> Vec<f64> {
        card::target_weights(&self.list, weighting)
    }
}

/// A validated, canonical configuration with its strategy built.
pub struct Prepared {
    /// The canonical configuration.
    pub config: Config,
    pub canonical_json: String,
    pub config_id: String,
    pub strategy: Box<dyn Strategy>,
    /// Canonical JSON of the strategy spec (part of every random stream's seed).
    pub strategy_json: String,
    pub opener: Option<WordId>,
    pub deterministic: bool,
    /// Phase labels, indexed by `Turn::phase`.
    pub phases: Vec<String>,
}

impl Prepared {
    /// Label of a turn's phase: the strategy's label, `"opener"` or `"player"`.
    pub fn phase_label(&self, phase: u8) -> String {
        phase_label(&self.phases, phase)
    }
}

/// Label of a phase index given the strategy's phase labels.
pub fn phase_label(phases: &[String], phase: u8) -> String {
    match phase {
        PHASE_OPENER => "opener".into(),
        PHASE_PLAYER => "player".into(),
        p => phases.get(p as usize).cloned().unwrap_or_else(|| p.to_string()),
    }
}
