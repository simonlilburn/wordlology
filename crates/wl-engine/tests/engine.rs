//! Behaviour of games and runs on the reference list: decision trees agree
//! with single games, streams are reproducible across scopes, selections,
//! step budgets and runs, and continued games replay their prefix.

mod common;

use std::collections::HashSet;

use common::*;
use wl_core::hard_mode_ok;
use wl_engine::batch::{decode_batches, encode_batches};
use wl_engine::config::answers_sha256;
use wl_engine::seed::game_seed;
use wl_engine::{AnswerSelection, Game, Run, Scope, Targets, PHASE_OPENER, PHASE_PLAYER};
use wl_strategy::{Pool, StrategySpec};

fn max_info(pool: Pool) -> StrategySpec {
    StrategySpec::MaxInfo { pool }
}

fn info_prop() -> StrategySpec {
    StrategySpec::InfoProportional { beta: 1.0, pool: Pool::Candidates }
}

#[test]
fn deterministic_tree_matches_single_games() {
    let e = reference();
    for (spec, opener, hard) in [
        (max_info(Pool::Candidates), Some("slate"), false),
        (max_info(Pool::Candidates), None, false),
        (max_info(Pool::Allowed), Some("crane"), false),
        (max_info(Pool::Allowed), None, true),
    ] {
        let mut c = config(&e, spec, opener, 1);
        c.rules.hard_mode = hard;
        let prep = prepare(&e, &c);
        let games = run_all(&e, &c, &Scope::all());
        assert_eq!(games.len(), e.list.n_answers());
        let targets: HashSet<u16> = games.iter().map(|g| g.target).collect();
        assert_eq!(targets.len(), e.list.n_answers());
        for g in &games {
            assert_eq!(*g, prep.play(&e, g.target, 0, None), "target {}", e.list.word(e.list.answer_word(g.target)));
            let first = &g.turns[0];
            match opener {
                Some(o) => {
                    assert_eq!(e.list.word(first.guess), o);
                    assert_eq!((first.phase, first.p_chosen), (PHASE_OPENER, 1.0));
                }
                None => assert_eq!(first.phase, 0),
            }
            if hard {
                let history: Vec<_> = g.turns.iter().map(|t| (t.guess, wl_core::Pattern(t.pattern))).collect();
                for i in 1..history.len() {
                    assert!(hard_mode_ok(&e.list, history[i].0, &history[..i]));
                }
            }
        }
    }
}

#[test]
fn deterministic_rows_settle_top_down() {
    let e = reference();
    let c = config(&e, max_info(Pool::Candidates), None, 1);
    let mut run = Run::new(e.clone(), prepare(&e, &c), &Scope::all()).unwrap();
    let mut emitted: Vec<Game> = Vec::new();
    let mut last_settled = 0;
    while !run.is_done() {
        emitted.extend(run.step_units(3));
        let p = run.progress();
        let settled = p.settled_depth.unwrap();
        assert!(settled >= last_settled);
        last_settled = settled;
        assert_eq!(p.done as usize, emitted.len());
        assert_eq!(p.unresolved.unwrap(), p.total - p.done);
        // Every game ending at or before the settled depth is already out.
        let all = run_all(&e, &c, &Scope::all());
        let out: HashSet<u16> = emitted.iter().map(|g| g.target).collect();
        for g in all.iter().filter(|g| g.n_guesses() <= settled as usize) {
            assert!(out.contains(&g.target));
        }
        if emitted.len() > 150 {
            break;
        }
    }
    // Games come out in order of their length.
    let lens: Vec<usize> = emitted.iter().map(|g| g.n_guesses()).collect();
    assert!(lens.windows(2).all(|w| w[0] <= w[1]));
}

