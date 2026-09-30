//! The pattern matrix: feedback for every allowed guess against every answer.
//!
//! Stored row-major by guess (`data[guess * n_answers + answer]`), as u8 for
//! words of up to five letters (243 patterns) and u16 above that.

use crate::bitset::CandidateSet;
use crate::pattern::{feedback, n_patterns, Pattern};
use crate::words::{AnswerIdx, WordId, WordList};

#[derive(Clone)]
enum Storage {
    U8(Vec<u8>),
    U16(Vec<u16>),
}

#[derive(Clone)]
pub struct PatternMatrix {
    n_guesses: usize,
    n_answers: usize,
    word_len: usize,
    data: Storage,
}

impl std::fmt::Debug for PatternMatrix {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PatternMatrix({} x {})", self.n_guesses, self.n_answers)
    }
}

/// A borrowed row of the matrix: one guess against every answer.
#[derive(Clone, Copy)]
pub enum Row<'a> {
    U8(&'a [u8]),
    U16(&'a [u16]),
}

impl Row<'_> {
    #[inline]
    pub fn get(&self, a: AnswerIdx) -> Pattern {
        match self {
            Row::U8(r) => Pattern(r[a as usize] as u16),
            Row::U16(r) => Pattern(r[a as usize]),
        }
    }
}

impl PatternMatrix {
    /// Build the full matrix.
    pub fn build(list: &WordList) -> PatternMatrix {
        let mut m = PatternMatrix::alloc(list);
        m.build_rows(list, 0, list.n_guesses());
        m
    }

    /// Allocate an unfilled matrix, to be filled with [`PatternMatrix::build_rows`]
    /// in slices (so a worker can report progress or yield between them).
    pub fn alloc(list: &WordList) -> PatternMatrix {
        let n = list.n_guesses() * list.n_answers();
        let data = if n_patterns(list.word_len()) <= 256 { Storage::U8(vec![0; n]) } else { Storage::U16(vec![0; n]) };
        PatternMatrix { n_guesses: list.n_guesses(), n_answers: list.n_answers(), word_len: list.word_len(), data }
    }

    /// Fill rows `start..end`.
    pub fn build_rows(&mut self, list: &WordList, start: usize, end: usize) {
        let na = self.n_answers;
        let answers: Vec<&[u8]> = list.answers().iter().map(|&id| list.letters(id)).collect();
        for g in start..end.min(self.n_guesses) {
            let gl = list.letters(g as WordId);
            match &mut self.data {
                Storage::U8(d) => {
                    for (cell, t) in d[g * na..(g + 1) * na].iter_mut().zip(&answers) {
                        *cell = feedback(gl, t).0 as u8;
                    }
                }
                Storage::U16(d) => {
                    for (cell, t) in d[g * na..(g + 1) * na].iter_mut().zip(&answers) {
                        *cell = feedback(gl, t).0;
                    }
                }
            }
        }
    }

    #[inline]
    pub fn n_guesses(&self) -> usize {
        self.n_guesses
    }

    #[inline]
    pub fn n_answers(&self) -> usize {
        self.n_answers
    }

    #[inline]
    pub fn word_len(&self) -> usize {
        self.word_len
    }

    /// Number of distinct patterns (3^word length).
    #[inline]
    pub fn n_patterns(&self) -> usize {
        n_patterns(self.word_len)
    }

    #[inline]
    pub fn get(&self, guess: WordId, answer: AnswerIdx) -> Pattern {
        let i = guess as usize * self.n_answers + answer as usize;
        match &self.data {
            Storage::U8(d) => Pattern(d[i] as u16),
            Storage::U16(d) => Pattern(d[i]),
        }
    }

    #[inline]
    pub fn row(&self, guess: WordId) -> Row<'_> {
        let s = guess as usize * self.n_answers;
        match &self.data {
            Storage::U8(d) => Row::U8(&d[s..s + self.n_answers]),
            Storage::U16(d) => Row::U16(&d[s..s + self.n_answers]),
        }
    }

    /// Bytes held by the matrix.
    pub fn size_bytes(&self) -> usize {
        match &self.data {
            Storage::U8(d) => d.len(),
            Storage::U16(d) => d.len() * 2,
        }
    }

    /// Count candidates per pattern for `guess`. `counts` must have
    /// [`PatternMatrix::n_patterns`] entries; it is zeroed first.
    #[inline]
    pub fn partition_counts(&self, guess: WordId, cands: &CandidateSet, counts: &mut [u32]) {
        counts.iter_mut().for_each(|c| *c = 0);
        match self.row(guess) {
            Row::U8(r) => {
                for a in cands.iter() {
                    counts[r[a as usize] as usize] += 1;
                }
            }
            Row::U16(r) => {
                for a in cands.iter() {
                    counts[r[a as usize] as usize] += 1;
                }
            }
        }
    }

    /// Candidates consistent with `pattern` after playing `guess`.
    pub fn refine(&self, cands: &CandidateSet, guess: WordId, pattern: Pattern) -> CandidateSet {
        let mut out = CandidateSet::empty(cands.universe());
        let row = self.row(guess);
        for a in cands.iter() {
            if row.get(a) == pattern {
                out.insert(a);
            }
        }
        out
    }

    /// Split candidates by the pattern `guess` produces, in increasing pattern order.
    pub fn partition(&self, cands: &CandidateSet, guess: WordId) -> Vec<(Pattern, CandidateSet)> {
        let mut buckets: Vec<Option<CandidateSet>> = vec![None; self.n_patterns()];
        let row = self.row(guess);
        for a in cands.iter() {
            let p = row.get(a).0 as usize;
            buckets[p].get_or_insert_with(|| CandidateSet::empty(cands.universe())).insert(a);
        }
        buckets.into_iter().enumerate().filter_map(|(p, s)| s.map(|s| (Pattern(p as u16), s))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::words::tests::tiny;

    #[test]
    fn matrix_matches_feedback() {
        let l = tiny();
        let m = PatternMatrix::build(&l);
        for g in 0..l.n_guesses() as WordId {
            for a in 0..l.n_answers() as AnswerIdx {
                assert_eq!(m.get(g, a), feedback(l.letters(g), l.letters(l.answer_word(a))));
            }
        }
        let all = CandidateSet::full(l.n_answers());
        let parts = m.partition(&all, l.id("speed").unwrap());
        assert_eq!(parts.iter().map(|(_, s)| s.len()).sum::<usize>(), l.n_answers());
        let mut counts = vec![0; m.n_patterns()];
        m.partition_counts(l.id("speed").unwrap(), &all, &mut counts);
        for (p, s) in &parts {
            assert_eq!(counts[p.0 as usize] as usize, s.len());
            assert_eq!(&m.refine(&all, l.id("speed").unwrap(), *p), s);
        }
    }
}
