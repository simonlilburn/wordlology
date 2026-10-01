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
//! ones worth keeping.) Distributions are held as [`Stored`], 10 bytes an
//! entry instead of a [`Dist`]'s 16. Memory is bounded by the entry count and
//! by the total weight held. The cache only saves work: a miss recomputes the
//! same distribution, so results never depend on it (nor on the clock that
//! measures costs).

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::{Arc, OnceLock};

use rand::RngCore;
use wl_core::WordId;
use wl_strategy::{Choice, Dist, DistEntry, StateKey};

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
/// Default bound on the total weight held. A distribution weighs its number
/// of entries (10 bytes each as [`Stored`]) plus [`OVERHEAD_WEIGHT`], so this
/// is about 32 MB. Phones may run four workers, each with its own cache and
/// pattern matrix, within a 300 MB budget.
pub const DEFAULT_MAX_WEIGHT: usize = 3_200_000;
/// Weight added to every distribution for its bookkeeping (about 160 bytes).
pub const OVERHEAD_WEIGHT: usize = 16;

/// A distribution as the cache holds it: the entries of a [`Dist`] in the
/// same order, without per-entry padding. [`Stored::sample`] and
/// [`Stored::prob_of`] are exactly [`Dist::sample`] and [`Dist::prob_of`].
#[derive(Clone, Debug)]
pub struct Stored {
    words: Box<[WordId]>,
    p: Box<[f64]>,
    /// Every entry's phase, or empty when all entries have `phase`.
    phases: Box<[u8]>,
    phase: u8,
    /// Built for distributions sampled often (see [`Stored::index`]).
    index: OnceLock<Index>,
}

/// What makes sampling a long distribution logarithmic.
#[derive(Clone, Debug)]
struct Index {
    /// `cum[i] = p[0] + … + p[i]`, added left to right as [`Dist::sample`] adds them.
    cum: Box<[f64]>,
    /// Whether every word appears once (so its total probability is its `p`).
    distinct: bool,
}

impl PartialEq for Stored {
    fn eq(&self, other: &Self) -> bool {
        (&self.words, &self.p, &self.phases, self.phase) == (&other.words, &other.p, &other.phases, other.phase)
    }
}

impl Stored {
    pub fn from_dist(d: &Dist) -> Stored {
        let phase = d.entries.first().map_or(0, |e| e.phase);
        let uniform = d.entries.iter().all(|e| e.phase == phase);
        Stored {
            words: d.entries.iter().map(|e| e.word).collect(),
            p: d.entries.iter().map(|e| e.p).collect(),
            phases: if uniform { Box::default() } else { d.entries.iter().map(|e| e.phase).collect() },
            phase,
            index: OnceLock::new(),
        }
    }

    pub fn to_dist(&self) -> Dist {
        Dist { entries: (0..self.len()).map(|i| self.entry(i)).collect() }
    }

    pub fn len(&self) -> usize {
        self.words.len()
    }

    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    #[inline]
    fn entry(&self, i: usize) -> DistEntry {
        DistEntry { word: self.words[i], p: self.p[i], phase: self.phases.get(i).copied().unwrap_or(self.phase) }
    }

    /// Build the running sums that let [`Stored::sample`] binary-search
    /// instead of walking the entries (8 more bytes an entry). Results are
    /// the same either way.
    pub fn index(&self) {
        self.index.get_or_init(|| {
            let mut acc = 0.0;
            let cum = self
                .p
                .iter()
                .map(|&p| {
                    acc += p;
                    acc
                })
                .collect();
            let mut seen = vec![0u64; self.words.iter().max().map_or(0, |&w| w as usize / 64 + 1)];
            let distinct = self.words.iter().all(|&w| {
                let (word, bit) = (w as usize / 64, 1u64 << (w % 64));
                let new = seen[word] & bit == 0;
                seen[word] |= bit;
                new
            });
            Index { cum, distinct }
        });
    }

    /// Total probability of a word (as [`Dist::prob_of`]).
    pub fn prob_of(&self, word: WordId) -> f64 {
        self.words.iter().zip(self.p.iter()).filter(|(w, _)| **w == word).map(|(_, p)| *p).sum()
    }

