//! Fast expected-information scoring of many guesses against one candidate set.
//!
//! [`InfoScorer::score`] returns exactly (bit for bit) what
//! [`wl_core::expected_info`] returns: it adds the same `c · log2 c` terms
//! (through [`wl_core::math`]) in the same increasing pattern order and
//! finishes with the same `log2 t − Σ / t`. It is faster because it
//!
//! - collects the candidates' answer indices once instead of walking the
//!   bitset for every guess,
//! - looks `c · log2 c` up in a table (built once with the matrix),
//! - counts in `u16`, and
//! - marks touched patterns in a bitmap and visits only those, in increasing
//!   pattern order (so the summation order is unchanged), resetting only
//!   what it touched instead of all 3^L buckets.
//!
//! For larger candidate sets and u8 rows (words of up to five letters) it
//! switches to a laned kernel: four interleaved histograms (so runs of
//! candidates in the same bucket do not wait on each other's increments),
//! summed afterwards four buckets at a time in u64s, which also find the
//! buckets holding two or more candidates with a branch-free scan. The terms
//! are still added in increasing pattern order, so the result is the same bit
//! for bit.
//!
//! Over the allowed pool, [`Equivalence`] groups guesses that give the same
//! feedback on every candidate, so each group is scored once (with few
//! candidates left, a pool of 8,636 words has only a few thousand groups).

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

use wl_core::{math, AnswerIdx, CandidateSet, PatternMatrix, Row, WordId, WordList};

use crate::{Ctx, State};

/// Candidate sets at least this large use the laned kernel (for u8 rows).
/// Below it, the fixed cost of summing and scanning every bucket per guess
/// outweighs what the lanes save.
const LANED_MIN: usize = 64;

/// Scores guesses against one candidate set. Build one per state.
pub struct InfoScorer {
    cands: Vec<AnswerIdx>,
    total: f64,
    log2_total: f64,
    /// `nlogn[c] = c · log2 c` for `c > 1`, as `wl_core::entropy_from_counts`
    /// computes it (from [`PatternMatrix::nlogn`]).
    nlogn: Vec<f64>,
    counts: Vec<u16>,
    /// Bit p is set when pattern p has a non-zero count.
    touched: Vec<u64>,
    /// Set for candidate sets of at least [`LANED_MIN`] with u8 patterns.
    lanes: Option<Box<Lanes>>,
}

/// Working memory of the laned kernel.
struct Lanes {
    /// Four histograms; candidate i is counted in histogram i mod 4.
    hist: [[u16; 256]; 4],
    /// Quads of patterns that can occur (3^L / 4, rounded up).
    quads: usize,
}

/// Four consecutive u16 counts as one u64, count j in bits 16j.. (the
/// compiler turns this into a single load).
#[inline(always)]
fn quad(c: &[u16]) -> u64 {
    u64::from(c[0]) | u64::from(c[1]) << 16 | u64::from(c[2]) << 32 | u64::from(c[3]) << 48
}

impl Lanes {
    /// Σ c·log2(c) over buckets with c > 1, in increasing pattern order, for a u8 row.
    #[inline(always)]
    fn sum_nlogn(&mut self, cands: &[AnswerIdx], row: &[u8], nlogn: &[f64]) -> f64 {
        let [h0, h1, h2, h3] = &mut self.hist;
        let mut quads = cands.chunks_exact(4);
        for q in &mut quads {
            h0[row[q[0] as usize] as usize] += 1;
            h1[row[q[1] as usize] as usize] += 1;
            h2[row[q[2] as usize] as usize] += 1;
            h3[row[q[3] as usize] as usize] += 1;
        }
        for &a in quads.remainder() {
            h0[row[a as usize] as usize] += 1;
        }
        // Four patterns at a time: add the histograms as u64s (each count is
        // at most u16::MAX, the candidate limit, so no lane carries into the
        // next), then mark the counts of two or more: clear bit 0 of each,
        // set bit 15 of each non-zero one without carrying, and gather those
        // four bits into a nibble with one multiplication.
        let mut sums = [0u64; 64];
        let mut many = [0u64; 4];
        let lanes = h0.chunks_exact(4).zip(h1.chunks_exact(4)).zip(h2.chunks_exact(4)).zip(h3.chunks_exact(4));
        for (w, (sum, (((a, b), c), d))) in sums.iter_mut().zip(lanes).enumerate().take(self.quads) {
            let x = quad(a) + quad(b) + quad(c) + quad(d);
            *sum = x;
            let y = x & 0xfffe_fffe_fffe_fffe;
            let high = (((y & 0x7fff_7fff_7fff_7fff) + 0x7fff_7fff_7fff_7fff) | y) & 0x8000_8000_8000_8000;
            let nibble = ((high >> 15).wrapping_mul(1 << 45 | 1 << 30 | 1 << 15 | 1) >> 45) & 0xf;
            many[w >> 4] |= nibble << ((w & 15) * 4);
        }
        self.hist = [[0; 256]; 4];
        let mut sum = 0.0;
        for (i, &word) in many.iter().enumerate() {
            let mut bits = word;
            while bits != 0 {
                let p = i * 64 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                sum += nlogn[(sums[p >> 2] >> ((p & 3) * 16)) as u16 as usize];
            }
        }
        sum
    }
}

