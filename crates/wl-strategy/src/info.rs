//! Fast expected-information scoring of many guesses against one candidate set.
//!
//! [`InfoScorer::score`] returns exactly (bit for bit) what
//! [`wl_core::expected_info`] returns: it adds the same `c · log2 c` terms
//! (through [`wl_core::math`]) in the same increasing pattern order and
//! finishes with the same `log2 t − Σ / t`. It is faster because it
//!
//! - collects the candidates' answer indices once instead of walking the
//!   bitset for every guess,
//! - looks `c · log2 c` up in a table built once per state,
//! - counts in `u16` and resets only what it touched, and
//! - for small candidate sets visits only the touched patterns (sorted, so
//!   the summation order is unchanged) instead of all 3^L buckets.

use wl_core::{math, AnswerIdx, CandidateSet, PatternMatrix, Row, WordId};

/// Below this many candidates, entropy sums visit only touched patterns.
const SPARSE_MAX: usize = 48;

/// Scores guesses against one candidate set. Build one per state.
pub struct InfoScorer {
    cands: Vec<AnswerIdx>,
    total: f64,
    log2_total: f64,
    /// `nlogn[c] = c · log2 c`, as `wl_core::entropy_from_counts` computes it.
    nlogn: Vec<f64>,
    counts: Vec<u16>,
    touched: Vec<u16>,
}

impl InfoScorer {
    pub fn new(matrix: &PatternMatrix, cands: &CandidateSet) -> InfoScorer {
        let t = cands.len();
        assert!(t <= u16::MAX as usize, "too many candidates for u16 counts");
        let nlogn = (0..=t)
            .map(|c| {
                let c = c as f64;
                c * math::log2(c)
            })
            .collect();
        InfoScorer {
            cands: cands.iter().collect(),
            total: t as f64,
            log2_total: if t == 0 { 0.0 } else { math::log2(t as f64) },
            nlogn,
            // At least 256 buckets so a u8 pattern can index without a bounds check.
            counts: vec![0; matrix.n_patterns().max(256)],
            touched: Vec::with_capacity(t),
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
            Row::U8(r) => self.sum_nlogn(|a| r[a as usize] as usize),
            Row::U16(r) => self.sum_nlogn(|a| r[a as usize] as usize),
        };
        (self.log2_total - sum / self.total).max(0.0)
    }

    /// Σ c·log2(c) over buckets with c > 1, in increasing pattern order.
    #[inline(always)]
    fn sum_nlogn(&mut self, pattern: impl Fn(AnswerIdx) -> usize) -> f64 {
        let mut sum = 0.0;
        if self.cands.len() <= SPARSE_MAX {
            for &a in &self.cands {
                let p = pattern(a);
                if self.counts[p] == 0 {
                    self.touched.push(p as u16);
                }
                self.counts[p] += 1;
            }
            self.touched.sort_unstable();
            for &p in &self.touched {
                let c = std::mem::take(&mut self.counts[p as usize]);
                if c > 1 {
                    sum += self.nlogn[c as usize];
                }
            }
            self.touched.clear();
        } else {
            for &a in &self.cands {
                self.counts[pattern(a)] += 1;
            }
            for c in self.counts.iter_mut() {
                if *c > 1 {
                    sum += self.nlogn[*c as usize];
                }
                *c = 0;
            }
        }
        sum
    }
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
        // Candidate sets of every size, including the dense path's.
        for mask in [0u64, 1, 3, 0b1011_0110, 0x7f_ffff, 0x55_5555, 0x2a_aaaa] {
            let cands = CandidateSet::from_iter(words.len(), (0..words.len() as u16).filter(|&i| mask >> i & 1 == 1));
            let mut s = InfoScorer::new(&m, &cands);
            for g in 0..words.len() as WordId {
                assert_eq!(s.score(&m, g).to_bits(), expected_info(&m, g, &cands, &mut scratch).to_bits());
            }
        }
    }
}
