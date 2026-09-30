//! The pattern matrix: feedback for every allowed guess against every answer.
//!
//! Stored row-major by guess (`data[guess * n_answers + answer]`), as u8 for
//! words of up to five letters (243 patterns) and u16 above that.
//!
//! **Building rows.** Feedback decomposes by letter: the cells of a guess's
//! letter `l` depend only on where `l` sits in the guess (a position mask
//! `p`) and where it sits in the answer (a mask `s`). Of the positions in
//! `p`, those also in `s` are green; the rest, left to right, are yellow
//! while the answer has copies of `l` left over, that is for the first
//! `min(|s|, |p|) − |p ∩ s|` of them; the others are absent. This is exactly
//! [`feedback`]'s rule (greens first, then yellows left to right against the
//! remaining letter counts), since other letters never touch `l`'s count. So
//!
//! ```text
//! pattern(g, a) = Σ over distinct letters l of g: contrib[p_l(g)][s_l(a)]
//! ```
//!
//! with one small table `contrib` for the word length. A row is then a few
//! byte lookups per answer, with the answers' position masks laid out by
//! letter so that each lookup streams through memory.

use crate::bitset::CandidateSet;
use crate::math;
#[cfg(test)]
use crate::pattern::feedback;
use crate::pattern::{n_patterns, Pattern, MAX_WORD_LEN};
use crate::words::{AnswerIdx, WordId, WordList};

/// The blank letter: no word has it, so its position masks are all empty.
const BLANK: usize = 26;
/// Width of a `contrib` row: position masks are below 2^7.
const MASKS: usize = 1 << MAX_WORD_LEN;

/// A matrix cell type.
trait Cell: Copy + Default {
    fn from_code(code: u16) -> Self;
    fn add(self, other: Self) -> Self;
}

impl Cell for u8 {
    #[inline(always)]
    fn from_code(code: u16) -> Self {
        code as u8
    }
    #[inline(always)]
    fn add(self, other: Self) -> Self {
        // Contributions of distinct letters sum to a pattern code, which fits.
        self.wrapping_add(other)
    }
}

impl Cell for u16 {
    #[inline(always)]
    fn from_code(code: u16) -> Self {
        code
    }
    #[inline(always)]
    fn add(self, other: Self) -> Self {
        self.wrapping_add(other)
    }
}

/// Tables for building rows of one word list (see the module docs).
struct RowBuilder<T> {
    n_answers: usize,
    /// `pos[l * n_answers + a]`: bit i is set when answer `a` has letter `l`
    /// (`0..26`, or [`BLANK`]) at position i.
    pos: Vec<u8>,
    /// `contrib[p * MASKS + s]`: the pattern code of a letter at guess
    /// positions `p` against answer positions `s`.
    contrib: Vec<T>,
}

impl<T: Cell> RowBuilder<T> {
    fn new(list: &WordList) -> RowBuilder<T> {
        let (na, len) = (list.n_answers(), list.word_len());
        let mut pos = vec![0u8; (BLANK + 1) * na];
        for (a, &id) in list.answers().iter().enumerate() {
            for (i, &b) in list.letters(id).iter().enumerate() {
                pos[(b - b'a') as usize * na + a] |= 1 << i;
            }
        }
        let n = 1usize << len;
        let mut contrib = vec![T::default(); n * MASKS];
        for p in 0..n {
            for s in 0..n {
                let green = p & s;
                let mut yellows = (s.count_ones().min(p.count_ones()) - green.count_ones()) as usize;
                let mut code = 0u16;
                let mut pow = 1u16;
                for i in 0..len {
                    if green >> i & 1 == 1 {
                        code += 2 * pow;
                    } else if p >> i & 1 == 1 && yellows > 0 {
                        code += pow;
                        yellows -= 1;
                    }
                    pow *= 3;
                }
                contrib[p * MASKS + s] = T::from_code(code);
            }
        }
        RowBuilder { n_answers: na, pos, contrib }
    }