impl InfoScorer {
    pub fn new(matrix: &PatternMatrix, cands: &CandidateSet) -> InfoScorer {
        let t = cands.len();
        assert!(t <= u16::MAX as usize, "too many candidates for u16 counts");
        let nlogn = matrix.nlogn()[..=t].to_vec();
        // At least 256 buckets so a u8 pattern can index without a bounds check.
        let n = matrix.n_patterns().max(256);
        InfoScorer {
            cands: cands.iter().collect(),
            total: t as f64,
            log2_total: if t == 0 { 0.0 } else { math::log2(t as f64) },
            nlogn,
            counts: vec![0; n],
            touched: vec![0; n.div_ceil(64)],
            lanes: (t >= LANED_MIN && matrix.n_patterns() <= 256)
                .then(|| Box::new(Lanes { hist: [[0; 256]; 4], quads: matrix.n_patterns().div_ceil(4) })),
        }
    }

    /// Number of candidates.
    #[inline]
    pub fn n_candidates(&self) -> usize {
        self.cands.len()
    }

    /// The largest score any guess can reach: log2 of the number of candidates
    /// (every candidate in its own bucket).
    #[inline]
    pub fn max_score(&self) -> f64 {
        self.log2_total
    }

    /// Expected information (bits) of `guess`, identical to `wl_core::expected_info`.
    #[inline]
    pub fn score(&mut self, matrix: &PatternMatrix, guess: WordId) -> f64 {
        if self.cands.is_empty() {
            return 0.0;
        }
        let sum = match matrix.row(guess) {
            Row::U8(r) => match &mut self.lanes {
                Some(lanes) => lanes.sum_nlogn(&self.cands, r, &self.nlogn),
                None => self.sum_nlogn(|a| r[a as usize] as usize),
            },
            Row::U16(r) => self.sum_nlogn(|a| r[a as usize] as usize),
        };
        (self.log2_total - sum / self.total).max(0.0)
    }

    /// Σ c·log2(c) over buckets with c > 1, in increasing pattern order.
    #[inline(always)]
    fn sum_nlogn(&mut self, pattern: impl Fn(AnswerIdx) -> usize) -> f64 {
        for &a in &self.cands {
            let p = pattern(a);
            self.counts[p] += 1;
            self.touched[p >> 6] |= 1 << (p & 63);
        }
        let mut sum = 0.0;
        for (i, word) in self.touched.iter_mut().enumerate() {
            let mut bits = std::mem::take(word);
            while bits != 0 {
                let p = i * 64 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                let c = std::mem::take(&mut self.counts[p]);
                if c > 1 {
                    sum += self.nlogn[c as usize];
                }
            }
        }
        sum
    }
}

/// Groups guesses by the feedback they give on a candidate set.
///
/// A letter that no candidate contains is always marked absent and does not
/// change any other cell (it is never green, and it consumes no letter
/// count). So blanking such letters leaves a guess's pattern against every
/// candidate unchanged: guesses with equal [`Equivalence::key`]s have equal
/// rows over C, and so equal scores (bit for bit).
pub struct Equivalence {
    /// Letters (bit i = `b'a' + i`) that some candidate contains.
    relevant: u32,
}

impl Equivalence {
    pub fn new(list: &WordList, cands: &CandidateSet) -> Equivalence {
        let mut relevant = 0u32;
        for a in cands.iter() {
            for &b in list.letters(list.answer_word(a)) {
                relevant |= 1 << (b - b'a');
            }
        }
        Equivalence { relevant }
    }

    /// Whether grouping can merge anything (some letter is in no candidate).
    #[inline]
    pub fn useful(&self) -> bool {
        self.relevant != (1 << 26) - 1
    }

    /// The guess with irrelevant letters blanked, packed base 27 (fits a u64
    /// for up to 13 letters).
    #[inline]
    pub fn key(&self, letters: &[u8]) -> u64 {
        letters.iter().fold(0u64, |k, &b| {
            let i = b - b'a';
            k * 27 + if self.relevant >> i & 1 == 1 { i as u64 + 1 } else { 0 }
        })
    }
}

/// A cheap hasher for already well-spread u64 keys.
#[derive(Default)]
pub(crate) struct U64Hasher(u64);

impl Hasher for U64Hasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }

    #[inline]
    fn write_u64(&mut self, x: u64) {
        self.0 = (self.0.rotate_left(29) ^ x).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
}

pub(crate) type FastSet = HashSet<u64, BuildHasherDefault<U64Hasher>>;
pub(crate) type FastMap<V> = HashMap<u64, V, BuildHasherDefault<U64Hasher>>;