#[test]
fn single_target_follows_one_path() {
    let e = reference();
    let c = config(&e, max_info(Pool::Allowed), Some("slate"), 1);
    let prep = prepare(&e, &c);
    let t = e.list.answer_of_word("house").unwrap_or(17);
    let mut run = Run::new(e.clone(), prep, &Scope::targets(vec![t])).unwrap();
    let mut games = Vec::new();
    let mut units = 0;
    while !run.is_done() {
        games.extend(run.step_units(1));
        units += 1;
    }
    assert_eq!(games.len(), 1);
    assert_eq!(units, games[0].n_guesses(), "one node per guess");
    assert_eq!(games[0], prepare(&e, &c).play(&e, t, 0, None));
    // A replicate range that excludes replicate 0 plays nothing.
    let run =
        Run::new(e.clone(), prepare(&e, &c), &Scope { targets: Targets::List(vec![t]), replicates: Some([1, 5]) });
    assert!(run.unwrap().is_done());
}

#[test]
fn stochastic_games_ignore_step_budgets() {
    let e = reference();
    let c = config(&e, info_prop(), Some("crane"), 3);
    let scope = Scope { targets: Targets::Sample(25), replicates: None };
    let all = run_all(&e, &c, &scope);
    assert_eq!(all.len(), 75);
    let mut run = Run::new(e.clone(), prepare(&e, &c), &scope).unwrap();
    let mut stepped = Vec::new();
    let mut n = 1;
    while !run.is_done() {
        stepped.extend(run.step_units(n));
        n = n % 7 + 1;
    }
    assert_eq!(stepped, all);
    // Replicates interleave: every target at r = 0 first, then r = 1.
    assert!(all[..25].iter().all(|g| g.replicate == 0));
    assert!(all[25..50].iter().all(|g| g.replicate == 1));
    let order: Vec<u16> = all[..25].iter().map(|g| g.target).collect();
    assert_eq!(order, all[25..50].iter().map(|g| g.target).collect::<Vec<_>>());
    // A sample is the first n of the seeded order of all targets.
    let full = run_all(&e, &c, &Scope { targets: Targets::All, replicates: Some([0, 1]) });
    assert_eq!(full[..25].iter().map(|g| g.target).collect::<Vec<_>>(), order);
    // Identical across runs, and the same games come back from a batch.
    assert_eq!(run_all(&e, &c, &scope), all);
    assert_eq!(decode_batches(&encode_batches(&all)).unwrap(), all);
    // Every game's replicate matches its own stream.
    let prep = prepare(&e, &c);
    for g in &all {
        assert_eq!(*g, prep.play(&e, g.target, g.replicate, None));
    }
}

#[test]
fn stochastic_progress() {
    let e = reference();
    let c = config(&e, StrategySpec::Random { pool: Pool::Candidates }, None, 4);
    let scope = Scope { targets: Targets::List(vec![5, 3, 9, 3]), replicates: Some([1, 3]) };
    let mut run = Run::new(e.clone(), prepare(&e, &c), &scope).unwrap();
    let p = run.progress();
    assert_eq!((p.done, p.total, p.targets_done, p.targets_total), (0, 6, 0, 3));
    assert!(p.settled_depth.is_none());
    let first = run.step_units(4);
    assert_eq!(first.iter().map(|g| (g.target, g.replicate)).collect::<Vec<_>>(), vec![(5, 1), (3, 1), (9, 1), (5, 2)]);
    assert_eq!(run.progress().targets_done, 1);
    run.run_to_end();
    let p = run.progress();
    assert_eq!((p.done, p.targets_done), (6, 3));
    let s = run.summary();
    assert_eq!((s.n_games, s.deterministic), (6, false));
    assert_eq!(s.phases, vec!["random".to_string()]);
    // Out-of-range scopes are rejected.
    assert!(Run::new(e.clone(), prepare(&e, &c), &Scope { targets: Targets::All, replicates: Some([0, 5]) }).is_err());
    assert!(Run::new(e.clone(), prepare(&e, &c), &Scope::targets(vec![300])).is_err());
    // Cancelling stops the run.
    let mut run = Run::new(e.clone(), prepare(&e, &c), &Scope::all()).unwrap();
    run.step_units(2);
    run.cancel();
    assert!(run.is_done() && run.step_units(5).is_empty());
}

