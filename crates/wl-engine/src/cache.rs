//! A bounded memo of guess distributions keyed by [`StateKey`].
//!
//! It is a two-generation approximation of LRU: lookups check the current
//! generation, then the previous one (promoting hits); when the current
//! generation reaches half the budget it becomes the previous one and the old
//! previous generation is dropped. Memory is bounded by the entry count and by
//! the total number of distribution entries held. The cache only saves work:
//! a miss recomputes the same distribution, so results never depend on it.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;

use wl_strategy::{Dist, StateKey};

/// `StateKey` is already a hash, so the map hasher just mixes its words.
#[derive(Default)]
pub struct KeyHasher(u64);

impl Hasher for KeyHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }

    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        }
    }

    #[inline]
    fn write_u64(&mut self, x: u64) {
        self.0 = (self.0.rotate_left(29) ^ x).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
}

type KeyMap<V> = HashMap<StateKey, V, BuildHasherDefault<KeyHasher>>;

/// Default bound on cached distributions.
pub const DEFAULT_MAX_ENTRIES: usize = 100_000;
/// Default bound on the total number of distribution entries held (about
/// 16 bytes each, so 64 MB).
pub const DEFAULT_MAX_WEIGHT: usize = 4_000_000;

pub struct DistCache {
    current: KeyMap<Arc<Dist>>,
    previous: KeyMap<Arc<Dist>>,
    current_weight: usize,
    max_entries: usize,
    max_weight: usize,
    hits: u64,
    misses: u64,
}

impl Default for DistCache {
    fn default() -> Self {
        DistCache::new(DEFAULT_MAX_ENTRIES, DEFAULT_MAX_WEIGHT)
    }
}

impl DistCache {
    pub fn new(max_entries: usize, max_weight: usize) -> DistCache {
        DistCache {
            current: KeyMap::default(),
            previous: KeyMap::default(),
            current_weight: 0,
            max_entries: max_entries.max(2),
            max_weight: max_weight.max(2),
            hits: 0,
            misses: 0,
        }
    }

    /// The distribution for `key`, computing and caching it on a miss.
    pub fn get_or_insert_with(&mut self, key: StateKey, compute: impl FnOnce() -> Dist) -> Arc<Dist> {
        if let Some(d) = self.current.get(&key) {
            self.hits += 1;
            return d.clone();
        }
        if let Some(d) = self.previous.remove(&key) {
            self.hits += 1;
            self.insert(key, d.clone());
            return d;
        }
        self.misses += 1;
        let d = Arc::new(compute());
        self.insert(key, d.clone());
        d
    }

    fn insert(&mut self, key: StateKey, d: Arc<Dist>) {
        let w = d.entries.len().max(1);
        if self.current.len() + 1 > self.max_entries / 2 || self.current_weight + w > self.max_weight / 2 {
            self.previous = std::mem::take(&mut self.current);
            self.current_weight = 0;
        }
        self.current_weight += w;
        self.current.insert(key, d);
    }

    pub fn len(&self) -> usize {
        self.current.len() + self.previous.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// (hits, misses) so far.
    pub fn stats(&self) -> (u64, u64) {
        (self.hits, self.misses)
    }

    /// Drop everything (frees memory once a run is finished).
    pub fn clear(&mut self) {
        self.current = KeyMap::default();
        self.previous = KeyMap::default();
        self.current_weight = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_and_memoising() {
        let mut c = DistCache::new(10, 1000);
        let mut computed = 0;
        for i in 0..100u64 {
            c.get_or_insert_with(StateKey(i, 0), || {
                computed += 1;
                Dist::single(i as u16, 0)
            });
            assert!(c.len() <= 10);
        }
        assert_eq!(computed, 100);
        // The most recent keys are still cached.
        let d = c.get_or_insert_with(StateKey(99, 0), || unreachable!());
        assert_eq!(d.entries[0].word, 99);
        assert_eq!(c.stats().0, 1);
    }
}
