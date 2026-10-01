//! Word lists: a manifest plus plain files.
//!
//! Guesses are the allowed list; a [`WordId`] is a word's index in the guess
//! file (sorted alphabetically, so lower ids are earlier words). Answers are a
//! subset of guesses; an [`AnswerIdx`] is an index into the answer list, which
//! is also the universe of [`crate::CandidateSet`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::pattern::{MAX_WORD_LEN, MIN_WORD_LEN};

/// Index of a word in the guess (allowed) list.
pub type WordId = u16;
/// Index of a word in the answer list.
pub type AnswerIdx = u16;

/// Sentinel for "not an answer" in [`WordList::answer_idx`].
const NO_ANSWER: u16 = u16::MAX;

/// A word list manifest, as shipped in `manifest.json`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub word_length: usize,
    #[serde(default)]
    pub language: Option<String>,
    pub answers: String,
    #[serde(default)]
    pub answers_ranked: Option<String>,
    pub guesses: String,
    #[serde(default)]
    pub frequencies: Option<String>,
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(default)]
    pub licence: String,
    #[serde(default)]
    pub credits: Vec<String>,
    #[serde(default)]
    pub counts: serde_json::Value,
    #[serde(default)]
    pub sha256: serde_json::Value,
}

impl Manifest {
    /// A minimal manifest for tests and ad-hoc lists.
    pub fn adhoc(id: &str, word_length: usize) -> Manifest {
        Manifest {
            id: id.to_string(),
            name: id.to_string(),
            version: "0".to_string(),
            word_length,
            language: None,
            answers: "answers.txt".into(),
            answers_ranked: None,
            guesses: "guesses.txt".into(),
            frequencies: None,
            notice: None,
            licence: String::new(),
            credits: vec![],
            counts: serde_json::Value::Null,
            sha256: serde_json::Value::Null,
        }
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum WordListError {
    #[error("word length {0} is outside the supported range 4 to 7")]
    BadLength(usize),
    #[error("word {word:?} has {got} letters, expected {expected}")]
    WrongLength { word: String, got: usize, expected: usize },
    #[error("word {0:?} contains characters other than a to z")]
    BadChars(String),
    #[error("duplicate word {0:?}")]
    Duplicate(String),
    #[error("answer {0:?} is not in the guess list")]
    AnswerNotGuess(String),
    #[error("the answer list is empty")]
    NoAnswers,
    #[error("too many words ({0}); at most 65,534 are supported")]
    TooMany(usize),
    #[error("bad frequency line {0:?}")]
    BadFrequency(String),
}

/// A loaded, validated word list.
#[derive(Clone, Debug)]
pub struct WordList {
    pub manifest: Manifest,
    len: usize,
    /// Packed letters of every guess, `len` bytes each, as `b'a'..=b'z'`.
    letters: Vec<u8>,
    strings: Vec<String>,
    answers: Vec<WordId>,
    answer_of: Vec<u16>,
    index: HashMap<String, WordId>,
    /// Zipf frequency per guess (0 when missing), if the list has frequencies.
    zipf: Option<Vec<f32>>,
}

fn parse_words(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.to_ascii_lowercase())
        .collect()
}

impl WordList {
    /// Build from file contents: one word per line; frequencies as `word<TAB>zipf`.
    ///
    /// Validates that every word has the stated length, that there are no
    /// duplicates, and that answers are a subset of guesses.
    pub fn from_texts(
        manifest: Manifest,
        guesses: &str,
        answers: &str,
        frequencies: Option<&str>,
    ) -> Result<WordList, WordListError> {
        let guesses = parse_words(guesses);
        let answers = parse_words(answers);
        let mut list = WordList::from_words(manifest, &guesses, &answers)?;
        if let Some(text) = frequencies {
            list.set_frequencies(text)?;
        }
        Ok(list)
    }

    /// Build from word vectors. Guesses keep the given order (the shipped files are sorted).
    pub fn from_words<G: AsRef<str>, A: AsRef<str>>(
        manifest: Manifest,
        guesses: &[G],
        answers: &[A],
    ) -> Result<WordList, WordListError> {
        let len = manifest.word_length;
        if !(MIN_WORD_LEN..=MAX_WORD_LEN).contains(&len) {
            return Err(WordListError::BadLength(len));
        }
        if guesses.len() >= NO_ANSWER as usize {
            return Err(WordListError::TooMany(guesses.len()));
        }
        let mut letters = Vec::with_capacity(guesses.len() * len);
        let mut strings = Vec::with_capacity(guesses.len());
        let mut index = HashMap::with_capacity(guesses.len());
        for w in guesses {
            let w = w.as_ref();
            if w.len() != len {
                return Err(WordListError::WrongLength { word: w.into(), got: w.len(), expected: len });
            }
            if !w.bytes().all(|b| b.is_ascii_lowercase()) {
                return Err(WordListError::BadChars(w.into()));
            }
            let id = strings.len() as WordId;
            if index.insert(w.to_string(), id).is_some() {
                return Err(WordListError::Duplicate(w.into()));
            }
            letters.extend_from_slice(w.as_bytes());
            strings.push(w.to_string());
        }
        let mut answer_of = vec![NO_ANSWER; strings.len()];
        let mut answer_ids = Vec::with_capacity(answers.len());
        for a in answers {
            let a = a.as_ref();
            let id = *index.get(a).ok_or_else(|| {
                if a.len() != len {
                    WordListError::WrongLength { word: a.into(), got: a.len(), expected: len }
                } else {
                    WordListError::AnswerNotGuess(a.into())
                }
            })?;
            if answer_of[id as usize] != NO_ANSWER {
                return Err(WordListError::Duplicate(a.into()));
            }
            answer_of[id as usize] = answer_ids.len() as u16;
            answer_ids.push(id);
        }
        if answer_ids.is_empty() {
            return Err(WordListError::NoAnswers);
        }
        Ok(WordList { manifest, len, letters, strings, answers: answer_ids, answer_of, index, zipf: None })
    }

