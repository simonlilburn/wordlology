//! wl-core: word lists, feedback patterns, the pattern matrix, candidate
//! bitsets, partitions, entropy and letter filters.

pub mod bitset;
pub mod filter;
pub mod hard;
pub mod info;
pub mod math;
pub mod matrix;
pub mod pattern;
pub mod words;

pub use bitset::CandidateSet;
pub use hard::{hard_mode_ok, hard_mode_violation};
pub use info::{entropy_from_counts, expected_info, observed_info, remaining_bits};
pub use matrix::{PatternMatrix, Row};
pub use pattern::{feedback, feedback_str, n_patterns, Pattern, MAX_WORD_LEN, MIN_WORD_LEN};
pub use words::{AnswerIdx, Manifest, WordId, WordList, WordListError};

/// Solver version. Part of every config ID; bump it whenever results change
/// (golden cards are only updated together with a bump).
pub const SOLVER_VERSION: &str = "0.1.0";

/// Load a word list directory (`manifest.json` plus the files it names).
#[cfg(not(target_arch = "wasm32"))]
pub fn load_dir(dir: &std::path::Path) -> Result<WordList, Box<dyn std::error::Error>> {
    let manifest: Manifest = serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json"))?)?;
    let guesses = std::fs::read_to_string(dir.join(&manifest.guesses))?;
    let answers = std::fs::read_to_string(dir.join(&manifest.answers))?;
    let freqs = match &manifest.frequencies {
        Some(f) => Some(std::fs::read_to_string(dir.join(f))?),
        None => None,
    };
    Ok(WordList::from_texts(manifest, &guesses, &answers, freqs.as_deref())?)
}
