//! Random streams: one ChaCha8 stream per (target, replicate), and the seeded
//! target order of stochastic runs. See docs/architecture.md, "Playing a game".

use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;
use wl_core::AnswerIdx;

/// The 32-byte seed of the stream for one game:
/// `BLAKE3("wordlology/rng/v1\0" ‖ base_seed (u64 LE) ‖ strategy canonical JSON
/// ‖ "\0" ‖ opener or "" ‖ "\0" ‖ target word ‖ "\0" ‖ replicate (u32 LE))`.
///
/// Keying on words (not indices) keeps a target's stream across answer selections.
pub fn game_seed(base_seed: u64, strategy_json: &str, opener: Option<&str>, target: &str, replicate: u32) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"wordlology/rng/v1\0");
    h.update(&base_seed.to_le_bytes());
    h.update(strategy_json.as_bytes());
    h.update(b"\0");
    h.update(opener.unwrap_or("").as_bytes());
    h.update(b"\0");
    h.update(target.as_bytes());
    h.update(b"\0");
    h.update(&replicate.to_le_bytes());
    *h.finalize().as_bytes()
}

/// The stream for one game.
pub fn game_rng(base_seed: u64, strategy_json: &str, opener: Option<&str>, target: &str, replicate: u32) -> ChaCha8Rng {
    ChaCha8Rng::from_seed(game_seed(base_seed, strategy_json, opener, target, replicate))
}

/// The 32-byte seed of the target order:
/// `BLAKE3("wordlology/order/v1\0" ‖ base_seed (u64 LE) ‖ strategy canonical JSON ‖ "\0" ‖ opener or "")`.
pub fn order_seed(base_seed: u64, strategy_json: &str, opener: Option<&str>) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"wordlology/order/v1\0");
    h.update(&base_seed.to_le_bytes());
    h.update(strategy_json.as_bytes());
    h.update(b"\0");
    h.update(opener.unwrap_or("").as_bytes());
    *h.finalize().as_bytes()
}

/// A seeded permutation of `0..n` (Fisher–Yates). For `i` from `n − 1` down
/// to 1, one `next_u64` draw `x` picks `j = ⌊x · (i + 1) / 2^64⌋` (a
/// multiply-high, bias below 2^-50) and swaps positions `i` and `j`.
pub fn permutation(n: usize, seed: [u8; 32]) -> Vec<AnswerIdx> {
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut v: Vec<AnswerIdx> = (0..n).map(|i| i as AnswerIdx).collect();
    for i in (1..n).rev() {
        let j = ((rng.next_u64() as u128 * (i as u128 + 1)) >> 64) as usize;
        v.swap(i, j);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permutation_is_a_permutation() {
        let seed = order_seed(1, "{}", None);
        let p = permutation(1000, seed);
        let mut s = p.clone();
        s.sort_unstable();
        assert_eq!(s, (0..1000).collect::<Vec<AnswerIdx>>());
        assert_ne!(p, s, "shuffled");
        assert_eq!(p, permutation(1000, seed), "reproducible");
        assert_ne!(p, permutation(1000, order_seed(2, "{}", None)));
        assert_eq!(permutation(0, seed), Vec::<AnswerIdx>::new());
        assert_eq!(permutation(1, seed), vec![0]);
    }

    #[test]
    fn seeds_depend_on_every_part() {
        let base = game_seed(1, "{\"kind\":\"random\"}", Some("crane"), "slate", 0);
        assert_ne!(base, game_seed(2, "{\"kind\":\"random\"}", Some("crane"), "slate", 0));
        assert_ne!(base, game_seed(1, "{\"kind\":\"max_info\"}", Some("crane"), "slate", 0));
        assert_ne!(base, game_seed(1, "{\"kind\":\"random\"}", None, "slate", 0));
        assert_ne!(base, game_seed(1, "{\"kind\":\"random\"}", Some("crane"), "trace", 0));
        assert_ne!(base, game_seed(1, "{\"kind\":\"random\"}", Some("crane"), "slate", 1));
        // The documented byte layout.
        let mut bytes = b"wordlology/rng/v1\0".to_vec();
        bytes.extend_from_slice(&1u64.to_le_bytes());
        bytes.extend_from_slice(b"{\"kind\":\"random\"}\0crane\0slate\0");
        bytes.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(base, *blake3::hash(&bytes).as_bytes());
    }
}
