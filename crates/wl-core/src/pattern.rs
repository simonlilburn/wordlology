//! Feedback patterns.
//!
//! A pattern is coded as the sum of `c_i * 3^i`, with `c = 0` absent, `1`
//! present and `2` correct. Greens are marked first, then yellows left to right
//! against the remaining letter counts. Words of up to 7 letters fit in a u16.

use std::fmt;

/// Longest word the engine supports (3^7 = 2187 patterns fits a u16).
pub const MAX_WORD_LEN: usize = 7;
/// Shortest word the engine supports.
pub const MIN_WORD_LEN: usize = 4;

pub const ABSENT: u8 = 0;
pub const PRESENT: u8 = 1;
pub const CORRECT: u8 = 2;

const POW3: [u16; MAX_WORD_LEN + 1] = [1, 3, 9, 27, 81, 243, 729, 2187];

/// Number of distinct patterns for words of length `len` (3^len).
#[inline]
pub fn n_patterns(len: usize) -> usize {
    POW3[len] as usize
}

/// A feedback pattern for one guess against one target.
#[derive(Copy, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct Pattern(pub u16);

impl Pattern {
    /// The all-correct pattern for words of length `len`.
    #[inline]
    pub fn all_correct(len: usize) -> Pattern {
        Pattern(POW3[len] - 1)
    }

    #[inline]
    pub fn is_all_correct(self, len: usize) -> bool {
        self.0 == POW3[len] - 1
    }

    /// Cell `i`: 0 absent, 1 present, 2 correct.
    #[inline]
    pub fn cell(self, i: usize) -> u8 {
        ((self.0 / POW3[i]) % 3) as u8
    }

    /// Cells for a word of length `len`.
    pub fn cells(self, len: usize) -> Vec<u8> {
        (0..len).map(|i| self.cell(i)).collect()
    }

    pub fn from_cells(cells: &[u8]) -> Pattern {
        let mut code = 0u16;
        for (i, &c) in cells.iter().enumerate() {
            debug_assert!(c <= 2);
            code += c as u16 * POW3[i];
        }
        Pattern(code)
    }

    /// Spell the pattern with `g` (correct), `y` (present) and `b` (absent).
    pub fn to_letters(self, len: usize) -> String {
        (0..len)
            .map(|i| match self.cell(i) {
                CORRECT => 'g',
                PRESENT => 'y',
                _ => 'b',
            })
            .collect()
    }

    /// Parse a `g`/`y`/`b` spelling (case-insensitive).
    pub fn from_letters(s: &str) -> Option<Pattern> {
        let cells: Option<Vec<u8>> = s
            .chars()
            .map(|c| match c.to_ascii_lowercase() {
                'g' => Some(CORRECT),
                'y' => Some(PRESENT),
                'b' => Some(ABSENT),
                _ => None,
            })
            .collect();
        let cells = cells?;
        if cells.is_empty() || cells.len() > MAX_WORD_LEN {
            return None;
        }
        Some(Pattern::from_cells(&cells))
    }

    /// Number of correct cells.
    pub fn n_correct(self, len: usize) -> usize {
        (0..len).filter(|&i| self.cell(i) == CORRECT).count()
    }
}

impl fmt::Debug for Pattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Pattern({})", self.0)
    }
}

/// Feedback for `guess` against `target`. Both are lowercase letter codes
/// (`b'a'..=b'z'` or `0..26`, as long as both use the same encoding) of equal length.
#[inline]
pub fn feedback(guess: &[u8], target: &[u8]) -> Pattern {
    let len = guess.len();
    debug_assert_eq!(len, target.len());
    debug_assert!(len <= MAX_WORD_LEN);
    let mut counts = [0u8; 32];
    let mut code = 0u16;
    let mut green = 0u8; // bitmask of green positions
    for i in 0..len {
        if guess[i] == target[i] {
            code += 2 * POW3[i];
            green |= 1 << i;
        } else {
            counts[(target[i] & 31) as usize] += 1;
        }
    }
    for i in 0..len {
        if green & (1 << i) != 0 {
            continue;
        }
        let c = &mut counts[(guess[i] & 31) as usize];
        if *c > 0 {
            *c -= 1;
            code += POW3[i];
        }
    }
    Pattern(code)
}

/// Convenience wrapper for string words.
pub fn feedback_str(guess: &str, target: &str) -> Pattern {
    feedback(guess.as_bytes(), target.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fb(g: &str, t: &str) -> String {
        feedback_str(g, t).to_letters(g.len())
    }

    #[test]
    fn spec_example() {
        // SPEED against ABIDE: absent, absent, present, absent, present.
        assert_eq!(fb("speed", "abide"), "bbyby");
    }

    #[test]
    fn duplicate_letter_vectors() {
        let cases = [
            ("speed", "abide", "bbyby"),
            ("speed", "erase", "ybyyb"),
            ("speed", "steal", "gbgbb"),
            ("speed", "crepe", "bygyb"),
            ("abbey", "kebab", "yygyb"),
            ("abbey", "babes", "yyggb"),
            ("lolly", "level", "gbybb"),
            ("allee", "eagle", "yybyg"),
            ("geese", "those", "bbbgg"),
            ("eerie", "there", "ybybg"),
            ("sassy", "brass", "yybgb"),
            ("mamma", "maxim", "ggybb"),
            ("crane", "crane", "ggggg"),
            ("xxxxx", "crane", "bbbbb"),
        ];
        for (g, t, want) in cases {
            assert_eq!(fb(g, t), want, "{g} vs {t}");
        }
    }

    #[test]
    fn letters_round_trip() {
        for code in 0..243u16 {
            let p = Pattern(code);
            assert_eq!(Pattern::from_letters(&p.to_letters(5)), Some(p));
        }
        assert_eq!(Pattern::all_correct(5).to_letters(5), "ggggg");
        assert!(Pattern(242).is_all_correct(5));
    }
}

#[cfg(test)]
mod vector_tests {
    use super::*;

    #[test]
    fn shared_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/testvectors/feedback.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() > 300);
        for c in cases {
            let (g, t) = (c["guess"].as_str().unwrap(), c["target"].as_str().unwrap());
            let p = feedback_str(g, t);
            assert_eq!(p.0 as u64, c["code"].as_u64().unwrap(), "{g} vs {t}");
            assert_eq!(p.to_letters(g.len()), c["letters"].as_str().unwrap());
        }
    }
}