#[test]
fn replicates_agree_between_tree_and_card_scopes() {
    let e = reference();
    let t = 42;
    let tree_cfg = config(&e, info_prop(), Some("slate"), 200);
    let tree = run_all(&e, &tree_cfg, &Scope::targets(vec![t]));
    assert_eq!(tree.len(), 200);
    assert!(tree.iter().enumerate().all(|(r, g)| g.replicate == r as u32 && g.target == t));
    let card_cfg = config(&e, info_prop(), Some("slate"), 20);
    let card = run_all(&e, &card_cfg, &Scope::all());
    assert_eq!(card.len(), 20 * e.list.n_answers());
    let mut from_card: Vec<&Game> = card.iter().filter(|g| g.target == t).collect();
    from_card.sort_by_key(|g| g.replicate);
    assert_eq!(from_card.len(), 20);
    for (a, b) in from_card.iter().zip(&tree) {
        assert_eq!(*a, b);
    }
    // A tree does branch.
    let paths: HashSet<Vec<u16>> = tree.iter().map(|g| g.turns.iter().map(|t| t.guess).collect()).collect();
    assert!(paths.len() > 1);
}

#[test]
fn streams_are_keyed_on_words_across_answer_selections() {
    let e = reference();
    let words: Vec<String> = e.list.answers().iter().map(|&id| e.list.word(id).to_string()).collect();
    // The same answers pasted give the same games.
    let mut pasted = config(&e, info_prop(), None, 2);
    pasted.word_list.answers = AnswerSelection::Pasted { sha256: String::new(), words: Some(words.clone()) };
    let prep_pasted = prepare(&e, &pasted);
    assert_ne!(prep_pasted.config_id, prepare(&e, &config(&e, info_prop(), None, 2)).config_id);
    let default = config(&e, info_prop(), None, 2);
    let a = run_all(&e, &default, &Scope { targets: Targets::Sample(10), replicates: None });
    let b = run_all(&e, &pasted, &Scope { targets: Targets::Sample(10), replicates: None });
    assert_eq!(a, b);
    // A subset selection shifts answer indices but keeps each target's stream.
    let subset: Vec<String> = words.iter().skip(7).step_by(3).cloned().collect();
    let sub_list = wl_engine::config::resolve_answers(
        &e.list,
        None,
        &AnswerSelection::Pasted { sha256: answers_sha256(&subset), words: Some(subset.clone()) },
    )
    .unwrap();
    let sub = wl_engine::Engine::new(sub_list);
    let mut sub_cfg = config(&sub, info_prop(), None, 2);
    sub_cfg.word_list.answers = AnswerSelection::Pasted { sha256: answers_sha256(&subset), words: None };
    let sub_prep = sub.prepare(&sub_cfg).unwrap();
    let full_prep = prepare(&e, &default);
    assert_eq!(sub_prep.strategy_json, full_prep.strategy_json);
    let w = &subset[4];
    assert_ne!(sub.list.answer_of_word(w), e.list.answer_of_word(w));
    let seed =
        |p: &wl_engine::Prepared| game_seed(p.config.base_seed, &p.strategy_json, p.config.opener.as_deref(), w, 1);
    assert_eq!(seed(&sub_prep), seed(&full_prep));
    // The pasted hash must match the solver's answers.
    let mut wrong = sub_cfg.clone();
    wrong.word_list.answers = AnswerSelection::Pasted { sha256: answers_sha256(&words), words: None };
    assert!(sub.prepare(&wrong).is_err());
}

