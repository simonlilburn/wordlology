//! Letter filters: match guesses by letters in positions.
//!
//! A filter is one or more [`Rule`]s combined with All or Any, plus a scope
//! (which guess numbers it applies to, and whether the final solving guess
//! counts). A rule has one [`Slot`] per letter position plus extra conditions:
//! contains a letter, excludes a letter, has a repeated letter.
//!
//! Text form (case-insensitive; see docs/architecture.md, "Letter filter"):
//!
//! ```text
//! rule    := slot{L} extra*          L = word length
//! slot    := '?'                     any letter
//!          | letter                  that letter
//!          | '[' letters ']'         any of a set
//!          | '{v}' | '{c}'           vowel / consonant class
//!          | '[^' letters ']'        none of a set
//!          | '{^v}' | '{^c}'         not a vowel / not a consonant
//!          | '!' letter              not that letter
//! extra   := '+' letter              contains the letter anywhere
//!          | '-' letter              excludes the letter
//!          | '*'                     has a repeated letter
//! filter  := rule (' | ' rule)*
//! ```
//!
//! Whitespace may separate slots and extras. A set needs at least one letter
//! in text; in the structure (which the builder edits) an empty set, negated
//! or not, and a negated `?` constrain nothing: they match any letter and
//! format as `?`. This mirrors web/src/model/filter.ts.
//!
//! [`format_rule`] gives the canonical text: uppercase letters, lowercase
//! classes, sets sorted and deduplicated (a one-letter set is written as the
//! letter, `[^S]` as `!S`), then the extras in the order `+` (sorted), `-`
//! (sorted), `*`, each preceded by one space. For example `?A??Y +E -S`.
//!
//! The JSON form of a rule matches `FilterRule` in web/src/model/filter.ts,
//! with lowercase letters:
//!
//! ```json
//! { "slots": [ { "negate": false, "value": { "kind": "any" } },
//!              { "negate": false, "value": { "kind": "letter", "letter": "a" } },
//!              { "negate": true,  "value": { "kind": "set", "letters": "ae" } },
//!              { "negate": false, "value": { "kind": "class", "class": "vowel" } }, ... ],
//!   "contains": ["e"], "excludes": ["s"], "repeated": false }
//! ```

use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A letter class. Vowels are `aeiou`, plus `y` when "Y counts as a vowel"
/// is on; consonants are the other letters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LetterClass {
    Vowel,
    Consonant,
}

/// What a slot accepts before negation.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SlotValue {
    /// Any letter.
    Any,
    /// One letter (lowercase).
    Letter { letter: char },
    /// Any letter of a set (lowercase letters, e.g. `"ae"`). An empty set
    /// constrains nothing, negated or not.
    Set { letters: String },
    /// A vowel or a consonant.
    Class { class: LetterClass },
}

/// One letter position of a rule.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Slot {
    /// Accept exactly the letters that `value` does not. Ignored for `any`
    /// and an empty set, which always match any letter.
    #[serde(default)]
    pub negate: bool,
    pub value: SlotValue,
}

/// A rule: one slot per letter position plus extra conditions.
/// (`FilterRule` in the TypeScript model.)
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Rule {
    pub slots: Vec<Slot>,
    /// Letters the word must contain somewhere.
    #[serde(default)]
    pub contains: Vec<char>,
    /// Letters the word must not contain.
    #[serde(default)]
    pub excludes: Vec<char>,
    /// The word must have a repeated letter.
    #[serde(default)]
    pub repeated: bool,
}

/// The name used by the TypeScript model.
pub type FilterRule = Rule;

/// How several rules combine.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Combine {
    /// Every rule must match.
    #[default]
    All,
    /// At least one rule must match.
    Any,
}

/// A parse error: a message and the character index (0-based) in the input
/// where the problem starts.
#[derive(Clone, Debug, PartialEq, Eq, Error, Serialize)]
#[error("{message} (at {at})")]
pub struct ParseError {
    pub message: String,
    pub at: usize,
}

fn err<T>(at: usize, message: impl Into<String>) -> Result<T, ParseError> {
    Err(ParseError { message: message.into(), at })
}

// ---------------------------------------------------------------------------
// Letter masks: bit i is letter b'a' + i.

const ALL: u32 = (1 << 26) - 1;
const VOWELS: u32 = bit(b'a') | bit(b'e') | bit(b'i') | bit(b'o') | bit(b'u');
const Y: u32 = bit(b'y');

