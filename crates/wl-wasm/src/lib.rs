//! wl-wasm: the wasm-bindgen API (docs/architecture.md, "WASM API").
//!
//! A [`Solver`] holds one word list with one answer selection and its pattern
//! matrix; the web worker creates one per list and selection. Runs live
//! inside the solver and are addressed by a `u32` handle. Games leave as
//! binary batches (`wl_engine::batch`), everything else as JSON strings, so
//! the JavaScript side never depends on wasm-bindgen object layouts.
//!
//! All the logic lives in `wl-engine`; this crate only binds it, so the
//! native CLI (`wordlology batch`) produces byte-identical batches, which
//! `scripts/check-determinism.mjs` verifies.

use std::collections::HashMap;
use std::sync::Arc;

use wasm_bindgen::prelude::*;
use wl_core::{Manifest, WordList, SOLVER_VERSION};
use wl_engine::batch::{encode_batch, encode_batches};
use wl_engine::run::{Progress, Summary};
use wl_engine::{api, Engine, EngineError, Run, Scope};

#[wasm_bindgen]
extern "C" {
    /// `performance.now()`: present in windows, workers and Node.
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// The clock runs use for their time budgets.
fn clock() -> f64 {
    performance_now()
}

/// A run, or what is left of it once it has finished (its progress and
/// summary), so finished runs hold no strategy or cache memory.
enum Slot {
    Active(Box<Run>),
    Finished { progress: Progress, summary: Summary },
}

/// Finished runs whose progress and summary are kept for late queries.
const MAX_FINISHED: usize = 4096;

/// One word list (with one answer selection) and its pattern matrix.
#[wasm_bindgen]
pub struct Solver {
    engine: Arc<Engine>,
    matrix_ms: f64,
    runs: HashMap<u32, Slot>,
    /// Handles of finished runs, oldest first, to bound `runs`.
    finished: std::collections::VecDeque<u32>,
    next_run: u32,
}

fn err(e: EngineError) -> JsError {
    JsError::new(&e.to_string())
}

/// Build the word list; answers are sorted alphabetically (by word id), so
/// answer indices are stable for a selection whatever order they came in.
fn load_list(manifest_json: &str, guesses: &str, answers: &str, frequencies: Option<&str>) -> Result<WordList, JsError> {
    let manifest: Manifest =
        serde_json::from_str(manifest_json).map_err(|e| JsError::new(&format!("bad manifest: {e}")))?;
    let list = WordList::from_texts(manifest, guesses, answers, frequencies).map_err(|e| JsError::new(&e.to_string()))?;
    let mut ids = list.answers().to_vec();
    if ids.windows(2).all(|w| w[0] < w[1]) {
        return Ok(list);
    }
    ids.sort_unstable();
    let words: Vec<&str> = ids.iter().map(|&id| list.word(id)).collect();
    list.with_answers(&words).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
impl Solver {
    /// Load a word list and build its pattern matrix.
    #[wasm_bindgen(constructor)]
    pub fn new(
        manifest_json: &str,
        guesses_txt: &str,
        answers_txt: &str,
        frequencies_txt: Option<String>,
    ) -> Result<Solver, JsError> {
        let list = load_list(manifest_json, guesses_txt, answers_txt, frequencies_txt.as_deref())?;
        let t0 = clock();
        let engine = Engine::new(list);
        let matrix_ms = clock() - t0;
        Ok(Solver { engine: Arc::new(engine), matrix_ms, runs: HashMap::new(), finished: Default::default(), next_run: 1 })
    }

    /// `wl_core::SOLVER_VERSION`.
    #[wasm_bindgen(js_name = solverVersion)]
    pub fn solver_version() -> String {
        SOLVER_VERSION.to_string()
    }

    /// Milliseconds taken to build the pattern matrix.
    #[wasm_bindgen(getter, js_name = matrixMs)]
    pub fn matrix_ms(&self) -> f64 {
        self.matrix_ms
    }

    /// Number of allowed guesses.
    #[wasm_bindgen(getter, js_name = nGuesses)]
    pub fn n_guesses(&self) -> usize {
        self.engine.list.n_guesses()
    }

    /// Number of answers in this solver's selection.
    #[wasm_bindgen(getter, js_name = nAnswers)]
    pub fn n_answers(&self) -> usize {
        self.engine.list.n_answers()
    }

    /// The config ID of a configuration (validated against this word list).
    #[wasm_bindgen(js_name = configId)]
    pub fn config_id(&self, config_json: &str) -> Result<String, JsError> {
        Ok(self.engine.prepare_json(config_json).map_err(err)?.config_id)
    }

    /// The canonical JSON of a configuration.
    #[wasm_bindgen(js_name = canonicalConfig)]
    pub fn canonical_config(&self, config_json: &str) -> Result<String, JsError> {
        Ok(self.engine.prepare_json(config_json).map_err(err)?.canonical_json)
    }

    /// Start a run of a configuration over a scope; returns its handle.
    #[wasm_bindgen(js_name = startRun)]
    pub fn start_run(&mut self, config_json: &str, scope_json: &str) -> Result<u32, JsError> {
        let prep = self.engine.prepare_json(config_json).map_err(err)?;
        let scope = Scope::from_json(scope_json).map_err(err)?;
        let run = Run::new(self.engine.clone(), prep, &scope).map_err(err)?.with_clock(clock);
        let handle = self.next_run;
        self.next_run = self.next_run.wrapping_add(1).max(1);
        self.runs.insert(handle, Slot::Active(Box::new(run)));
        Ok(handle)
    }

    /// Work for about `budget_ms` and return the games finished, as one
    /// binary batch (possibly with no games). Several batches are
    /// concatenated in the rare case of more than 65,535 games.
    pub fn step(&mut self, run: u32, budget_ms: f64) -> Result<Vec<u8>, JsError> {
        let slot = self.runs.get_mut(&run).ok_or_else(|| unknown(run))?;
        let Slot::Active(r) = slot else {
            return Ok(encode_batch(&[]));
        };
        let games = r.step(budget_ms);
        if r.is_done() {
            self.retire(run);
        }
        Ok(encode_batches(&games))
    }

    /// The run's progress as JSON (`ProgressEvent` fields, camelCase).
    pub fn progress(&self, run: u32) -> Result<String, JsError> {
        let p = match self.runs.get(&run).ok_or_else(|| unknown(run))? {
            Slot::Active(r) => r.progress(),
            Slot::Finished { progress, .. } => progress.clone(),
        };
        Ok(serde_json::to_string(&p).expect("progress serialises"))
    }

    #[wasm_bindgen(js_name = isDone)]
    pub fn is_done(&self, run: u32) -> Result<bool, JsError> {
        Ok(match self.runs.get(&run).ok_or_else(|| unknown(run))? {
            Slot::Active(r) => r.is_done(),
            Slot::Finished { .. } => true,
        })
    }

    /// The run's summary as JSON (`SummaryEvent` fields, camelCase).
    pub fn summary(&self, run: u32) -> Result<String, JsError> {
        let s = match self.runs.get(&run).ok_or_else(|| unknown(run))? {
            Slot::Active(r) => r.summary(),
            Slot::Finished { summary, .. } => summary.clone(),
        };
        Ok(serde_json::to_string(&s).expect("summary serialises"))
    }

    /// Stop a run and forget it. Unknown handles are ignored.
    pub fn cancel(&mut self, run: u32) {
        if self.runs.remove(&run).is_some() {
            self.finished.retain(|&h| h != run);
        }
    }

    /// Ranked alternatives after a history (`[{guess, pattern}, …]`), as
    /// JSON `ScoresResult`.
    pub fn scores(&self, config_json: &str, history_json: &str, top_k: usize) -> Result<String, JsError> {
        let prep = self.engine.prepare_json(config_json).map_err(err)?;
        let history = api::parse_history(&self.engine, history_json).map_err(err)?;
        let res = prep.scores(&self.engine, &history, top_k).map_err(err)?;
        Ok(serde_json::to_string(&res).expect("scores serialise"))
    }

    /// One-step expected information of every allowed guess (by word id)
    /// from the initial state. The configuration is only validated.
    #[wasm_bindgen(js_name = openerInfo)]
    pub fn opener_info(&self, config_json: &str) -> Result<Vec<f64>, JsError> {
        self.engine.prepare_json(config_json).map_err(err)?;
        Ok(api::opener_info(&self.engine))
    }

    /// Continue a game from a prefix of guess ids with the stream of
    /// (target, replicate): the rest of the game, or one more guess. Returns
    /// a batch holding the one game (see `Prepared::continue_game`).
    #[wasm_bindgen(js_name = continueGame)]
    pub fn continue_game(
        &self,
        config_json: &str,
        target: u32,
        history_json: &str,
        replicate: u32,
        one_step: bool,
    ) -> Result<Vec<u8>, JsError> {
        let prep = self.engine.prepare_json(config_json).map_err(err)?;
        let prefix = api::parse_guesses(&self.engine, history_json).map_err(err)?;
        let target = u16::try_from(target).map_err(|_| JsError::new(&format!("target {target} is not an answer index")))?;
        if replicate > u16::MAX as u32 {
            return Err(JsError::new(&format!("replicate {replicate} is out of range")));
        }
        let game = prep.continue_game(&self.engine, &prefix, target, replicate, one_step).map_err(err)?;
        Ok(encode_batch(std::slice::from_ref(&game)))
    }

    /// Parameter schemas of every strategy kind, as JSON.
    pub fn schemas(&self) -> String {
        serde_json::to_string(&wl_strategy::spec::all_schemas()).expect("schemas serialise")
    }

    /// The preset catalogue, as JSON.
    pub fn presets(&self) -> String {
        serde_json::to_string(&wl_strategy::catalogue::presets()).expect("presets serialise")
    }
}

impl Solver {
    /// Replace a finished run by its progress and summary.
    fn retire(&mut self, handle: u32) {
        if let Some(Slot::Active(r)) = self.runs.get(&handle) {
            let slot = Slot::Finished { progress: r.progress(), summary: r.summary() };
            self.runs.insert(handle, slot);
            self.finished.push_back(handle);
            while self.finished.len() > MAX_FINISHED {
                if let Some(old) = self.finished.pop_front() {
                    self.runs.remove(&old);
                }
            }
        }
    }
}

fn unknown(run: u32) -> JsError {
    JsError::new(&format!("unknown run {run}"))
}

/// Feedback code of `guess` against `target` (equal-length lowercase words).
#[wasm_bindgen]
pub fn feedback(guess: &str, target: &str) -> Result<u16, JsError> {
    let (g, t) = (guess.to_ascii_lowercase(), target.to_ascii_lowercase());
    if g.len() != t.len() || !(wl_core::MIN_WORD_LEN..=wl_core::MAX_WORD_LEN).contains(&g.len()) {
        return Err(JsError::new("feedback needs two words of the same length (4 to 7 letters)"));
    }
    Ok(wl_core::feedback_str(&g, &t).0)
}
