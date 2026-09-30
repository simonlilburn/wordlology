//! Behaviour of each strategy in the catalogue, on small hand-built lists
//! and on the frozen reference list (data/wordlists/ref-en-5).

mod common;

use common::*;
use wl_core::{expected_info, math, CandidateSet, WordId};
use wl_strategy::spec::{BuildError, Pool, StrategySpec};
use wl_strategy::{argmax_tiebreak, Ctx, State, Strategy};

// ---------------------------------------------------------------------------
// max_info

/// Three candidates that no candidate splits perfectly (bills separates only
/// itself from fills/hills), and non-candidates that do: afhzz, hobfq, hofbq.
fn tie_list() -> wl_core::WordList {
    adhoc(&["afhzz", "bills", "fills", "hills", "hobfq", "hofbq", "zzzzz"], &["bills", "fills", "hills"])
}

#[test]
fn max_info_tie_breaks() {
    let list = tie_list();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let root = State::initial(&list);
    let word = |s: &dyn Strategy, st: &State| list.word(s.distribution(&ctx, st).entries[0].word).to_string();

    let cands = build(r#"{"kind":"max_info"}"#, &list);
    let allowed = build(r#"{"kind":"max_info","pool":"allowed"}"#, &list);
    // Candidates all tie (one singleton and a pair): the lowest id.
    assert_eq!(word(&*cands, &root), "bills");
    // afhzz, hobfq and hofbq split all three apart; the lowest id wins.
    assert_eq!(word(&*allowed, &root), "afhzz");
    let ranked = allowed.scores(&ctx, &root, 4);
    assert_eq!(ranked.iter().map(|&(w, _)| list.word(w)).collect::<Vec<_>>(), ["afhzz", "hobfq", "hofbq", "bills"]);
    assert_eq!(ranked[0].1, math::log2(3.0));

    // Two candidates left: each splits them perfectly, as does afhzz (a
    // lower id), but ties go to words in C.
    let two = state_after(&ctx, "fills", &["bills"]);
    assert_eq!(two.candidates.len(), 2);
    assert_eq!(word(&*allowed, &two), "fills");
    assert_eq!(word(&*cands, &two), "fills");
    // One candidate left: guess it.
    let one = state_after(&ctx, "hills", &["afhzz"]);
    assert_eq!(word(&*allowed, &one), "hills");
    assert_eq!(cands.phases(), ["max_info"]);
}

/// The fast search in `MaxInfo` must choose exactly what a plain scan with
/// `wl_core::expected_info` and `argmax_tiebreak` chooses, and
/// `info_proportional` must weight exactly the plain scores.
#[test]
fn max_info_matches_brute_force() {
    let list = reference();
    let m = matrix(&list);
    let mut r = rng(7);
    for hard in [false, true] {
        let ctx = Ctx::new(&list, &m, rules(hard));
        let walker = build(r#"{"kind":"random","pool":"allowed"}"#, &list);
        let mut states = vec![State::initial(&list)];
        for t in sample_targets(&list, 25, &mut r) {
            let (turns, _) = play(&ctx, &*walker, t, &mut r);
            states.extend(turns.into_iter().map(|t| t.state).skip(1).take(3));
        }
        let mut scratch = vec![0u32; m.n_patterns()];
        for pool in [Pool::Candidates, Pool::Allowed] {
            let s = StrategySpec::MaxInfo { pool }.build(&list).unwrap();
            let prop = StrategySpec::InfoProportional { beta: 2.5, pool }.build(&list).unwrap();
            for st in &states {
                let words = ctx.pool_words(st, pool);
                let plain: Vec<(WordId, f64)> =
                    words.iter().map(|&w| (w, expected_info(&m, w, &st.candidates, &mut scratch))).collect();
                let want = argmax_tiebreak(&ctx, st, plain.iter().copied()).unwrap();
                assert_eq!(s.distribution(&ctx, st).entries[0].word, want, "hard={hard} pool={pool:?}");
                let top = s.scores(&ctx, st, 1);
                assert_eq!(top[0].0, want);
                assert_eq!(top[0].1.to_bits(), plain.iter().find(|p| p.0 == want).unwrap().1.to_bits());
                if st.candidates.len() > 1 {
                    let d = prop.distribution(&ctx, st);
                    let total: f64 = plain.iter().map(|&(_, i)| if i > 0.0 { math::pow(i, 2.5) } else { 0.0 }).sum();
                    for (e, &(w, i)) in d.entries.iter().zip(&plain) {
                        assert_eq!(e.word, w);
                        let p = if i > 0.0 { math::pow(i, 2.5) / total } else { 0.0 };
                        assert_eq!(e.p.to_bits(), p.to_bits());
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// most_frequent

#[test]
fn most_frequent_picks_by_zipf_with_ties_to_lower_id() {
    let mut list = adhoc(&["crane", "react", "slate", "trace", "zzzzz"], &["crane", "react", "slate", "trace"]);
    list.set_frequencies("crane\t4.0\nreact\t3.5\nslate\t3.0\ntrace\t4.0\nzzzzz\t9.0\n").unwrap();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let s = build(r#"{"kind":"most_frequent"}"#, &list);
    assert!(s.is_deterministic());
    let root = State::initial(&list);
    // crane and trace tie at 4.0: the lower id. zzzzz is not a candidate.
    assert_eq!(list.word(s.distribution(&ctx, &root).entries[0].word), "crane");
    let ranked: Vec<_> = s.scores(&ctx, &root, 10).into_iter().map(|(w, z)| (list.word(w), z)).collect();
    assert_eq!(ranked, [("crane", 4.0), ("trace", 4.0), ("react", 3.5), ("slate", 3.0)]);
    // Once crane is ruled out, trace (4.0) beats react (3.5).
    let two = CandidateSet::from_iter(4, ["react", "trace"].map(|w| list.answer_of_word(w).unwrap()));
    let st = State { candidates: two, turn: 1, history: vec![] };
    assert_eq!(list.word(s.distribution(&ctx, &st).entries[0].word), "trace");

    // No frequencies, no strategy.
    let bare = adhoc(&["crane", "slate"], &["crane"]);
    assert_eq!(
        spec(r#"{"kind":"most_frequent"}"#).build(&bare).err(),
        Some(BuildError::NeedsFrequencies("most_frequent"))
    );
}

// ---------------------------------------------------------------------------
// fixed_sequence

#[test]
fn fixed_sequence_plays_in_order_then_solves() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let s = build(r#"{"kind":"fixed_sequence","words":["slate","build","dough"]}"#, &list);
    assert!(s.is_deterministic());
    assert_eq!(s.phases(), ["fixed_sequence"]);
    let seq = ids(&list, &["slate", "build", "dough"]);
    let mut r = rng(1);
    for t in 0..list.n_answers() as u16 {
        let (turns, _) = play(&ctx, &*s, t, &mut r);
        for (i, turn) in turns.iter().enumerate() {
            let g = turn.choice.word;
            if turn.state.candidates.len() == 1 {
                assert_eq!(g, ctx.first_candidate(&turn.state), "solve when one");
            } else if i < 3 {
                assert_eq!(g, seq[i]);
            } else {
                assert_eq!(g, ctx.first_candidate(&turn.state), "after the sequence");
            }
        }
    }
}

#[test]
fn fixed_sequence_options_and_hard_mode() {
    let list = tie_list();
    let m = matrix(&list);
    // Without solve_when_one, the sequence continues even with one candidate.
    let ctx = Ctx::new(&list, &m, rules(false));
    let s = build(r#"{"kind":"fixed_sequence","words":["afhzz","zzzzz"],"solve_when_one":false}"#, &list);
    let one = state_after(&ctx, "hills", &["afhzz"]);
    assert_eq!(one.candidates.len(), 1);
    assert_eq!(list.word(s.distribution(&ctx, &one).entries[0].word), "zzzzz");
    assert!(!s.exhausted(&ctx, &one));
    // Exhausted: the first candidate.
    let two = state_after(&ctx, "hills", &["afhzz", "zzzzz"]);
    assert!(s.exhausted(&ctx, &two));
    assert_eq!(list.word(s.distribution(&ctx, &two).entries[0].word), "hills");
    // A listed word already played is not replayed.
    let s = build(r#"{"kind":"fixed_sequence","words":["zzzzz","zzzzz","bills"]}"#, &list);
    let st = state_after(&ctx, "hills", &["zzzzz"]);
    assert_eq!(list.word(s.distribution(&ctx, &st).entries[0].word), "bills");

    // Hard mode: after afhzz against hills (H present), zzzzz is invalid and
    // skipped; hills, the next listed word, is played instead.
    let hard = Ctx::new(&list, &m, rules(true));
    let s = build(r#"{"kind":"fixed_sequence","words":["afhzz","zzzzz","hofbq"],"solve_when_one":false}"#, &list);
    let st = state_after(&hard, "hills", &["afhzz"]);
    assert_eq!(list.word(s.distribution(&hard, &st).entries[0].word), "hofbq");
    assert_eq!(list.word(s.distribution(&ctx, &st).entries[0].word), "zzzzz");
    // Every listed word invalid: the first candidate.
    let s = build(r#"{"kind":"fixed_sequence","words":["afhzz","zzzzz"],"solve_when_one":false}"#, &list);
    assert!(s.exhausted(&hard, &st));
    assert_eq!(list.word(s.distribution(&hard, &st).entries[0].word), "hills");

    // Build errors.
    assert_eq!(
        spec(r#"{"kind":"fixed_sequence","words":["bills","qqqqq"]}"#).build(&list).err(),
        Some(BuildError::UnknownWord("qqqqq".into()))
    );
    assert!(matches!(spec(r#"{"kind":"fixed_sequence","words":[]}"#).build(&list), Err(BuildError::Invalid(_))));
}

// ---------------------------------------------------------------------------
// random, info_proportional, freq_proportional

#[test]
fn random_is_uniform_over_its_pool() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(true));
    let st = state_after(&ctx, "brand", &["slate"]);
    for (json, n) in [
        (r#"{"kind":"random"}"#, st.candidates.len()),
        (r#"{"kind":"random","pool":"allowed"}"#, ctx.allowed_words(&st).len()),
    ] {
        let s = build(json, &list);
        assert!(!s.is_deterministic());
        let d = s.distribution(&ctx, &st);
        check_dist(&ctx, &*s, &st, &d);
        assert_eq!(d.entries.len(), n);
        assert!(d.entries.iter().all(|e| e.p == 1.0 / n as f64));
    }
    // Hard mode narrows the allowed pool.
    assert!(ctx.allowed_words(&st).len() < list.n_guesses());
}

#[test]
fn beta_zero_is_uniform() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let st = state_after(&ctx, "brand", &["slate"]);
    for json in [
        r#"{"kind":"info_proportional","beta":0}"#,
        r#"{"kind":"info_proportional","beta":0,"pool":"allowed"}"#,
        r#"{"kind":"freq_proportional","beta":0}"#,
    ] {
        let s = build(json, &list);
        let d = s.distribution(&ctx, &st);
        check_dist(&ctx, &*s, &st, &d);
        let p = d.entries[0].p;
        assert!(d.entries.iter().all(|e| e.p == p), "{json}");
        assert_eq!(p, 1.0 / d.entries.len() as f64);
    }
}

/// As β grows, the probability of the deterministic counterpart's choice
/// grows monotonically towards 1 and it becomes the mode.
#[test]
fn large_beta_approaches_deterministic_counterpart() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let states =
        [State::initial(&list), state_after(&ctx, "brand", &["slate"]), state_after(&ctx, "older", &["saint"])];
    for (prop, det) in
        [("info_proportional", r#"{"kind":"max_info"}"#), ("freq_proportional", r#"{"kind":"most_frequent"}"#)]
    {
        let det = build(det, &list);
        for st in &states {
            let want = det.distribution(&ctx, st).entries[0].word;
            let mut last = 0.0;
            for beta in [0.0, 0.5, 1.0, 4.0, 16.0, 64.0, 256.0, 1000.0] {
                let s = build(&format!(r#"{{"kind":"{prop}","beta":{beta}}}"#), &list);
                let d = s.distribution(&ctx, st);
                check_dist(&ctx, &*s, st, &d);
                let p = d.prob_of(want);
                assert!(p >= last - 1e-12, "{prop} beta={beta}: {p} < {last}");
                last = p;
                if beta >= 64.0 {
                    assert_eq!(d.mode().word, want, "{prop} beta={beta}");
                }
            }
            // Words tied with the choice share its probability equally.
            let d = build(&format!(r#"{{"kind":"{prop}","beta":1000}}"#), &list).distribution(&ctx, st);
            let ties = d.entries.iter().filter(|e| e.p == last).count();
            assert!(last * ties as f64 > 0.5, "{prop}: {last} x {ties}");
        }
    }
}

#[test]
fn freq_proportional_follows_frequency() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let s = build(r#"{"kind":"freq_proportional"}"#, &list);
    let d = s.distribution(&ctx, &State::initial(&list));
    assert_eq!(d.entries.len(), list.n_answers());
    let (a, b) = (d.entries[0], d.entries[1]);
    let ratio = a.p / b.p;
    let want = math::pow(10.0, (list.zipf_of(a.word) - list.zipf_of(b.word)) as f64);
    assert!((ratio / want - 1.0).abs() < 1e-9);
    let bare = adhoc(&["crane", "slate"], &["crane"]);
    assert_eq!(
        spec(r#"{"kind":"freq_proportional"}"#).build(&bare).err(),
        Some(BuildError::NeedsFrequencies("freq_proportional"))
    );
}

// ---------------------------------------------------------------------------
// coverage_then

/// Letter frequencies over the candidates: a 3, b 2, the rest 1.
fn coverage_list() -> wl_core::WordList {
    adhoc(&["aabcd", "abcde", "abfgh", "abfgi", "abxyz", "aijkl", "cdfgh", "mnopq"], &["abcde", "abfgh", "aijkl"])
}

#[test]
fn coverage_picks_frequent_untested_letters() {
    let list = coverage_list();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let s =
        build(r#"{"kind":"coverage_then","switch":{"when":"after_turns","k":6},"then":{"kind":"max_info"}}"#, &list);
    assert!(s.is_deterministic());
    assert_eq!(s.phases(), ["coverage", "max_info"]);
    let root = State::initial(&list);
    // abcde, abfgh and abfgi score 3+2+1+1+1 = 8; aabcd repeats a letter.
    // Ties go to candidates, then the lower id.
    let d = s.distribution(&ctx, &root);
    assert_eq!((list.word(d.entries[0].word), d.entries[0].phase), ("abcde", 0));
    let ranked: Vec<_> = s.scores(&ctx, &root, 3).into_iter().map(|(w, x)| (list.word(w), x)).collect();
    assert_eq!(ranked, [("abcde", 8.0), ("abfgh", 8.0), ("abfgi", 8.0)]);
    // After abxyz (a b green against abcde): C = {abcde, abfgh}; a, b, x, y,
    // z are tested. cdfgh covers c d f g h (5), better than any candidate (3).
    let st = state_after(&ctx, "abcde", &["abxyz"]);
    assert_eq!(st.candidates.len(), 2);
    assert_eq!(list.word(s.distribution(&ctx, &st).entries[0].word), "cdfgh");
    // In hard mode cdfgh is invalid (a and b must stay): the best candidate.
    let hard = Ctx::new(&list, &m, rules(true));
    assert_eq!(list.word(s.distribution(&hard, &st).entries[0].word), "abcde");
    // One candidate left: guess it.
    let one = state_after(&ctx, "aijkl", &["abcde"]);
    assert_eq!(list.word(s.distribution(&ctx, &one).entries[0].word), "aijkl");
}

#[test]
fn coverage_then_switches_after_k_turns() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let s =
        build(r#"{"kind":"coverage_then","switch":{"when":"after_turns","k":2},"then":{"kind":"max_info"}}"#, &list);
    let then = build(r#"{"kind":"max_info"}"#, &list);
    let mut r = rng(3);
    for t in sample_targets(&list, 60, &mut r) {
        let (turns, _) = play(&ctx, &*s, t, &mut r);
        for turn in &turns {
            let phase = turn.choice.phase;
            if turn.state.turn < 2 {
                assert_eq!(phase, 0);
                // Coverage words have no repeated letter (or solve).
                let w = list.letters(turn.choice.word);
                let distinct = (0..5).all(|i| (i + 1..5).all(|j| w[i] != w[j]));
                assert!(distinct || turn.state.candidates.len() == 1);
            } else {
                assert_eq!(phase, 1);
                assert_eq!(turn.choice.word, then.distribution(&ctx, &turn.state).entries[0].word);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// switch rules, sequence_then

#[test]
fn switch_rules() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let mut r = rng(4);
    let targets = sample_targets(&list, 60, &mut r);
    type Rule<'a> = (&'a str, fn(&State) -> bool);
    let cases: [Rule; 3] = [
        (r#"{"when":"candidates_le","n":12}"#, |s| s.candidates.len() <= 12),
        (r#"{"when":"bits_le","h":4.5}"#, |s| wl_core::remaining_bits(s.candidates.len()) <= 4.5),
        (r#"{"when":"after_turns","k":1}"#, |s| s.turn >= 1),
    ];
    for (rule, switched) in cases {
        let json =
            format!(r#"{{"kind":"switch","first":{{"kind":"random"}},"then":{{"kind":"max_info"}},"when":{rule}}}"#);
        let s = build(&json, &list);
        assert!(!s.is_deterministic());
        assert_eq!(s.phases(), ["random", "max_info"]);
        for &t in &targets {
            for turn in play(&ctx, &*s, t, &mut r).0 {
                assert_eq!(turn.choice.phase == 1, switched(&turn.state), "{rule} at {:?}", turn.state.candidates);
                assert_eq!(turn.dist.entries.len() == 1, switched(&turn.state) || turn.state.candidates.len() == 1);
            }
        }
    }
}

#[test]
fn sequence_then_switches_when_exhausted() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let s = build(
        r#"{"kind":"sequence_then","words":["saint","older"],"switch":{"when":"sequence_exhausted"},"then":{"kind":"max_info"}}"#,
        &list,
    );
    assert!(s.is_deterministic());
    assert_eq!(s.phases(), ["sequence", "max_info"]);
    let seq = ids(&list, &["saint", "older"]);
    let mut r = rng(5);
    for t in 0..list.n_answers() as u16 {
        let (turns, solved) = play(&ctx, &*s, t, &mut r);
        assert!(solved || turns.len() == 6);
        for (i, turn) in turns.iter().enumerate() {
            match i {
                0 | 1 if turn.state.candidates.len() > 1 => {
                    assert_eq!((turn.choice.word, turn.choice.phase), (seq[i], 0))
                }
                0 | 1 => assert_eq!(turn.choice.phase, 0, "solving inside the sequence"),
                _ => assert_eq!(turn.choice.phase, 1),
            }
        }
    }
    // The same hybrid from the general switch combinator plays identically.
    let general = build(
        r#"{"kind":"switch","first":{"kind":"fixed_sequence","words":["saint","older"]},"then":{"kind":"max_info"},"when":{"when":"sequence_exhausted"}}"#,
        &list,
    );
    assert_eq!(general.phases(), ["fixed_sequence", "max_info"]);
    for t in 0..list.n_answers() as u16 {
        let a: Vec<_> = play(&ctx, &*s, t, &mut r).0.iter().map(|t| (t.choice.word, t.choice.phase)).collect();
        let b: Vec<_> = play(&ctx, &*general, t, &mut r).0.iter().map(|t| (t.choice.word, t.choice.phase)).collect();
        assert_eq!(a, b);
    }
}

// ---------------------------------------------------------------------------
// mixture, solve_when_le, nesting

#[test]
fn epsilon_greedy_mixture() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let s =
        build(r#"{"kind":"mixture","weights":[0.9,0.1],"strategies":[{"kind":"max_info"},{"kind":"random"}]}"#, &list);
    assert!(!s.is_deterministic());
    assert_eq!(s.phases(), ["max_info", "random"]);
    let root = State::initial(&list);
    let greedy = build(r#"{"kind":"max_info"}"#, &list).distribution(&ctx, &root).entries[0].word;
    let d = s.distribution(&ctx, &root);
    check_dist(&ctx, &*s, &root, &d);
    assert_eq!(d.entries.len(), 1 + list.n_answers());
    assert_eq!(d.entries[0].word, greedy);
    assert_eq!(d.entries[0].phase, 0);
    assert!(d.entries[1..].iter().all(|e| e.phase == 1));
    let n = list.n_answers() as f64;
    assert!((d.prob_of(greedy) - (0.9 + 0.1 / n)).abs() < 1e-12);
    // p_chosen is the word's total probability, whichever part drew it.
    let mut r = rng(6);
    let mut phases = [0usize; 2];
    for _ in 0..2000 {
        let c = d.sample(&mut r);
        phases[c.phase as usize] += 1;
        if c.word == greedy {
            assert_eq!(c.p, d.prob_of(greedy));
        } else {
            assert!((c.p - 0.1 / n).abs() < 1e-15);
        }
    }
    assert!(phases[1] > 120 && phases[1] < 290, "{phases:?}");
    // Weights are normalised; a zero-weight part is never consulted.
    let det =
        build(r#"{"kind":"mixture","weights":[0,3],"strategies":[{"kind":"random"},{"kind":"max_info"}]}"#, &list);
    assert!(det.is_deterministic());
    let d = det.distribution(&ctx, &root);
    assert_eq!(d.entries.len(), 1);
    assert_eq!((d.entries[0].word, d.entries[0].p, d.entries[0].phase), (greedy, 1.0, 1));
}

#[test]
fn solve_when_le_modifier() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let det = build(r#"{"kind":"solve_when_le","n":3,"inner":{"kind":"max_info","pool":"allowed"}}"#, &list);
    let sto = build(r#"{"kind":"solve_when_le","n":3,"inner":{"kind":"random","pool":"allowed"}}"#, &list);
    assert!(det.is_deterministic());
    assert!(!sto.is_deterministic());
    assert_eq!(det.phases(), ["max_info", "solve"]);
    assert_eq!(sto.phases(), ["random", "solve"]);
    let mut r = rng(8);
    let mut seen_small = false;
    for t in sample_targets(&list, 80, &mut r) {
        for turn in play(&ctx, &*det, t, &mut r).0 {
            let n = turn.state.candidates.len();
            if n <= 3 {
                seen_small = true;
                assert_eq!(turn.choice.phase, 1);
                assert_eq!(turn.choice.word, ctx.first_candidate(&turn.state));
                let d = sto.distribution(&ctx, &turn.state);
                assert_eq!(d.entries.len(), n);
                assert!(d.entries.iter().all(|e| e.phase == 1 && e.p == 1.0 / n as f64));
                assert!(d.entries.iter().all(|e| ctx.is_candidate(&turn.state, e.word)));
            } else {
                assert_eq!(turn.choice.phase, 0);
            }
        }
    }
    assert!(seen_small);
    assert!(matches!(
        spec(r#"{"kind":"solve_when_le","n":0,"inner":{"kind":"random"}}"#).build(&list),
        Err(BuildError::Invalid(_))
    ));
}

#[test]
fn nested_phases_are_flattened_and_offset() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let s = build(
        r#"{"kind":"mixture","weights":[1,1],"strategies":[
            {"kind":"coverage_then","switch":{"when":"after_turns","k":1},"then":{"kind":"max_info"}},
            {"kind":"solve_when_le","n":20,"inner":{"kind":"random"}}]}"#,
        &list,
    );
    assert_eq!(s.phases(), ["coverage", "max_info", "random", "solve"]);
    let root = State::initial(&list);
    let d = s.distribution(&ctx, &root);
    let phases: std::collections::BTreeSet<u8> = d.entries.iter().map(|e| e.phase).collect();
    assert_eq!(phases.into_iter().collect::<Vec<_>>(), [0, 2]);
    let st = state_after(&ctx, "brand", &["slate"]);
    assert!(st.candidates.len() <= 20);
    let phases: std::collections::BTreeSet<u8> = s.distribution(&ctx, &st).entries.iter().map(|e| e.phase).collect();
    assert_eq!(phases.into_iter().collect::<Vec<_>>(), [1, 3]);

    // A switch inside a switch.
    let s = build(
        r#"{"kind":"switch","when":{"when":"after_turns","k":1},
            "first":{"kind":"sequence_then","words":["slate"],"switch":{"when":"sequence_exhausted"},"then":{"kind":"random"}},
            "then":{"kind":"switch","first":{"kind":"most_frequent"},"then":{"kind":"max_info"},"when":{"when":"candidates_le","n":5}}}"#,
        &list,
    );
    assert_eq!(s.phases(), ["sequence", "random", "most_frequent", "max_info"]);
    assert_eq!(s.distribution(&ctx, &root).entries[0].phase, 0);
    let big = state_after(&ctx, "older", &["saint"]);
    assert!(big.candidates.len() > 5);
    assert_eq!(s.distribution(&ctx, &big).entries[0].phase, 2);
    let small = state_after(&ctx, "apple", &["slate"]);
    assert!(small.candidates.len() <= 5);
    assert_eq!(s.distribution(&ctx, &small).entries[0].phase, 3);
}

#[test]
fn determinism_of_combinations() {
    let list = reference();
    let det = r#"{"kind":"max_info"}"#;
    let sto = r#"{"kind":"random"}"#;
    let sw = |a: &str, b: &str| {
        format!(r#"{{"kind":"switch","first":{a},"then":{b},"when":{{"when":"candidates_le","n":3}}}}"#)
    };
    assert!(build(&sw(det, det), &list).is_deterministic());
    assert!(!build(&sw(det, sto), &list).is_deterministic());
    assert!(!build(&sw(sto, det), &list).is_deterministic());
    let mix = |w: &str| format!(r#"{{"kind":"mixture","weights":{w},"strategies":[{det},{det}]}}"#);
    // Two deterministic parts drawn at random are not deterministic.
    assert!(!build(&mix("[1,1]"), &list).is_deterministic());
    assert!(build(&mix("[1,0]"), &list).is_deterministic());
    let solve = |inner: &str| format!(r#"{{"kind":"solve_when_le","n":2,"inner":{inner}}}"#);
    assert!(build(&solve(det), &list).is_deterministic());
    assert!(!build(&solve(sto), &list).is_deterministic());
    assert!(build(
        r#"{"kind":"coverage_then","switch":{"when":"after_turns","k":1},"then":{"kind":"most_frequent"}}"#,
        &list
    )
    .is_deterministic());
    assert!(!build(
        r#"{"kind":"sequence_then","words":["slate"],"switch":{"when":"sequence_exhausted"},"then":{"kind":"info_proportional"}}"#,
        &list
    )
    .is_deterministic());
}

#[test]
fn candidate_sets_of_one_are_solved_by_every_candidate_strategy() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let a = list.answer_of_word("brand").unwrap();
    let st = State { candidates: CandidateSet::from_iter(list.n_answers(), [a]), turn: 2, history: vec![] };
    for json in [
        r#"{"kind":"max_info"}"#,
        r#"{"kind":"max_info","pool":"allowed"}"#,
        r#"{"kind":"most_frequent"}"#,
        r#"{"kind":"random"}"#,
        r#"{"kind":"info_proportional"}"#,
        r#"{"kind":"info_proportional","pool":"allowed"}"#,
        r#"{"kind":"freq_proportional"}"#,
        r#"{"kind":"coverage_then","switch":{"when":"after_turns","k":4},"then":{"kind":"random"}}"#,
        r#"{"kind":"fixed_sequence","words":["slate","build","dough"]}"#,
    ] {
        let d = build(json, &list).distribution(&ctx, &st);
        assert_eq!(d.entries.len(), 1, "{json}");
        assert_eq!(list.word(d.entries[0].word), "brand", "{json}");
    }
}
