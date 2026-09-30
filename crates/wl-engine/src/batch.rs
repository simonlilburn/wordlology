//! Binary game batches (docs/architecture.md, "Binary game batches").
//!
//! ```text
//! header   u32 magic 0x42474C57 ("WLGB")  u16 version = 1  u16 n_games
//! game     u16 target  u16 replicate  u8 n_turns  u8 flags (bit 0 solved)
//! turn     u16 guess  u16 pattern  u16 cands_before  u16 cands_after
//!          f32 p_chosen  f32 bits_expected  u8 phase  u8 flags (bit 0 is_candidate)
//! ```
//!
//! Everything is little-endian. A stream may hold several batches back to back.

use crate::game::{Game, Turn};
use crate::EngineError;

pub const MAGIC: u32 = 0x4247_4C57;
pub const VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 8;
pub const GAME_BYTES: usize = 6;
pub const TURN_BYTES: usize = 18;
/// Most games one batch can hold.
pub const MAX_GAMES: usize = u16::MAX as usize;

/// Encode up to [`MAX_GAMES`] games as one batch.
///
/// # Panics
/// If there are too many games, or a game has more than 255 turns or a
/// replicate above 65,535 (configurations cannot produce either).
pub fn encode_batch(games: &[Game]) -> Vec<u8> {
    assert!(games.len() <= MAX_GAMES, "too many games for one batch");
    let n_turns: usize = games.iter().map(|g| g.turns.len()).sum();
    let mut out = Vec::with_capacity(HEADER_BYTES + games.len() * GAME_BYTES + n_turns * TURN_BYTES);
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&(games.len() as u16).to_le_bytes());
    for g in games {
        encode_game(g, &mut out);
    }
    out
}

/// Encode any number of games as consecutive batches of at most [`MAX_GAMES`].
/// No games gives one empty batch.
pub fn encode_batches(games: &[Game]) -> Vec<u8> {
    if games.is_empty() {
        return encode_batch(&[]);
    }
    games.chunks(MAX_GAMES).flat_map(encode_batch).collect()
}

fn encode_game(g: &Game, out: &mut Vec<u8>) {
    let replicate = u16::try_from(g.replicate).expect("replicate fits u16");
    let n_turns = u8::try_from(g.turns.len()).expect("at most 255 turns");
    out.extend_from_slice(&g.target.to_le_bytes());
    out.extend_from_slice(&replicate.to_le_bytes());
    out.push(n_turns);
    out.push(g.solved as u8);
    for t in &g.turns {
        out.extend_from_slice(&t.guess.to_le_bytes());
        out.extend_from_slice(&t.pattern.to_le_bytes());
        out.extend_from_slice(&t.cands_before.to_le_bytes());
        out.extend_from_slice(&t.cands_after.to_le_bytes());
        out.extend_from_slice(&t.p_chosen.to_le_bytes());
        out.extend_from_slice(&t.bits_expected.to_le_bytes());
        out.push(t.phase);
        out.push(t.is_candidate as u8);
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], EngineError> {
        let end = self.pos + N;
        let s = self.bytes.get(self.pos..end).ok_or_else(|| EngineError::Batch("truncated batch".into()))?;
        self.pos = end;
        Ok(s.try_into().unwrap())
    }
    fn u8(&mut self) -> Result<u8, EngineError> {
        Ok(self.take::<1>()?[0])
    }
    fn u16(&mut self) -> Result<u16, EngineError> {
        Ok(u16::from_le_bytes(self.take()?))
    }
    fn u32(&mut self) -> Result<u32, EngineError> {
        Ok(u32::from_le_bytes(self.take()?))
    }
    fn f32(&mut self) -> Result<f32, EngineError> {
        Ok(f32::from_le_bytes(self.take()?))
    }
}

