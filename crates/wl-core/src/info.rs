//! Entropy and expected information.

use crate::bitset::CandidateSet;
use crate::math;
use crate::matrix::PatternMatrix;
use crate::words::WordId;

/// Entropy in bits of the distribution given by `counts` summing to `total`.
#[inline]
pub fn entropy_from_counts(counts: &[u32], total: u32) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let t = total as f64;
    let mut sum_nlogn = 0.0;
    for &c in counts {
        if c > 1 {
            let c = c as f64;
            sum_nlogn += c * math::log2(c);
        }
    }
    // H = log2(t) - (1/t) sum c log2 c
    (math::log2(t) - sum_nlogn / t).max(0.0)
}

/// Expected information (bits) from playing `guess` against candidates `cands`:
/// the entropy of its feedback distribution over the candidates.
/// `scratch` must have [`PatternMatrix::n_patterns`] entries.
#[inline]
pub fn expected_info(matrix: &PatternMatrix, guess: WordId, cands: &CandidateSet, scratch: &mut [u32]) -> f64 {
    matrix.partition_counts(guess, cands, scratch);
    entropy_from_counts(scratch, cands.len() as u32)
}

/// Observed information (bits) from narrowing `before` candidates to `after`.
#[inline]
pub fn observed_info(before: usize, after: usize) -> f64 {
    if before == 0 || after == 0 {
        return 0.0;
    }
    math::log2(before as f64 / after as f64)
}

/// Remaining uncertainty (bits) with `n` equally likely candidates.
#[inline]
pub fn remaining_bits(n: usize) -> f64 {
    if n <= 1 {
        0.0
    } else {
        math::log2(n as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entropy() {
        assert_eq!(entropy_from_counts(&[4], 4), 0.0);
        assert!((entropy_from_counts(&[1, 1, 1, 1], 4) - 2.0).abs() < 1e-12);
        assert!((entropy_from_counts(&[2, 2], 4) - 1.0).abs() < 1e-12);
        assert!((observed_info(8, 2) - 2.0).abs() < 1e-12);
    }
}