const fn bit(lower: u8) -> u32 {
    1 << (lower - b'a')
}

/// The mask bit of a letter (either case); 0 for anything else.
#[inline]
fn letter_bit(c: char) -> u32 {
    if c.is_ascii_alphabetic() {
        bit(c.to_ascii_lowercase() as u8)
    } else {
        0
    }
}

fn mask_of(letters: impl IntoIterator<Item = char>) -> u32 {
    letters.into_iter().fold(0, |m, c| m | letter_bit(c))
}

/// Letters of a mask in alphabetical order.
fn letters_of(mask: u32) -> impl Iterator<Item = char> {
    (0..26u8).filter(move |i| mask & (1 << i) != 0).map(|i| (b'a' + i) as char)
}

fn vowel_mask(y_vowel: bool) -> u32 {
    if y_vowel {
        VOWELS | Y
    } else {
        VOWELS
    }
}


impl Slot {
    pub const ANY: Slot = Slot { negate: false, value: SlotValue::Any };

    pub fn letter(c: char) -> Slot {
        Slot { negate: false, value: SlotValue::Letter { letter: c.to_ascii_lowercase() } }
    }

    /// The letters this slot accepts, as a mask.
    fn mask(&self, y_vowel: bool) -> u32 {
        let m = match &self.value {
            SlotValue::Any => return ALL,
            SlotValue::Letter { letter } => letter_bit(*letter),
            SlotValue::Set { letters } => match mask_of(letters.chars()) {
                0 => return ALL,
                m => m,
            },
            SlotValue::Class { class: LetterClass::Vowel } => vowel_mask(y_vowel),
            SlotValue::Class { class: LetterClass::Consonant } => ALL & !vowel_mask(y_vowel),
        };
        if self.negate {
            ALL & !m
        } else {
            m
        }
    }

    /// Whether the slot accepts a letter (either case).
    pub fn accepts(&self, c: char, y_vowel: bool) -> bool {
        self.mask(y_vowel) & letter_bit(c) != 0
    }

    /// The canonical form of this slot: letters lowercase, sets sorted and
    /// deduplicated, a one-letter set as the letter, and an empty set or a
    /// negated `?` as a plain `?`. Normalising never changes which letters
    /// match (letters must be `a`–`z`, in either case).
    pub fn normalized(&self) -> Slot {
        let negate = self.negate;
        match &self.value {
            SlotValue::Any => Slot::ANY,
            SlotValue::Letter { letter } => Slot { negate, value: SlotValue::Letter { letter: letter.to_ascii_lowercase() } },
            SlotValue::Set { letters } => {
                let m = mask_of(letters.chars());
                match m.count_ones() {
                    0 => Slot::ANY,
                    1 => Slot { negate, value: SlotValue::Letter { letter: letters_of(m).next().unwrap() } },
                    _ => Slot { negate, value: SlotValue::Set { letters: letters_of(m).collect() } },
                }
            }
            SlotValue::Class { class } => Slot { negate, value: SlotValue::Class { class: *class } },
        }
    }
}

impl fmt::Display for Slot {
    /// Canonical text of the slot (normalised first).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = self.normalized();
        let upper = |c: &char| c.to_ascii_uppercase();
        match (&s.value, s.negate) {
            (SlotValue::Any, _) => f.write_str("?"),
            (SlotValue::Letter { letter }, false) => write!(f, "{}", upper(letter)),
            (SlotValue::Letter { letter }, true) => write!(f, "!{}", upper(letter)),
            (SlotValue::Set { letters }, neg) => {
                let body: String = letters.chars().map(|c| upper(&c)).collect();
                write!(f, "[{}{}]", if neg { "^" } else { "" }, body)
            }
            (SlotValue::Class { class }, neg) => {
                let c = match class {
                    LetterClass::Vowel => 'v',
                    LetterClass::Consonant => 'c',
                };
                write!(f, "{{{}{}}}", if neg { "^" } else { "" }, c)
            }
        }
    }
}

impl Rule {
    /// A rule that matches every word of length `word_len`.
    pub fn any(word_len: usize) -> Rule {
        Rule { slots: vec![Slot::ANY; word_len], contains: vec![], excludes: vec![], repeated: false }
    }

    /// The canonical structure: every slot normalised, extras lowercase,
    /// sorted and deduplicated (characters other than letters are dropped).
    /// `parse_rule(&format_rule(r))` returns exactly `r.normalized()`.
    pub fn normalized(&self) -> Rule {
        Rule {
            slots: self.slots.iter().map(Slot::normalized).collect(),
            contains: letters_of(mask_of(self.contains.iter().copied())).collect(),
            excludes: letters_of(mask_of(self.excludes.iter().copied())).collect(),
            repeated: self.repeated,
        }
    }