/// Expected information of each of `words` at `state`, identical to scoring
/// each with [`wl_core::expected_info`], computing each equivalence group once.
pub fn score_words(ctx: &Ctx, state: &State, words: &[WordId]) -> Vec<f64> {
    let mut scorer = InfoScorer::new(ctx.matrix, &state.candidates);
    let eq = (words.len() > state.candidates.len()).then(|| Equivalence::new(ctx.list, &state.candidates));
    let Some(eq) = eq.filter(Equivalence::useful) else {
        return words.iter().map(|&w| scorer.score(ctx.matrix, w)).collect();
    };
    let mut memo = FastMap::with_capacity_and_hasher(words.len(), Default::default());
    words
        .iter()
        .map(|&w| *memo.entry(eq.key(ctx.list.letters(w))).or_insert_with(|| scorer.score(ctx.matrix, w)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wl_core::{expected_info, Manifest, WordList};

    #[test]
    fn identical_to_expected_info() {
        let words = [
            "abide", "crane", "erase", "slate", "speed", "steal", "those", "trace", "eerie", "geese", "level", "allee",
            "llama", "mamma", "sassy", "abbey", "kebab", "babes", "lolly", "eagle", "there", "brass", "maxim",
        ];
        let list = WordList::from_words(Manifest::adhoc("t", 5), &words, &words).unwrap();
        let m = PatternMatrix::build(&list);
        let mut scratch = vec![0u32; m.n_patterns()];
        // Candidate sets of many sizes, including the empty set.
        for mask in [0u64, 1, 3, 0b1011_0110, 0x7f_ffff, 0x55_5555, 0x2a_aaaa] {
            let cands = CandidateSet::from_iter(words.len(), (0..words.len() as u16).filter(|&i| mask >> i & 1 == 1));
            let mut s = InfoScorer::new(&m, &cands);
            for g in 0..words.len() as WordId {
                assert_eq!(s.score(&m, g).to_bits(), expected_info(&m, g, &cands, &mut scratch).to_bits());
            }
        }
    }

    #[test]
    fn laned_kernel_identical_to_expected_info() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists/ref-en-5");
        let list = wl_core::load_dir(&dir).unwrap();
        let m = PatternMatrix::build(&list);
        let mut scratch = vec![0u32; m.n_patterns()];
        let all = CandidateSet::full(list.n_answers());
        // The full set, the large buckets of a weak opener, and sets just
        // around the laned threshold (and not a multiple of four).
        let mut sets = vec![all.clone()];
        sets.extend(m.partition(&all, list.id("fuzzy").unwrap()).into_iter().map(|(_, s)| s).filter(|s| s.len() > 20));
        for n in [LANED_MIN - 1, LANED_MIN, LANED_MIN + 1, LANED_MIN + 3, 150, 299] {
            sets.push(CandidateSet::from_iter(list.n_answers(), (0..n as AnswerIdx).map(|i| i * 7 % 300)));
        }
        assert!(sets.iter().any(|s| s.len() >= LANED_MIN) && sets.iter().any(|s| s.len() < LANED_MIN));
        for cands in &sets {
            let mut s = InfoScorer::new(&m, cands);
            assert_eq!(s.lanes.is_some(), cands.len() >= LANED_MIN);
            for g in 0..list.n_guesses() as WordId {
                let want = expected_info(&m, g, cands, &mut scratch);
                assert_eq!(s.score(&m, g).to_bits(), want.to_bits(), "{} over {}", list.word(g), cands.len());
            }
        }
    }

    #[test]
    fn laned_kernel_short_words() {
        // Every four-letter word over three letters: 81 words, mostly with
        // repeated letters, so that all 81 patterns occur.
        let words: Vec<String> =
            (0..81u32).map(|i| (0..4).map(|k| (b'a' + (i / 3u32.pow(k) % 3) as u8) as char).collect()).collect();
        let mut sorted = words.clone();
        sorted.sort();
        let list = WordList::from_words(Manifest::adhoc("t", 4), &sorted, &sorted).unwrap();
        let m = PatternMatrix::build(&list);
        let mut scratch = vec![0u32; m.n_patterns()];
        for cands in [CandidateSet::full(81), CandidateSet::from_iter(81, (0..81).filter(|a| a % 7 != 3))] {
            let mut s = InfoScorer::new(&m, &cands);
            assert!(s.lanes.is_some());
            for g in 0..81 {
                assert_eq!(s.score(&m, g).to_bits(), expected_info(&m, g, &cands, &mut scratch).to_bits());
            }
        }
    }

    #[test]
    fn equivalent_guesses_score_alike() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists/ref-en-5");
        let list = wl_core::load_dir(&dir).unwrap();
        let m = PatternMatrix::build(&list);
        let all = CandidateSet::full(list.n_answers());
        // A few small candidate sets: the buckets of two openers.
        for opener in ["slate", "build"] {
            for (_, cands) in m.partition(&all, list.id(opener).unwrap()) {
                let eq = Equivalence::new(&list, &cands);
                let mut by_key: HashMap<u64, Vec<wl_core::Pattern>> = HashMap::new();
                for g in 0..list.n_guesses() as WordId {
                    let row: Vec<_> = cands.iter().map(|a| m.get(g, a)).collect();
                    let prev = by_key.entry(eq.key(list.letters(g))).or_insert_with(|| row.clone());
                    assert_eq!(prev, &row, "{} over {} candidates", list.word(g), cands.len());
                }
            }
        }
    }
}
