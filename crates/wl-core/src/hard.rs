//! Hard mode: any revealed hint must be used in later guesses.
//!
//! Correct letters must stay in place, and every letter revealed as present or
//! correct must appear in the guess at least as many times as it was revealed.

use crate::pattern::{Pattern, CORRECT, PRESENT};
use crate::words::{WordId, WordList};

/// Whether `guess` respects every hint revealed by `history`.
pub fn hard_mode_ok(list: &WordList, guess: WordId, history: &[(WordId, Pattern)]) -> bool {
    let g = list.letters(guess);
    let len = g.len();
    let mut have = [0u8; 32];
    for &b in g {
        have[(b & 31) as usize] += 1;
    }
    for &(prev, pat) in history {
        let p = list.letters(prev);
        let mut need = [0u8; 32];
        for i in 0..len {
            match pat.cell(i) {
                CORRECT => {
                    if g[i] != p[i] {
                        return false;
                    }
                    need[(p[i] & 31) as usize] += 1;
                }
                PRESENT => need[(p[i] & 31) as usize] += 1,
                _ => {}
            }
        }
        if need.iter().zip(&have).any(|(n, h)| n > h) {
            return false;
        }
    }
    true
}

/// The first hard-mode violation, described for the player, or `None` if the guess is valid.
pub fn hard_mode_violation(list: &WordList, guess: WordId, history: &[(WordId, Pattern)]) -> Option<String> {
    let g = list.letters(guess);
    let len = g.len();
    for &(prev, pat) in history {
        let p = list.letters(prev);
        for i in 0..len {
            if pat.cell(i) == CORRECT && g[i] != p[i] {
                return Some(format!("letter {} must be {}", i + 1, (p[i] as char).to_ascii_uppercase()));
            }
        }
        for i in 0..len {
            let c = pat.cell(i);
            if c == CORRECT || c == PRESENT {
                let letter = p[i];
                let need = (0..len)
                    .filter(|&j| p[j] == letter && matches!(pat.cell(j), CORRECT | PRESENT))
                    .count();
                let have = g.iter().filter(|&&b| b == letter).count();
                if have < need {
                    return Some(format!("guess must contain {}", (letter as char).to_ascii_uppercase()));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pattern::feedback_str;
    use crate::words::Manifest;

    #[test]
    fn rules() {
        let words = ["crane", "crate", "trace", "slate", "caret", "react"];
        let l = WordList::from_words(Manifest::adhoc("h", 5), &words, &words).unwrap();
        let id = |w: &str| l.id(w).unwrap();
        // Target "crate", opener "trace": T C present, R A E correct.
        let hist = vec![(id("trace"), feedback_str("trace", "crate"))];
        assert!(hard_mode_ok(&l, id("crate"), &hist));
        assert_eq!(hist[0].1.to_letters(5), "yggyg");
        // "caret" has A, not R, in second place.
        assert!(!hard_mode_ok(&l, id("caret"), &hist));
        assert!(!hard_mode_ok(&l, id("slate"), &hist));
        assert!(hard_mode_violation(&l, id("slate"), &hist).is_some());
        assert!(hard_mode_violation(&l, id("crate"), &hist).is_none());
    }
}