    /// Compile for fast matching.
    pub fn compile(&self, y_vowel: bool) -> CompiledRule {
        CompiledRule {
            slots: self.slots.iter().map(|s| s.mask(y_vowel)).collect(),
            contains: mask_of(self.contains.iter().copied()),
            excludes: mask_of(self.excludes.iter().copied()),
            repeated: self.repeated,
        }
    }

    /// Whether `word` matches. A word of a different length never matches.
    pub fn matches(&self, word: &str, y_vowel: bool) -> bool {
        self.compile(y_vowel).matches(word.as_bytes())
    }
}

impl fmt::Display for Rule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&format_rule(self))
    }
}

/// A rule compiled to letter masks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompiledRule {
    slots: Vec<u32>,
    contains: u32,
    excludes: u32,
    repeated: bool,
}

impl CompiledRule {
    /// Whether a word (ASCII letters, either case) matches.
    #[inline]
    pub fn matches(&self, word: &[u8]) -> bool {
        if word.len() != self.slots.len() {
            return false;
        }
        let mut seen = 0u32;
        let mut repeat = false;
        for (&c, &slot) in word.iter().zip(&self.slots) {
            let b = letter_bit(c as char);
            if slot & b == 0 {
                return false;
            }
            repeat |= seen & b != 0;
            seen |= b;
        }
        seen & self.contains == self.contains && seen & self.excludes == 0 && (repeat || !self.repeated)
    }
}

// ---------------------------------------------------------------------------
// Parsing and formatting.

/// Parse one rule for words of `word_len` letters.
pub fn parse_rule(text: &str, word_len: usize) -> Result<Rule, ParseError> {
    let chars: Vec<char> = text.chars().collect();
    if chars.iter().all(|&c| is_space(c)) {
        return err(0, "empty rule");
    }
    Parser { chars: &chars, i: 0, end: chars.len() }.rule(word_len)
}

/// Parse rules separated by `|` (canonically `" | "`).
pub fn parse_filter(text: &str, word_len: usize) -> Result<Vec<Rule>, ParseError> {
    let chars: Vec<char> = text.chars().collect();
    if chars.iter().all(|&c| is_space(c)) {
        return err(0, "empty filter");
    }
    let mut rules = Vec::new();
    let mut start = 0;
    loop {
        let end = chars[start..].iter().position(|&c| c == '|').map_or(chars.len(), |p| start + p);
        rules.push(Parser { chars: &chars, i: start, end }.rule(word_len)?);
        if end == chars.len() {
            return Ok(rules);
        }
        start = end + 1;
    }
}

/// Canonical text of a rule, e.g. `?A??Y +E -S`.
pub fn format_rule(rule: &Rule) -> String {
    let r = rule.normalized();
    let mut out: String = r.slots.iter().map(|s| s.to_string()).collect();
    for c in &r.contains {
        out.push_str(" +");
        out.push(c.to_ascii_uppercase());
    }
    for c in &r.excludes {
        out.push_str(" -");
        out.push(c.to_ascii_uppercase());
    }
    if r.repeated {
        out.push_str(" *");
    }
    out
}

/// Canonical text of several rules, joined by `" | "`.
pub fn format_filter(rules: &[Rule]) -> String {
    rules.iter().map(format_rule).collect::<Vec<_>>().join(" | ")
}

struct Parser<'a> {
    chars: &'a [char],
    i: usize,
    end: usize,
}

fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        (self.i < self.end).then(|| self.chars[self.i])
    }

    fn skip_space(&mut self) {
        while self.peek().is_some_and(is_space) {
            self.i += 1;
        }
    }

    fn rule(mut self, word_len: usize) -> Result<Rule, ParseError> {
        self.skip_space();
        if self.peek().is_none() {
            return err(self.i, "empty rule");
        }
        let mut slots = Vec::with_capacity(word_len);
        while slots.len() < word_len {
            match self.peek() {
                None | Some('+' | '-' | '*') => break,
                Some(_) => slots.push(self.slot()?),
            }
            self.skip_space();
        }
        if slots.len() < word_len {
            return err(self.i, format!("expected {word_len} letters, found {}", slots.len()));
        }
        let (mut contains, mut excludes, mut repeated) = (0u32, 0u32, false);
        let mut seen_extra = false;
        while let Some(c) = self.peek() {
            let at = self.i;
            self.i += 1;
            match c {
                '*' => repeated = true,
                '+' | '-' => {
                    let b = self.peek().map_or(0, letter_bit);
                    if b == 0 {
                        return err(self.i, format!("expected a letter after '{c}'"));
                    }
                    self.i += 1;
                    if c == '+' {
                        contains |= b;
                    } else {
                        excludes |= b;
                    }
                }
                c if c == '?' || c == '[' || c == '{' || c == '!' || c.is_ascii_alphabetic() => {
                    return if seen_extra {
                        err(at, "letters must come before + - * conditions")
                    } else {
                        err(at, format!("too many letters: a rule has {word_len}"))
                    };
                }
                c => return err(at, format!("unexpected character '{c}'")),
            }
            seen_extra = true;
            self.skip_space();
        }
        Ok(Rule {
            slots,
            contains: letters_of(contains).collect(),
            excludes: letters_of(excludes).collect(),
            repeated,
        }
        .normalized())
    }

    /// One slot, starting at a non-space character.
    fn slot(&mut self) -> Result<Slot, ParseError> {
        let at = self.i;
        let c = self.chars[self.i];
        self.i += 1;
        match c {
            '?' => Ok(Slot::ANY),
            c if c.is_ascii_alphabetic() => Ok(Slot::letter(c)),
            '!' => match self.peek() {
                Some(l) if l.is_ascii_alphabetic() => {
                    self.i += 1;
                    Ok(Slot { negate: true, value: SlotValue::Letter { letter: l.to_ascii_lowercase() } })
                }
                _ => err(self.i, "expected a letter after '!'"),
            },
            '[' => {
                let negate = self.peek() == Some('^');
                if negate {
                    self.i += 1;
                }
                let mut letters = String::new();
                loop {
                    match self.peek() {
                        None => return err(at, "unclosed '['"),
                        Some(']') => break,
                        Some(l) if l.is_ascii_alphabetic() => letters.push(l.to_ascii_lowercase()),
                        Some(l) => return err(self.i, format!("unexpected character '{l}' in a letter set")),
                    }
                    self.i += 1;
                }
                if letters.is_empty() {
                    return err(at, "empty letter set");
                }
                self.i += 1;
                Ok(Slot { negate, value: SlotValue::Set { letters } })
            }
            '{' => {
                let close = self.chars[self.i..self.end].iter().take(3).position(|&c| c == '}');
                let body: String = match close {
                    Some(n) => self.chars[self.i..self.i + n].iter().collect::<String>().to_ascii_lowercase(),
                    None => return err(at, "expected {v}, {c}, {^v} or {^c}"),
                };
                let (negate, class) = match body.as_str() {
                    "v" => (false, LetterClass::Vowel),
                    "c" => (false, LetterClass::Consonant),
                    "^v" => (true, LetterClass::Vowel),
                    "^c" => (true, LetterClass::Consonant),
                    _ => return err(at, "expected {v}, {c}, {^v} or {^c}"),
                };
                self.i += body.chars().count() + 1;
                Ok(Slot { negate, value: SlotValue::Class { class } })
            }
            c => err(at, format!("unexpected character '{c}'")),
        }
    }
}

// ---------------------------------------------------------------------------
// Filters with scope.

fn default_true() -> bool {
    true
}

/// Rules combined with All or Any, plus scope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filter {
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub combine: Combine,
    /// Guess numbers (1-based) the filter applies to; empty = every row.
    #[serde(default)]
    pub rows: Vec<u32>,
    /// Whether a final solving guess can match.
    #[serde(default = "default_true", alias = "includeFinal")]
    pub include_final: bool,
}

impl Filter {
    /// Parse the text form with the default scope: every row, final guesses included.
    pub fn parse(text: &str, word_len: usize, combine: Combine) -> Result<Filter, ParseError> {
        Ok(Filter { rules: parse_filter(text, word_len)?, combine, rows: vec![], include_final: true })
    }

    /// Canonical text of the rules.
    pub fn text(&self) -> String {
        format_filter(&self.rules)
    }

    /// Whether a word matches the rule set, ignoring scope. A filter with no
    /// rules matches every word.
    pub fn matches_word(&self, word: &str, y_vowel: bool) -> bool {
        self.compile(y_vowel).matches_word(word.as_bytes())
    }