/// Decode one batch from the start of `bytes`; returns the games and the
/// number of bytes read.
pub fn decode_batch(bytes: &[u8]) -> Result<(Vec<Game>, usize), EngineError> {
    let mut r = Reader { bytes, pos: 0 };
    let magic = r.u32()?;
    if magic != MAGIC {
        return Err(EngineError::Batch(format!("bad magic {magic:#010x}")));
    }
    let version = r.u16()?;
    if version != VERSION {
        return Err(EngineError::Batch(format!("unsupported batch version {version}")));
    }
    let n = r.u16()? as usize;
    let mut games = Vec::with_capacity(n);
    for _ in 0..n {
        let target = r.u16()?;
        let replicate = r.u16()? as u32;
        let n_turns = r.u8()? as usize;
        let flags = r.u8()?;
        let mut turns = Vec::with_capacity(n_turns);
        for _ in 0..n_turns {
            turns.push(Turn {
                guess: r.u16()?,
                pattern: r.u16()?,
                cands_before: r.u16()?,
                cands_after: r.u16()?,
                p_chosen: r.f32()?,
                bits_expected: r.f32()?,
                phase: r.u8()?,
                is_candidate: r.u8()? & 1 != 0,
            });
        }
        games.push(Game { target, replicate, turns, solved: flags & 1 != 0, is_player: false });
    }
    Ok((games, r.pos))
}

/// Decode consecutive batches until the bytes run out.
pub fn decode_batches(mut bytes: &[u8]) -> Result<Vec<Game>, EngineError> {
    let mut games = Vec::new();
    while !bytes.is_empty() {
        let (g, used) = decode_batch(bytes)?;
        games.extend(g);
        bytes = &bytes[used..];
    }
    Ok(games)
}

/// The game records of consecutive batches with the headers removed, for
/// comparing streams whose batch boundaries differ.
pub fn game_records(mut bytes: &[u8]) -> Result<Vec<u8>, EngineError> {
    let mut out = Vec::with_capacity(bytes.len());
    while !bytes.is_empty() {
        let (_, used) = decode_batch(bytes)?;
        out.extend_from_slice(&bytes[HEADER_BYTES..used]);
        bytes = &bytes[used..];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<Game> {
        let t = |guess: u16, solved: bool| Turn {
            guess,
            pattern: if solved { 242 } else { 17 },
            cands_before: 2315,
            cands_after: if solved { 1 } else { 102 },
            p_chosen: 0.123_456_79,
            bits_expected: 5.87,
            phase: if guess == 3 { 255 } else { 0 },
            is_candidate: guess & 1 == 0,
        };
        vec![
            Game { target: 12, replicate: 3, turns: vec![t(3, false), t(8, true)], solved: true, is_player: false },
            Game { target: 65_000, replicate: 65_535, turns: vec![t(1, false); 6], solved: false, is_player: false },
            Game { target: 0, replicate: 0, turns: vec![], solved: false, is_player: false },
        ]
    }

    #[test]
    fn round_trip() {
        let games = sample();
        let bytes = encode_batch(&games);
        assert_eq!(bytes.len(), HEADER_BYTES + 3 * GAME_BYTES + 8 * TURN_BYTES);
        assert_eq!(&bytes[..4], b"WLGB");
        let (back, used) = decode_batch(&bytes).unwrap();
        assert_eq!(used, bytes.len());
        assert_eq!(back, games);
        // Several batches back to back.
        let mut two = bytes.clone();
        two.extend(encode_batch(&games[..1]));
        assert_eq!(decode_batches(&two).unwrap().len(), 4);
        assert_eq!(game_records(&two).unwrap().len(), two.len() - 2 * HEADER_BYTES);
        assert!(decode_batch(&bytes[..bytes.len() - 1]).is_err());
        assert!(decode_batch(b"XXXX\x01\x00\x00\x00").is_err());
    }

    #[test]
    fn layout() {
        let g = &sample()[..1];
        let b = encode_batch(g);
        // header
        assert_eq!(b[..8], [0x57, 0x4C, 0x47, 0x42, 1, 0, 1, 0]);
        // game: target 12, replicate 3, 2 turns, solved
        assert_eq!(b[8..14], [12, 0, 3, 0, 2, 1]);
        // first turn: guess 3, pattern 17, 2315, 102
        assert_eq!(b[14..22], [3, 0, 17, 0, 0x0B, 0x09, 102, 0]);
        assert_eq!(b[22..26], 0.123_456_79f32.to_le_bytes());
        assert_eq!(b[30..32], [255, 0]);
    }
}
