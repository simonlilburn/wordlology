//! A bounded memo of guess distributions keyed by [`StateKey`].
//!
//! Eviction is cost-aware (GreedyDual-Size-Frequency): each entry has the
//! priority `L + uses · cost / weight`, where `cost` is the time its
//! distribution took to compute, `weight` its number of entries and `L` the
//! priority of the last entry evicted; the lowest priority goes first. So
//! distributions that were costly to compute, per byte held, and those used
//! often stay longest, and entries not used for a while age out as `L`
//! rises. (Information-based strategies over the candidates cost |C|² to
//! compute but hold |C| entries, so the large states they revisit are the
//! ones worth keeping.) Memory is bounded by the entry count and by the total
//! number of distribution entries held. The cache only saves work: a miss
//! recomputes the same distribution, so results never depend on it (nor on
//! the clock that measures costs).

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;

use wl_strategy::{Dist, StateKey};

use crate::run::default_clock;

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
/// Default bound on the total number of distribution entries held (16 bytes
/// each, so 32 MB). Phones may run four workers, each with its own cache and
/// pattern matrix, within a 300 MB budget.
pub const DEFAULT_MAX_WEIGHT: usize = 2_000_000;

/// The smallest cost (milliseconds) an entry is given, so a coarse clock that
/// reads no time passing still ranks entries by size and use.
const MIN_COST_MS: f64 = 1e-6;

struct Entry {
    dist: Arc<Dist>,
    /// Milliseconds the distribution took to compute.
    cost: f64,
    weight: usize,
    uses: u32,
    /// Sequence number of this entry's live item in the eviction heap.
    seq: u64,
}

/// An item of the eviction heap; stale once its entry has a newer `seq`.
struct Item {
    priority: f64,
    seq: u64,
    key: StateKey,
}

impl PartialEq for Item {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Item {}

impl PartialOrd for Item {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Item {
    fn cmp(&self, other: &Self) -> Ordering {
        self.priority.total_cmp(&other.priority).then(self.seq.cmp(&other.seq))
    }
}

pub struct DistCache {
    map: KeyMap<Entry>,
    /// Min-heap of priorities, with stale items skipped lazily.
    heap: BinaryHeap<Reverse<Item>>,
    /// GreedyDual's `L`: the priority of the last eviction.
    floor: f64,
    weight: usize,
    seq: u64,
    max_entries: usize,
    max_weight: usize,
    hits: u64,
    misses: u64,
    clock: fn() -> f64,
}

impl Default for DistCache {
    fn default() -> Self {
        DistCache::new(DEFAULT_MAX_ENTRIES, DEFAULT_MAX_WEIGHT)
    }
}

impl DistCache {
    pub fn new(max_entries: usize, max_weight: usize) -> DistCache {
        DistCache {
            map: KeyMap::default(),
            heap: BinaryHeap::new(),
            floor: 0.0,
            weight: 0,
            seq: 0,
            max_entries: max_entries.max(2),
            max_weight: max_weight.max(2),
            hits: 0,
            misses: 0,
            clock: default_clock,
        }
    }

    /// Measure computation costs with another clock (milliseconds).
    pub fn set_clock(&mut self, clock: fn() -> f64) {
        self.clock = clock;
    }

    /// The distribution for `key`, computing and caching it on a miss.
    pub fn get_or_insert_with(&mut self, key: StateKey, compute: impl FnOnce() -> Dist) -> Arc<Dist> {
        self.seq += 1;
        let seq = self.seq;
        if let Some(e) = self.map.get_mut(&key) {
            self.hits += 1;
            e.uses = e.uses.saturating_add(1);
            e.seq = seq;
            let priority = self.floor + e.uses as f64 * e.cost / e.weight as f64;
            let d = e.dist.clone();
            self.push(Item { priority, seq, key });
            return d;
        }
        self.misses += 1;
        let t0 = (self.clock)();
        let dist = Arc::new(compute());
        let cost = ((self.clock)() - t0).max(MIN_COST_MS);
        let weight = dist.entries.len().max(1);
        while !self.map.is_empty() && (self.map.len() + 1 > self.max_entries || self.weight + weight > self.max_weight)
        {
            self.evict();
        }
        self.weight += weight;
        let priority = self.floor + cost / weight as f64;
        self.map.insert(key, Entry { dist: dist.clone(), cost, weight, uses: 1, seq });
        self.push(Item { priority, seq, key });
        dist
    }

    fn push(&mut self, item: Item) {
        self.heap.push(Reverse(item));
        // Hits leave stale items behind; rebuild once they outnumber the live ones.
        if self.heap.len() > 2 * self.map.len() + 64 {
            let map = &self.map;
            self.heap.retain(|Reverse(i)| map.get(&i.key).is_some_and(|e| e.seq == i.seq));
        }
    }

    /// Drop the entry with the lowest priority.
    fn evict(&mut self) {
        while let Some(Reverse(item)) = self.heap.pop() {
            if self.map.get(&item.key).is_some_and(|e| e.seq == item.seq) {
                let e = self.map.remove(&item.key).expect("live entry");
                self.weight -= e.weight;
                self.floor = item.priority;
                return;
            }
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
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
        self.map = KeyMap::default();
        self.heap = BinaryHeap::new();
        self.weight = 0;
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

    thread_local! {
        static NOW: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    }

    fn fake_clock() -> f64 {
        NOW.with(|n| n.get())
    }

    /// A distribution of `n` entries that takes `ms` to compute on the fake clock.
    fn costly(n: u16, ms: f64) -> impl FnOnce() -> Dist {
        move || {
            NOW.with(|t| t.set(t.get() + ms));
            Dist::from_weights(&(0..n).collect::<Vec<_>>(), &vec![1.0; n as usize], 0)
        }
    }

    #[test]
    fn keeps_costly_distributions() {
        let mut c = DistCache::new(1000, 100);
        c.set_clock(fake_clock);
        c.get_or_insert_with(StateKey(0, 0), costly(10, 50.0));
        for i in 1..200u64 {
            c.get_or_insert_with(StateKey(i, 0), costly(10, 0.01));
            assert!(c.weight <= 100 && c.len() <= 10);
        }
        // The costly entry survived 199 cheap ones.
        c.get_or_insert_with(StateKey(0, 0), || unreachable!());
        // Cheap entries age out: the oldest are gone, the newest are held.
        let mut recomputed = false;
        c.get_or_insert_with(StateKey(1, 0), || {
            recomputed = true;
            Dist::single(1, 0)
        });
        assert!(recomputed);
        c.get_or_insert_with(StateKey(199, 0), || unreachable!());
        // A distribution larger than the whole budget is still returned (and held alone).
        let d = c.get_or_insert_with(StateKey(500, 0), costly(150, 1.0));
        assert_eq!(d.entries.len(), 150);
        assert_eq!(c.len(), 1);
        c.clear();
        assert!(c.is_empty());
    }
}