    /// Draw one entry, exactly as [`Dist::sample`]: one `next_u64` draw, or
    /// none for a single entry.
    pub fn sample(&self, rng: &mut dyn RngCore) -> Choice {
        let index = self.index.get();
        let i = if self.len() == 1 {
            0
        } else {
            // 53 random bits -> uniform in [0, 1).
            let u = (rng.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64);
            let last = self.len().checked_sub(1).expect("empty distribution");
            match index {
                // The first entry whose running sum exceeds u, as the walk below
                // finds it: the sums never decrease.
                Some(ix) => ix.cum.partition_point(|&c| c <= u).min(last),
                None => {
                    let mut acc = 0.0;
                    let mut chosen = last;
                    for (i, &p) in self.p.iter().enumerate() {
                        acc += p;
                        if u < acc {
                            chosen = i;
                            break;
                        }
                    }
                    chosen
                }
            }
        };
        let e = self.entry(i);
        let p = match index {
            // The same sum over the one matching entry.
            Some(ix) if ix.distinct => std::iter::once(e.p).sum(),
            _ => self.prob_of(e.word),
        };
        Choice { word: e.word, p, phase: e.phase }
    }
}

/// Distributions at least this long get an [`Stored::index`] once used this often.
const INDEX_MIN_LEN: usize = 256;
const INDEX_MIN_USES: u32 = 32;

/// The smallest cost (milliseconds) an entry is given, so a coarse clock that
/// reads no time passing still ranks entries by size and use.
const MIN_COST_MS: f64 = 1e-6;

struct Entry {
    dist: Arc<Stored>,
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
        Arc::new(self.get_stored(key, compute).to_dist())
    }

    /// The distribution for `key` as the cache holds it, computing and caching it on a miss.
    pub fn get_stored(&mut self, key: StateKey, compute: impl FnOnce() -> Dist) -> Arc<Stored> {
        self.seq += 1;
        let seq = self.seq;
        if let Some(e) = self.map.get_mut(&key) {
            self.hits += 1;
            e.uses = e.uses.saturating_add(1);
            if e.uses == INDEX_MIN_USES && e.dist.len() >= INDEX_MIN_LEN {
                e.dist.index();
                // The running sums weigh about as much as the entries.
                e.weight += e.dist.len();
                self.weight += e.dist.len();
            }
            e.seq = seq;
            let priority = self.floor + e.uses as f64 * e.cost / e.weight as f64;
            let d = e.dist.clone();
            self.push(Item { priority, seq, key });
            return d;
        }
        self.misses += 1;
        let t0 = (self.clock)();
        let dist = Arc::new(Stored::from_dist(&compute()));
        let cost = ((self.clock)() - t0).max(MIN_COST_MS);
        let weight = dist.len() + OVERHEAD_WEIGHT;
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
    fn stored_samples_as_dist() {
        use rand::SeedableRng;
        use rand_chacha::ChaCha8Rng;
        let e = |word: u16, p: f64, phase: u8| DistEntry { word, p, phase };
        let dists = [
            Dist::single(7, 3),
            Dist::from_weights(&[1, 2, 3, 4], &[0.1, 0.0, 2.5, 1.0 / 3.0], 1),
            Dist::from_weights(&(0..500).collect::<Vec<_>>(), &(0..500).map(|i| (i % 7) as f64).collect::<Vec<_>>(), 0),
            // A mixture: repeated words under several phases, and a total a little under 1.
            Dist { entries: vec![e(5, 0.3, 0), e(9, 0.2, 1), e(5, 0.1, 1), e(2, 0.39999, 2), e(9, 1e-17, 0)] },
        ];
        for (d, indexed) in dists.iter().flat_map(|d| [(d, false), (d, true)]) {
            let s = Stored::from_dist(d);
            if indexed {
                s.index();
            }
            assert_eq!(&s.to_dist(), d);
            for w in 0..12 {
                assert_eq!(s.prob_of(w).to_bits(), d.prob_of(w).to_bits());
            }
            for seed in 0..300 {
                let (mut a, mut b) = (ChaCha8Rng::seed_from_u64(seed), ChaCha8Rng::seed_from_u64(seed));
                assert_eq!(s.sample(&mut a), d.sample(&mut b));
                assert_eq!(a.next_u64(), b.next_u64(), "the same number of draws");
            }
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