    /// Whether a tree node matches: guess `word` at guess number `turn`
    /// (1-based), `is_final` if it is a solving guess.
    pub fn matches_node(&self, word: &str, turn: u32, is_final: bool, y_vowel: bool) -> bool {
        self.compile(y_vowel).matches_node(word.as_bytes(), turn, is_final)
    }

    /// Compile for matching many nodes.
    pub fn compile(&self, y_vowel: bool) -> CompiledFilter {
        CompiledFilter {
            rules: self.rules.iter().map(|r| r.compile(y_vowel)).collect(),
            combine: self.combine,
            rows: self.rows.clone(),
            include_final: self.include_final,
        }
    }
}

/// A filter compiled to letter masks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompiledFilter {
    rules: Vec<CompiledRule>,
    combine: Combine,
    rows: Vec<u32>,
    include_final: bool,
}

impl CompiledFilter {
    /// Whether a word matches the rule set, ignoring scope.
    pub fn matches_word(&self, word: &[u8]) -> bool {
        if self.rules.is_empty() {
            return true;
        }
        match self.combine {
            Combine::All => self.rules.iter().all(|r| r.matches(word)),
            Combine::Any => self.rules.iter().any(|r| r.matches(word)),
        }
    }

    /// Whether the scope admits guess number `turn` (1-based).
    pub fn in_scope(&self, turn: u32, is_final: bool) -> bool {
        (self.include_final || !is_final) && (self.rows.is_empty() || self.rows.contains(&turn))
    }