    /// Answers' position masks of letter `l`.
    #[inline(always)]
    fn masks(&self, l: usize) -> &[u8] {
        &self.pos[l * self.n_answers..(l + 1) * self.n_answers]
    }

    /// The `contrib` row of guess positions `p`.
    #[inline(always)]
    fn contrib_row(&self, p: usize) -> &[T; MASKS] {
        self.contrib[p * MASKS..(p + 1) * MASKS].try_into().expect("a full row")
    }

    /// Fill one row. Not inlined, so a WASM engine can optimise it after
    /// the first few calls instead of running the whole build unoptimised.
    #[inline(never)]
    fn fill(&self, guess: &[u8], row: &mut [T]) {
        // Distinct letters of the guess with their position masks, padded
        // with blanks (which contribute nothing) to at least four.
        let mut slots = [(BLANK, 0usize); MAX_WORD_LEN];
        let mut k = 0;
        for (i, &b) in guess.iter().enumerate() {
            let l = (b - b'a') as usize;
            match slots[..k].iter_mut().find(|s| s.0 == l) {
                Some(s) => s.1 |= 1 << i,
                None => {
                    slots[k] = (l, 1 << i);
                    k += 1;
                }
            }
        }
        let m = |j: usize| self.masks(slots[j].0);
        let f = |j: usize| self.contrib_row(slots[j].1);
        let (f0, f1, f2, f3) = (f(0), f(1), f(2), f(3));
        let at = |f: &[T; MASKS], s: u8| f[s as usize & (MASKS - 1)];
        if k <= 4 {
            for ((((cell, &a), &b), &c), &d) in row.iter_mut().zip(m(0)).zip(m(1)).zip(m(2)).zip(m(3)) {
                *cell = at(f0, a).add(at(f1, b)).add(at(f2, c)).add(at(f3, d));
            }
        } else {
            let f4 = f(4);
            for (((((cell, &a), &b), &c), &d), &e) in row.iter_mut().zip(m(0)).zip(m(1)).zip(m(2)).zip(m(3)).zip(m(4)) {
                *cell = at(f0, a).add(at(f1, b)).add(at(f2, c)).add(at(f3, d)).add(at(f4, e));
            }
            // Six or seven distinct letters (longer words).
            for j in 5..k {
                let fj = f(j);
                for (cell, &s) in row.iter_mut().zip(m(j)) {
                    *cell = cell.add(at(fj, s));
                }
            }
        }
    }
}

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
    /// `c · log2 c` for every possible bucket count (see [`PatternMatrix::nlogn`]).
    nlogn: Vec<f64>,
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
        let nlogn = (0..=list.n_answers())
            .map(|c| {
                if c < 2 {
                    0.0
                } else {
                    let c = c as f64;
                    c * math::log2(c)
                }
            })
            .collect();
        PatternMatrix {
            n_guesses: list.n_guesses(),
            n_answers: list.n_answers(),
            word_len: list.word_len(),
            data,
            nlogn,
        }
    }

    /// Fill rows `start..end` (each cell is [`crate::feedback`] of the guess
    /// against the answer; see the module docs for how).
    pub fn build_rows(&mut self, list: &WordList, start: usize, end: usize) {
        let na = self.n_answers;
        let rows = start.min(self.n_guesses)..end.min(self.n_guesses);
        if rows.is_empty() || na == 0 {
            return;
        }
        match &mut self.data {
            Storage::U8(d) => {
                let b = RowBuilder::<u8>::new(list);
                for (g, row) in rows.clone().zip(d[rows.start * na..rows.end * na].chunks_exact_mut(na)) {
                    b.fill(list.letters(g as WordId), row);
                }
            }
            Storage::U16(d) => {
                let b = RowBuilder::<u16>::new(list);
                for (g, row) in rows.clone().zip(d[rows.start * na..rows.end * na].chunks_exact_mut(na)) {
                    b.fill(list.letters(g as WordId), row);
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

    /// `c · log2 c` (through [`crate::math`], exactly as
    /// [`crate::entropy_from_counts`] computes it) for every count `c` from 0
    /// to the number of answers, with 0 for `c < 2`.
    #[inline]
    pub fn nlogn(&self) -> &[f64] {
        &self.nlogn
    }

    /// Count candidates per pattern for `guess`. `counts` must have
    /// [`PatternMatrix::n_patterns`] entries; it is zeroed first.
    #[inline]
    pub fn partition_counts(&self, guess: WordId, cands: &CandidateSet, counts: &mut [u32]) {
        counts.iter_mut().for_each(|c| *c = 0);
        match self.row(guess) {
            Row::U8(r) => count_row(r, cands, counts),
            Row::U16(r) => count_row(r, cands, counts),
        }
    }

    /// Candidates consistent with `pattern` after playing `guess`.
    pub fn refine(&self, cands: &CandidateSet, guess: WordId, pattern: Pattern) -> CandidateSet {
        let words = match self.row(guess) {
            Row::U8(r) => match u8::try_from(pattern.0) {
                Ok(p) => refine_row(r, cands, p),
                Err(_) => vec![0; cands.words().len()],
            },
            Row::U16(r) => refine_row(r, cands, pattern.0),
        };
        CandidateSet::from_words(cands.universe(), words)
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

/// Words of a candidate set with at least this many members are handled
/// whole (every cell of the 64 in the row) rather than member by member.
const DENSE_WORD: u32 = 16;

/// Count the candidates' patterns in a row.
#[inline]
fn count_row<T: Copy + Into<usize>>(row: &[T], cands: &CandidateSet, counts: &mut [u32]) {
    for (w, &bits) in cands.words().iter().enumerate() {
        if bits == u64::MAX {
            for &p in &row[w * 64..w * 64 + 64] {
                counts[p.into()] += 1;
            }
        } else {
            let mut b = bits;
            while b != 0 {
                counts[row[w * 64 + b.trailing_zeros() as usize].into()] += 1;
                b &= b - 1;
            }
        }
    }
}

/// The words of the candidates whose cell in `row` is `pattern`.
#[inline]
fn refine_row<T: Copy + PartialEq>(row: &[T], cands: &CandidateSet, pattern: T) -> Vec<u64> {
    let cands = cands.words();
    let mut out = vec![0u64; cands.len()];
    for ((o, &bits), cells) in out.iter_mut().zip(cands).zip(row.chunks(64)) {
        if bits.count_ones() >= DENSE_WORD {
            let mut m = 0u64;
            for (i, &c) in cells.iter().enumerate() {
                m |= ((c == pattern) as u64) << i;
            }
            *o = m & bits;
        } else {
            let mut b = bits;
            while b != 0 {
                let i = b.trailing_zeros() as usize;
                b &= b - 1;
                if cells[i] == pattern {
                    *o |= 1 << i;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::words::tests::tiny;
    use crate::words::Manifest;
    use proptest::prelude::*;

    /// Every cell equals `feedback`.
    fn assert_matches_feedback(l: &WordList, m: &PatternMatrix) {
        for g in 0..l.n_guesses() as WordId {
            for a in 0..l.n_answers() as AnswerIdx {
                let want = feedback(l.letters(g), l.letters(l.answer_word(a)));
                assert_eq!(m.get(g, a), want, "{} against {}", l.word(g), l.word(l.answer_word(a)));
            }
        }
    }

    #[test]
    fn reference_list_matches_feedback() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists/ref-en-5");
        let l = crate::load_dir(&dir).unwrap();
        let m = PatternMatrix::build(&l);
        assert_matches_feedback(&l, &m);
        // Building in slices gives the same matrix.
        let mut sliced = PatternMatrix::alloc(&l);
        for start in (0..l.n_guesses() + 7).step_by(7) {
            sliced.build_rows(&l, start, start + 7);
        }
        for g in 0..l.n_guesses() as WordId {
            for a in 0..l.n_answers() as AnswerIdx {
                assert_eq!(sliced.get(g, a), m.get(g, a));
            }
        }
    }

    #[test]
    fn partitions_match_naive() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists/ref-en-5");
        let full = crate::load_dir(&dir).unwrap();
        // Also a list whose answers fill whole bit words (128 answers).
        let words: Vec<&str> = full.answers()[..128].iter().map(|&id| full.word(id)).collect();
        let whole = WordList::from_words(Manifest::adhoc("w", 5), &words, &words).unwrap();
        for l in [&full, &whole] {
            let m = PatternMatrix::build(l);
            let na = l.n_answers();
            let sets = [
                CandidateSet::full(na),
                CandidateSet::from_iter(na, (0..na as AnswerIdx).filter(|a| a % 3 != 0)),
                CandidateSet::from_iter(na, (0..na as AnswerIdx).filter(|a| a * 7 % 11 == 0)),
                CandidateSet::from_iter(na, (0..na as AnswerIdx).filter(|a| a % 64 < 20 || a % 5 == 0)),
                CandidateSet::from_iter(na, [0, 63, 64, na as AnswerIdx - 1]),
                CandidateSet::empty(na),
            ];
            let mut counts = vec![0u32; m.n_patterns()];
            for cands in &sets {
                for g in (0..l.n_guesses() as WordId).step_by(37) {
                    let mut naive = vec![0u32; m.n_patterns()];
                    for a in cands.iter() {
                        naive[m.get(g, a).0 as usize] += 1;
                    }
                    m.partition_counts(g, cands, &mut counts);
                    assert_eq!(counts, naive);
                    let info = crate::expected_info(&m, g, cands, &mut counts);
                    assert_eq!(info.to_bits(), crate::entropy_from_counts(&naive, cands.len() as u32).to_bits());
                    for p in [0, 1, 80, 121, 242, 243, 300] {
                        let want = CandidateSet::from_iter(na, cands.iter().filter(|&a| m.get(g, a).0 == p));
                        let got = m.refine(cands, g, Pattern(p));
                        assert_eq!(got, want);
                        assert_eq!(got.len(), want.len());
                    }
                }
            }
        }
    }

    #[test]
    fn every_length_matches_feedback() {
        let lists: [&[&str]; 4] = [
            &["abba", "aaab", "baaa", "abcd", "dcba", "aaaa", "bbbb", "abab", "zzza", "azzz"],
            &[
                "speed", "abide", "erase", "steal", "crepe", "kebab", "babes", "lolly", "level", "eerie", "sassy",
                "esses",
            ],
            &["banana", "ananas", "abacus", "bazaar", "cocoon", "voodoo", "lllama", "aaaaaa", "abcdef", "fedcba"],
            &["bananas", "ananasa", "abacuss", "aaaaaaa", "abcdefg", "gfedcba", "aabbcca", "zyxxyza", "entente"],
        ];
        for words in lists {
            let l = WordList::from_words(Manifest::adhoc("t", words[0].len()), words, words).unwrap();
            assert_matches_feedback(&l, &PatternMatrix::build(&l));
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]
        #[test]
        fn random_lists_match_feedback(len in 4usize..=7, raw in prop::collection::vec(prop::collection::vec(0u8..4, 7), 1..40)) {
            // A four-letter alphabet (plus the last letters of the alphabet) forces repeated letters.
            let mut words: Vec<String> = raw.iter()
                .map(|w| w[..len].iter().map(|&c| if c == 3 { 'z' } else { (b'a' + c) as char }).collect())
                .collect();
            words.sort();
            words.dedup();
            let l = WordList::from_words(Manifest::adhoc("p", len), &words, &words).unwrap();
            assert_matches_feedback(&l, &PatternMatrix::build(&l));
        }
    }

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