    /// Attach Zipf frequencies (`word<TAB>zipf` per line). Guesses without a line get 0.
    pub fn set_frequencies(&mut self, text: &str) -> Result<(), WordListError> {
        let mut zipf = vec![0f32; self.strings.len()];
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (w, z) = line.split_once('\t').ok_or_else(|| WordListError::BadFrequency(line.into()))?;
            let z: f32 = z.trim().parse().map_err(|_| WordListError::BadFrequency(line.into()))?;
            if let Some(&id) = self.index.get(w.trim()) {
                zipf[id as usize] = z;
            }
        }
        self.zipf = Some(zipf);
        Ok(())
    }

    /// A copy of this list with a different answer set (a frequency cutoff or a pasted list).
    pub fn with_answers<S: AsRef<str>>(&self, answers: &[S]) -> Result<WordList, WordListError> {
        let mut out = WordList::from_words(self.manifest.clone(), &self.strings, answers)?;
        out.zipf = self.zipf.clone();
        Ok(out)
    }

    /// Word length.
    #[inline]
    pub fn word_len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn n_guesses(&self) -> usize {
        self.strings.len()
    }

    #[inline]
    pub fn n_answers(&self) -> usize {
        self.answers.len()
    }

    /// The word for a guess id.
    #[inline]
    pub fn word(&self, id: WordId) -> &str {
        &self.strings[id as usize]
    }

    /// Letters (`b'a'..=b'z'`) of a guess id.
    #[inline]
    pub fn letters(&self, id: WordId) -> &[u8] {
        let s = id as usize * self.len;
        &self.letters[s..s + self.len]
    }

    /// Look up a word (case-insensitive).
    pub fn id(&self, word: &str) -> Option<WordId> {
        self.index.get(&word.to_ascii_lowercase()).copied()
    }

    /// All guess words, in id order.
    pub fn words(&self) -> &[String] {
        &self.strings
    }

    /// Guess ids of the answers, in answer order.
    #[inline]
    pub fn answers(&self) -> &[WordId] {
        &self.answers
    }

    /// Guess id of answer `a`.
    #[inline]
    pub fn answer_word(&self, a: AnswerIdx) -> WordId {
        self.answers[a as usize]
    }

    /// Answer index of a guess id, if it is an answer.
    #[inline]
    pub fn answer_idx(&self, id: WordId) -> Option<AnswerIdx> {
        let a = self.answer_of[id as usize];
        (a != NO_ANSWER).then_some(a)
    }

    /// Answer index of a word, if it is an answer.
    pub fn answer_of_word(&self, word: &str) -> Option<AnswerIdx> {
        self.id(word).and_then(|id| self.answer_idx(id))
    }

    /// Zipf frequencies per guess id, if the list has them.
    pub fn zipf(&self) -> Option<&[f32]> {
        self.zipf.as_deref()
    }

    /// Zipf frequency of a guess (0 when the list has no frequencies).
    #[inline]
    pub fn zipf_of(&self, id: WordId) -> f32 {
        self.zipf.as_ref().map_or(0.0, |z| z[id as usize])
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn tiny() -> WordList {
        let guesses = ["abide", "crane", "erase", "slate", "speed", "steal", "those", "trace"];
        let answers = ["abide", "crane", "erase", "steal", "those"];
        WordList::from_words(Manifest::adhoc("tiny", 5), &guesses, &answers).unwrap()
    }

    #[test]
    fn indices() {
        let l = tiny();
        assert_eq!(l.n_guesses(), 8);
        assert_eq!(l.n_answers(), 5);
        assert_eq!(l.id("CRANE"), Some(1));
        assert_eq!(l.answer_idx(1), Some(1));
        assert_eq!(l.answer_idx(3), None);
        assert_eq!(l.answer_word(3), l.id("steal").unwrap());
        assert_eq!(l.letters(4), b"speed");
    }

    #[test]
    fn validation() {
        let m = Manifest::adhoc("t", 5);
        assert_eq!(
            WordList::from_words(m.clone(), &["crane", "crane"], &["crane"]).unwrap_err(),
            WordListError::Duplicate("crane".into())
        );
        assert!(matches!(
            WordList::from_words(m.clone(), &["crane", "cranes"], &["crane"]).unwrap_err(),
            WordListError::WrongLength { .. }
        ));
        assert_eq!(
            WordList::from_words(m.clone(), &["crane"], &["slate"]).unwrap_err(),
            WordListError::AnswerNotGuess("slate".into())
        );
        assert_eq!(
            WordList::from_words(m, &["cr4ne"], &["cr4ne"]).unwrap_err(),
            WordListError::BadChars("cr4ne".into())
        );
    }

    #[test]
    fn frequencies() {
        let mut l = tiny();
        l.set_frequencies("crane\t3.10\nsteal\t3.5\nnotaword\t9\n").unwrap();
        assert_eq!(l.zipf_of(1), 3.10);
        assert_eq!(l.zipf_of(0), 0.0);
    }
}
