//! Candidate sets: bitsets over the answer list (64 u64 words cover 4,096 answers).

use std::hash::{Hash, Hasher};

use crate::words::AnswerIdx;

#[derive(Clone, PartialEq, Eq)]
pub struct CandidateSet {
    bits: Vec<u64>,
    universe: usize,
    len: usize,
}

impl Hash for CandidateSet {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.bits.hash(state);
    }
}

impl std::fmt::Debug for CandidateSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CandidateSet({} of {})", self.len, self.universe)
    }
}

impl CandidateSet {
    /// The empty set over `universe` answers.
    pub fn empty(universe: usize) -> CandidateSet {
        CandidateSet { bits: vec![0; universe.div_ceil(64)], universe, len: 0 }
    }

    /// Every answer.
    pub fn full(universe: usize) -> CandidateSet {
        let mut s = CandidateSet::empty(universe);
        for (i, w) in s.bits.iter_mut().enumerate() {
            let lo = i * 64;
            let n = (universe - lo).min(64);
            *w = if n == 64 { u64::MAX } else { (1u64 << n) - 1 };
        }
        s.len = universe;
        s
    }

    /// A set from its bit words (bit `i` of word `w` is answer `64 w + i`),
    /// which must have no bits at or above `universe`.
    pub fn from_words(universe: usize, bits: Vec<u64>) -> CandidateSet {
        assert_eq!(bits.len(), universe.div_ceil(64), "wrong number of words for the universe");
        let tail = universe % 64;
        debug_assert!(tail == 0 || bits.last().is_none_or(|&w| w >> tail == 0), "bits beyond the universe");
        let len = bits.iter().map(|w| w.count_ones() as usize).sum();
        CandidateSet { bits, universe, len }
    }

    pub fn from_iter<I: IntoIterator<Item = AnswerIdx>>(universe: usize, items: I) -> CandidateSet {
        let mut s = CandidateSet::empty(universe);
        for a in items {
            s.insert(a);
        }
        s
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    pub fn universe(&self) -> usize {
        self.universe
    }

    #[inline]
    pub fn contains(&self, a: AnswerIdx) -> bool {
        let a = a as usize;
        a < self.universe && self.bits[a >> 6] & (1u64 << (a & 63)) != 0
    }

    #[inline]
    pub fn insert(&mut self, a: AnswerIdx) -> bool {
        let a = a as usize;
        debug_assert!(a < self.universe);
        let w = &mut self.bits[a >> 6];
        let m = 1u64 << (a & 63);
        if *w & m == 0 {
            *w |= m;
            self.len += 1;
            true
        } else {
            false
        }
    }

    #[inline]
    pub fn remove(&mut self, a: AnswerIdx) -> bool {
        let a = a as usize;
        let w = &mut self.bits[a >> 6];
        let m = 1u64 << (a & 63);
        if *w & m != 0 {
            *w &= !m;
            self.len -= 1;
            true
        } else {
            false
        }
    }

    /// The raw bit words (for hashing and serialisation).
    #[inline]
    pub fn words(&self) -> &[u64] {
        &self.bits
    }

    /// Iterate members in increasing order.
    #[inline]
    pub fn iter(&self) -> Iter<'_> {
        Iter { bits: &self.bits, word: 0, cur: self.bits.first().copied().unwrap_or(0) }
    }

    /// Smallest member.
    pub fn first(&self) -> Option<AnswerIdx> {
        self.iter().next()
    }

    pub fn intersect_with(&mut self, other: &CandidateSet) {
        let mut len = 0;
        for (a, b) in self.bits.iter_mut().zip(&other.bits) {
            *a &= *b;
            len += a.count_ones() as usize;
        }
        self.len = len;
    }

    /// A 64-bit FNV-1a style hash of the members, stable across platforms.
    pub fn hash64(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &w in &self.bits {
            h ^= w;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
            h ^= h >> 29;
        }
        h ^ self.len as u64
    }
}

pub struct Iter<'a> {
    bits: &'a [u64],
    word: usize,
    cur: u64,
}

impl Iterator for Iter<'_> {
    type Item = AnswerIdx;

    #[inline]
    fn next(&mut self) -> Option<AnswerIdx> {
        loop {
            if self.cur != 0 {
                let tz = self.cur.trailing_zeros() as usize;
                self.cur &= self.cur - 1;
                return Some((self.word * 64 + tz) as AnswerIdx);
            }
            self.word += 1;
            if self.word >= self.bits.len() {
                return None;
            }
            self.cur = self.bits[self.word];
        }
    }
}

impl<'a> IntoIterator for &'a CandidateSet {
    type Item = AnswerIdx;
    type IntoIter = Iter<'a>;
    fn into_iter(self) -> Iter<'a> {
        self.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basics() {
        let mut s = CandidateSet::full(130);
        assert_eq!(s.len(), 130);
        assert_eq!(s.iter().count(), 130);
        assert!(s.contains(129));
        assert!(!s.contains(130));
        s.remove(0);
        s.remove(64);
        assert_eq!(s.len(), 128);
        assert_eq!(s.first(), Some(1));
        let t = CandidateSet::from_iter(130, [1, 5, 64, 100]);
        s.intersect_with(&t);
        assert_eq!(s.iter().collect::<Vec<_>>(), vec![1, 5, 100]);
        assert_eq!(s.len(), 3);
        assert_ne!(s.hash64(), t.hash64());
    }
}