#[test]
fn continue_game_replays_prefixes() {
    let e = reference();
    for (spec, opener) in
        [(info_prop(), None), (info_prop(), Some("crane")), (max_info(Pool::Candidates), Some("slate"))]
    {
        let c = config(&e, spec, opener, 10);
        let prep = prepare(&e, &c);
        for (t, r) in [(3u16, 0u32), (150, 7), (299, 3)] {
            let g = prep.play(&e, t, r, None);
            let guesses: Vec<u16> = g.turns.iter().map(|t| t.guess).collect();
            for k in 0..=guesses.len() {
                let full = prep.continue_game(&e, &guesses[..k], t, r, false).unwrap();
                assert_eq!(full, g, "prefix {k}");
                let one = prep.continue_game(&e, &guesses[..k], t, r, true).unwrap();
                let want = (k + 1).min(g.turns.len());
                assert_eq!(one.turns, g.turns[..want], "one step from {k}");
            }
        }
    }
    // A deviating prefix is marked as the player's, with the strategy's probability.
    let c = config(&e, info_prop(), Some("crane"), 10);
    let prep = prepare(&e, &c);
    let target = 10;
    let other = e.list.id("slate").unwrap();
    let g = prep.continue_game(&e, &[other], target, 0, false).unwrap();
    assert_eq!((g.turns[0].guess, g.turns[0].phase, g.turns[0].p_chosen), (other, PHASE_PLAYER, 0.0));
    assert!(g.turns[1..].iter().all(|t| t.phase == 0));
    let crane = e.list.id("crane").unwrap();
    let base = prep.play(&e, target, 0, None);
    let dev = if base.turns.get(1).map(|t| t.guess) == Some(other) { e.list.id("trace").unwrap() } else { other };
    let g2 = prep.continue_game(&e, &[crane, dev], target, 0, true).unwrap();
    assert_eq!(g2.turns[0], base.turns[0]);
    assert_eq!((g2.turns[1].guess, g2.turns[1].phase), (dev, PHASE_PLAYER));
    assert!((0.0..1.0).contains(&g2.turns[1].p_chosen));
    assert_eq!(g2.turns.len(), 3);
    assert_ne!(g2.turns[2].phase, PHASE_PLAYER);
    // Invalid prefixes are rejected.
    assert!(prep.continue_game(&e, &[9999], target, 0, false).is_err());
    assert!(prep.continue_game(&e, &[crane; 7], target, 0, false).is_err());
    assert!(prep.continue_game(&e, &[crane], 300, 0, false).is_err());
    let t_word = e.list.answer_word(target);
    assert!(prep.continue_game(&e, &[t_word, crane], target, 0, false).is_err());
}

#[test]
fn every_implemented_preset_plays_valid_games() {
    let e = reference();
    for p in wl_strategy::catalogue::presets() {
        if !builds(&e, &p.spec) {
            continue;
        }
        for hard in [false, true] {
            let mut c = config(&e, p.spec.clone(), None, 2);
            c.rules.hard_mode = hard;
            let prep = prepare(&e, &c);
            let games = run_all(&e, &c, &Scope { targets: Targets::Sample(12), replicates: None });
            assert_eq!(games.len(), if prep.deterministic { 12 } else { 24 });
            for g in &games {
                assert!(g.n_guesses() >= 1 && g.n_guesses() <= 6);
                assert_eq!(g.solved, g.turns.last().unwrap().guess == e.list.answer_word(g.target));
                let mut before = e.list.n_answers() as u16;
                for (i, t) in g.turns.iter().enumerate() {
                    assert_eq!(t.cands_before, before);
                    assert!(t.cands_after >= 1 && t.cands_after <= t.cands_before);
                    assert!(t.p_chosen > 0.0 && t.p_chosen <= 1.0 + 1e-6);
                    assert!((t.phase as usize) < prep.phases.len() || t.phase == PHASE_OPENER);
                    let p = wl_core::feedback(e.list.letters(t.guess), e.list.letters(e.list.answer_word(g.target)));
                    assert_eq!(t.pattern, p.0);
                    if hard && i > 0 {
                        let h: Vec<_> = g.turns[..i].iter().map(|t| (t.guess, wl_core::Pattern(t.pattern))).collect();
                        assert!(hard_mode_ok(&e.list, t.guess, &h), "{} breaks hard mode", p.to_letters(5));
                    }
                    before = t.cands_after;
                }
            }
        }
    }
}