    /// Whether a node matches, honouring scope.
    pub fn matches_node(&self, word: &[u8], turn: u32, is_final: bool) -> bool {
        self.in_scope(turn, is_final) && self.matches_word(word)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn p(text: &str) -> Rule {
        parse_rule(text, 5).unwrap_or_else(|e| panic!("{text:?}: {e}"))
    }

    fn canon(text: &str) -> String {
        format_rule(&p(text))
    }

    fn e(text: &str) -> ParseError {
        parse_rule(text, 5).expect_err(text)
    }

    fn fe(text: &str) -> ParseError {
        parse_filter(text, 5).expect_err(text)
    }

    #[test]
    fn spec_examples() {
        // An A second and a Y last.
        let r = p("?A??Y");
        assert!(r.matches("happy", false));
        assert!(r.matches("marry", false));
        assert!(!r.matches("hippy", false));
        assert!(!r.matches("habit", false));
        assert_eq!(format_rule(&r), "?A??Y");
        // Vowels first and second.
        let r = p("{v}{v}???");
        assert!(r.matches("audio", false));
        assert!(r.matches("outer", false));
        assert!(!r.matches("yearn", false));
        assert!(r.matches("yearn", true));
        assert!(!r.matches("crane", true));
        assert_eq!(format_rule(&r), "{v}{v}???");
        // Not an S first.
        let r = p("[^S]????");
        assert!(r.matches("crane", false));
        assert!(!r.matches("slate", false));
        assert_eq!(format_rule(&r), "!S????");
        // Contains E, no S.
        let r = p("?A??Y +E -S");
        assert!(r.matches("gamey", false));
        assert!(!r.matches("happy", false));
        assert!(!r.matches("sadly", false));
        assert_eq!(format_rule(&r), "?A??Y +E -S");
    }

    #[test]
    fn structure_and_json() {
        let r = p("?a[^ea]{c}!y +E -s *");
        assert_eq!(r.slots[0], Slot::ANY);
        assert_eq!(r.slots[1], Slot::letter('a'));
        assert_eq!(r.slots[2], Slot { negate: true, value: SlotValue::Set { letters: "ae".into() } });
        assert_eq!(r.slots[3], Slot { negate: false, value: SlotValue::Class { class: LetterClass::Consonant } });
        assert_eq!(r.slots[4], Slot { negate: true, value: SlotValue::Letter { letter: 'y' } });
        assert_eq!((r.contains.clone(), r.excludes.clone(), r.repeated), (vec!['e'], vec!['s'], true));
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "slots": [
                    { "negate": false, "value": { "kind": "any" } },
                    { "negate": false, "value": { "kind": "letter", "letter": "a" } },
                    { "negate": true, "value": { "kind": "set", "letters": "ae" } },
                    { "negate": false, "value": { "kind": "class", "class": "consonant" } },
                    { "negate": true, "value": { "kind": "letter", "letter": "y" } }
                ],
                "contains": ["e"], "excludes": ["s"], "repeated": true
            })
        );
        assert_eq!(serde_json::from_value::<Rule>(json).unwrap(), r);
        let f = Filter { rules: vec![r], combine: Combine::Any, rows: vec![2, 3], include_final: false };
        let json = serde_json::to_string(&f).unwrap();
        assert_eq!(serde_json::from_str::<Filter>(&json).unwrap(), f);
        let camel: Filter = serde_json::from_str(r#"{"rules":[],"combine":"any","includeFinal":false}"#).unwrap();
        assert_eq!((camel.combine, camel.include_final, camel.rows.len()), (Combine::Any, false, 0));
    }

    #[test]
    fn canonical_forms() {
        assert_eq!(canon("?a??y"), "?A??Y");
        assert_eq!(canon(" ? A ? ? Y "), "?A??Y");
        assert_eq!(canon("[ea][a][^b][^cb][aeea]"), "[AE]A!B[^BC][AE]");
        assert_eq!(canon("{V}{^c}{C}{^V}?"), "{v}{^c}{c}{^v}?");
        assert_eq!(canon("????? -s +e +a -b * * +e"), "????? +A +E -B -S *");
        assert_eq!(canon("?????+e-s*"), "????? +E -S *");
        // Builder structures that constrain nothing format as `?`.
        let mut blank = Rule::any(5);
        blank.slots[0] = Slot { negate: true, value: SlotValue::Any };
        blank.slots[1] = Slot { negate: false, value: SlotValue::Set { letters: String::new() } };
        blank.slots[2] = Slot { negate: true, value: SlotValue::Set { letters: String::new() } };
        blank.slots[3] = Slot { negate: true, value: SlotValue::Set { letters: "S".into() } };
        assert_eq!(format_rule(&blank), "???!S?");
        assert!(blank.matches("crane", false));
        assert_eq!(blank.normalized(), p("???!S?"));
        assert_eq!(format_filter(&parse_filter("?a??y|{v}????  |  ????? *", 5).unwrap()), "?A??Y | {v}???? | ????? *");
        // Other word lengths.
        assert_eq!(format_rule(&parse_rule("??[st]?", 4).unwrap()), "??[ST]?");
        assert_eq!(format_rule(&parse_rule("{v}??????", 7).unwrap()), "{v}??????");
    }

    #[test]
    fn errors_with_positions() {
        assert_eq!(e(""), ParseError { message: "empty rule".into(), at: 0 });
        assert_eq!(e("   ").at, 0);
        assert_eq!(fe(" \t "), ParseError { message: "empty filter".into(), at: 0 });
        assert_eq!(e("[]????"), ParseError { message: "empty letter set".into(), at: 0 });
        assert_eq!(e("?[^]???").at, 1);
        assert_eq!(e("?A?"), ParseError { message: "expected 5 letters, found 3".into(), at: 3 });
        assert_eq!(e("?A? +E").at, 4);
        assert_eq!(e("?A??YY"), ParseError { message: "too many letters: a rule has 5".into(), at: 5 });
        assert_eq!(e("?A??Y +"), ParseError { message: "expected a letter after '+'".into(), at: 7 });
        assert_eq!(e("?A??Y -1").at, 7);
        assert_eq!(e("?A??Y +EA").at, 8);
        assert_eq!(e("?A??Y +E ?").message, "letters must come before + - * conditions");
        assert_eq!(e("?[ab"), ParseError { message: "unclosed '['".into(), at: 1 });
        assert_eq!(e("?[ab????"), ParseError { message: "unexpected character '?' in a letter set".into(), at: 4 });
        assert_eq!(e("?[a-b]???").at, 3);
        assert_eq!(e("{x}????").at, 0);
        assert_eq!(e("?{v????").at, 1);
        assert_eq!(e("!?????").at, 1);
        assert_eq!(e("!"), ParseError { message: "expected a letter after '!'".into(), at: 1 });
        assert_eq!(e("??1??").at, 2);
        assert_eq!(e("??é??"), ParseError { message: "unexpected character 'é'".into(), at: 2 });
        assert_eq!(e("?????]"), ParseError { message: "unexpected character ']'".into(), at: 5 });
        assert_eq!(e("?????x").message, "too many letters: a rule has 5");
        // Positions in a multi-rule filter are offsets in the whole text.
        assert_eq!(fe("?A??Y | ?B?"), ParseError { message: "expected 5 letters, found 3".into(), at: 11 });
        assert_eq!(fe("?A??Y |"), ParseError { message: "empty rule".into(), at: 7 });
        assert_eq!(fe("????? | ").at, 8);
        assert_eq!(fe("????? | ????").at, 12);
        assert_eq!(fe("| ?A??Y").at, 0);
        assert_eq!(fe("?A??Y | ?[é]???").at, 10);
    }

    #[test]
    fn scope() {
        let f = Filter {
            rules: parse_filter("?A??Y | S????", 5).unwrap(),
            combine: Combine::Any,
            rows: vec![1, 3],
            include_final: false,
        };
        assert!(f.matches_node("happy", 1, false, false));
        assert!(f.matches_node("slate", 3, false, false));
        assert!(!f.matches_node("slate", 2, false, false));
        assert!(!f.matches_node("slate", 3, true, false));
        assert!(!f.matches_node("crane", 1, false, false));
        let all = Filter { combine: Combine::All, rows: vec![], include_final: true, ..f.clone() };
        assert!(!all.matches_node("happy", 1, false, false));
        assert!(all.matches_node("sappy", 6, true, false));
        let empty = Filter { rules: vec![], ..all.clone() };
        assert!(empty.matches_word("crane", false));
        assert!(Filter { combine: Combine::Any, ..empty }.matches_word("crane", false));
    }

    #[test]
    fn matching_edge_cases() {
        let r = p("????? *");
        assert!(r.matches("speed", false));
        assert!(!r.matches("crane", false));
        assert!(!r.matches("cranes", false));
        assert!(!r.matches("cran", false));
        assert!(p("{c}????").matches("yearn", false));
        assert!(!p("{c}????").matches("yearn", true));
        assert!(p("{^v}????").matches("yearn", false));
        assert!(p("????? +e -e").slots.len() == 5 && !p("????? +e -e").matches("crane", false));
        assert!(p("CRANE").matches("CRANE", false));
    }

    // ---- property tests against a deliberately naive matcher ----

    fn naive_is_vowel(c: char, y_vowel: bool) -> bool {
        "aeiou".contains(c) || (y_vowel && c == 'y')
    }

    fn naive_accepts(slot: &Slot, c: char, y_vowel: bool) -> bool {
        let base = match &slot.value {
            SlotValue::Any => return true,
            SlotValue::Set { letters } if letters.is_empty() => return true,
            SlotValue::Letter { letter } => letter.to_ascii_lowercase() == c,
            SlotValue::Set { letters } => letters.to_ascii_lowercase().contains(c),
            SlotValue::Class { class: LetterClass::Vowel } => naive_is_vowel(c, y_vowel),
            SlotValue::Class { class: LetterClass::Consonant } => !naive_is_vowel(c, y_vowel),
        };
        base != slot.negate
    }

    fn naive_matches(rule: &Rule, word: &str, y_vowel: bool) -> bool {
        let w: Vec<char> = word.chars().collect();
        if w.len() != rule.slots.len() {
            return false;
        }
        for (slot, &c) in rule.slots.iter().zip(&w) {
            if !naive_accepts(slot, c, y_vowel) {
                return false;
            }
        }
        for &c in &rule.contains {
            if !w.contains(&c.to_ascii_lowercase()) {
                return false;
            }
        }
        for &c in &rule.excludes {
            if w.contains(&c.to_ascii_lowercase()) {
                return false;
            }
        }
        if rule.repeated {
            let mut any = false;
            for i in 0..w.len() {
                for j in i + 1..w.len() {
                    any |= w[i] == w[j];
                }
            }
            if !any {
                return false;
            }
        }
        true
    }

    fn letter() -> impl Strategy<Value = char> {
        // Skewed towards a few letters so sets, extras and words overlap often.
        prop_oneof![
            3 => prop::sample::select(vec!['a', 'e', 'y', 's', 't']),
            1 => (b'a'..=b'z').prop_map(|b| b as char),
            1 => prop::sample::select(vec!['A', 'E', 'Y', 'S']),
        ]
    }

    fn slot() -> impl Strategy<Value = Slot> {
        let value = prop_oneof![
            2 => Just(SlotValue::Any),
            3 => letter().prop_map(|letter| SlotValue::Letter { letter }),
            3 => prop::collection::vec(letter(), 0..5).prop_map(|v| SlotValue::Set { letters: v.into_iter().collect() }),
            1 => Just(SlotValue::Class { class: LetterClass::Vowel }),
            1 => Just(SlotValue::Class { class: LetterClass::Consonant }),
        ];
        (any::<bool>(), value).prop_map(|(negate, value)| Slot { negate, value })
    }

    fn rule(len: usize) -> impl Strategy<Value = Rule> {
        (
            prop::collection::vec(slot(), len),
            prop::collection::vec(letter(), 0..3),
            prop::collection::vec(letter(), 0..3),
            any::<bool>(),
        )
            .prop_map(|(slots, contains, excludes, repeated)| Rule { slots, contains, excludes, repeated })
    }

    fn word(len: usize) -> impl Strategy<Value = String> {
        prop::collection::vec(letter().prop_map(|c| c.to_ascii_lowercase()), len).prop_map(|v| v.into_iter().collect())
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]

        #[test]
        fn format_parse_round_trip((len, r) in (4usize..=7).prop_flat_map(|len| (Just(len), rule(len)))) {
            let text = format_rule(&r);
            let parsed = parse_rule(&text, len).unwrap();
            prop_assert_eq!(&parsed, &r.normalized());
            prop_assert_eq!(format_rule(&parsed), text.clone());
            // Lowercase text parses to the same rule.
            prop_assert_eq!(parse_rule(&text.to_ascii_lowercase(), len).unwrap(), parsed);
        }

        #[test]
        fn matcher_agrees_with_naive(r in rule(5), words in prop::collection::vec(word(5), 1..20), y in any::<bool>()) {
            let compiled = r.compile(y);
            let norm = r.normalized();
            for w in &words {
                let want = naive_matches(&r, w, y);
                prop_assert_eq!(compiled.matches(w.as_bytes()), want, "{} {}", format_rule(&r), w);
                prop_assert_eq!(r.matches(w, y), want);
                // Normalising (and so formatting and re-parsing) keeps the meaning.
                prop_assert_eq!(naive_matches(&norm, w, y), want);
            }
            prop_assert!(!r.matches("abcd", y));
        }

        #[test]
        fn parser_never_panics(text in "[?a-zA-Z\\[\\]{}^!+*| vc-]{0,24}", len in 4usize..=7) {
            let n = text.chars().count();
            match parse_filter(&text, len) {
                Ok(rules) => {
                    // The canonical text re-parses to the same rules.
                    prop_assert_eq!(parse_filter(&format_filter(&rules), len).unwrap(), rules);
                }
                Err(e) => prop_assert!(e.at <= n, "{:?} at {} of {}", text, e.at, n),
            }
        }
    }

    #[test]
    fn shared_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/testvectors/filter.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 100);
        for c in cases {
            let text = c["text"].as_str().unwrap();
            let len = c["word_length"].as_u64().unwrap() as usize;
            let y = c["y_vowel"].as_bool().unwrap();
            let combine: Combine = serde_json::from_value(c["combine"].clone()).unwrap();
            let f = Filter::parse(text, len, combine).unwrap_or_else(|e| panic!("{text:?}: {e}"));
            assert_eq!(f.text(), c["canonical"].as_str().unwrap(), "{text:?}");
            let rules: Vec<Rule> = serde_json::from_value(c["rules"].clone()).unwrap();
            assert_eq!(rules, f.rules, "{text:?}");
            for (w, want) in c["matches"].as_object().unwrap() {
                assert_eq!(f.matches_word(w, y), want.as_bool().unwrap(), "{text:?} {w} y_vowel={y}");
            }
        }
        for c in v["errors"].as_array().unwrap() {
            let text = c["text"].as_str().unwrap();
            let len = c["word_length"].as_u64().unwrap() as usize;
            let e = parse_filter(text, len).expect_err(text);
            if let Some(at) = c.get("at") {
                assert_eq!(e.at as u64, at.as_u64().unwrap(), "{text:?}: {e}");
            }
        }
        for c in v["scope_cases"].as_array().unwrap() {
            let f = Filter {
                rules: parse_filter(c["text"].as_str().unwrap(), 5).unwrap(),
                combine: serde_json::from_value(c["combine"].clone()).unwrap(),
                rows: serde_json::from_value(c["rows"].clone()).unwrap(),
                include_final: c["include_final"].as_bool().unwrap(),
            };
            let y = c["y_vowel"].as_bool().unwrap();
            for n in c["nodes"].as_array().unwrap() {
                let (w, turn, fin) = (n["word"].as_str().unwrap(), n["turn"].as_u64().unwrap() as u32, n["is_final"].as_bool().unwrap());
                assert_eq!(f.matches_node(w, turn, fin, y), n["matches"].as_bool().unwrap(), "{c} {n}");
            }
        }
    }
}
