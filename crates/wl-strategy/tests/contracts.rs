//! The contracts every strategy keeps (docs/architecture.md, "Strategies"):
//! valid distributions and phases, hard mode, memoisation keys, serde
//! round trips, schemas, presets and build errors.

mod common;

use std::collections::{HashMap, HashSet};

use common::*;
use wl_core::{AnswerIdx, WordList};
use wl_strategy::catalogue::{default_arrival, presets};
use wl_strategy::spec::{all_schemas, BuildError, Pool, StrategySpec};
use wl_strategy::{estimated_ops_per_state, Ctx, Dist, ParamType, State, StateKey, Strategy};

/// Specs exercising every kind, rule and combinator, with words from ref-en-5.
fn ref_specs() -> Vec<StrategySpec> {
    let mut v: Vec<StrategySpec> = [
        r#"{"kind":"max_info"}"#,
        r#"{"kind":"max_info","pool":"allowed"}"#,
        r#"{"kind":"most_frequent"}"#,
        r#"{"kind":"fixed_sequence","words":["slate","build","dough"]}"#,
        r#"{"kind":"fixed_sequence","words":["build","saint"],"solve_when_one":false}"#,
        r#"{"kind":"random"}"#,
        r#"{"kind":"random","pool":"allowed"}"#,
        r#"{"kind":"info_proportional"}"#,
        r#"{"kind":"info_proportional","beta":3,"pool":"allowed"}"#,
        r#"{"kind":"freq_proportional"}"#,
        r#"{"kind":"freq_proportional","beta":0}"#,
        r#"{"kind":"coverage_then","switch":{"when":"after_turns","k":2},"then":{"kind":"max_info"}}"#,
        r#"{"kind":"coverage_then","switch":{"when":"candidates_le","n":20},"then":{"kind":"random"}}"#,
        r#"{"kind":"coverage_then","switch":{"when":"bits_le","h":3.5},"then":{"kind":"info_proportional"}}"#,
        r#"{"kind":"sequence_then","words":["saint","older"],"switch":{"when":"sequence_exhausted"},"then":{"kind":"max_info"}}"#,
        r#"{"kind":"sequence_then","words":["saint","older","build"],"switch":{"when":"after_turns","k":1},"then":{"kind":"freq_proportional"}}"#,
        r#"{"kind":"switch","first":{"kind":"max_info","pool":"allowed"},"then":{"kind":"most_frequent"},"when":{"when":"candidates_le","n":5}}"#,
        r#"{"kind":"switch","first":{"kind":"fixed_sequence","words":["slate","sound"]},"then":{"kind":"random"},"when":{"when":"sequence_exhausted"}}"#,
        r#"{"kind":"switch","first":{"kind":"solve_when_le","n":4,"inner":{"kind":"fixed_sequence","words":["slate","sound"]}},"then":{"kind":"max_info"},"when":{"when":"sequence_exhausted"}}"#,
        r#"{"kind":"mixture","weights":[0.9,0.1],"strategies":[{"kind":"max_info"},{"kind":"random"}]}"#,
        r#"{"kind":"mixture","weights":[1,0,2],"strategies":[{"kind":"most_frequent"},{"kind":"random"},{"kind":"switch","first":{"kind":"random","pool":"allowed"},"then":{"kind":"max_info"},"when":{"when":"after_turns","k":1}}]}"#,
        r#"{"kind":"solve_when_le","n":3,"inner":{"kind":"max_info","pool":"allowed"}}"#,
        r#"{"kind":"solve_when_le","n":10,"inner":{"kind":"info_proportional","pool":"allowed"}}"#,
    ]
    .iter()
    .map(|j| spec(j))
    .collect();
    // The presets that build on the reference list.
    let list = reference();
    v.extend(presets().into_iter().map(|p| p.spec).filter(|s| s.build(&list).is_ok()));
    v
}

#[test]
fn every_spec_plays_valid_games() {
    let list = reference();
    let m = matrix(&list);
    let mut r = rng(11);
    let targets = sample_targets(&list, 30, &mut r);
    for spec in ref_specs() {
        let s = spec.build(&list).unwrap();
        for hard in [false, true] {
            let ctx = Ctx::new(&list, &m, rules(hard));
            for &t in &targets {
                // `play` checks every distribution: sums, phases, hard mode.
                let (turns, solved) = play(&ctx, &*s, t, &mut r);
                assert!(!turns.is_empty() && turns.len() <= 6);
                assert!(solved || turns.len() == 6);
            }
            let root = State::initial(&list);
            let top = s.scores(&ctx, &root, 5);
            assert!(!top.is_empty() && top.len() <= 5, "{}", spec.canonical_json());
            assert!(top.windows(2).all(|w| w[0].1 >= w[1].1));
        }
    }
}

/// States reached by walking with random allowed guesses, plus states with
/// the same candidates reached another way: the last two guesses swapped,
/// or an extra guess that reveals nothing (same C, one turn later).
fn exploration_states(ctx: &Ctx, seed: u64) -> Vec<State> {
    let list = ctx.list;
    let mut r = rng(seed);
    let walker = build(r#"{"kind":"random","pool":"allowed"}"#, list);
    let mut states = vec![State::initial(list)];
    for t in sample_targets(list, 40, &mut r) {
        let mut st = State::initial(list);
        for _ in 0..4 {
            let g = walker.distribution(ctx, &st).sample(&mut r).word;
            let p = ctx.matrix.get(g, t);
            if p.is_all_correct(list.word_len()) {
                break;
            }
            st = st.apply(ctx, g, p);
            states.push(st.clone());
        }
    }
    let mut extra = Vec::new();
    for st in &states {
        let n = st.history.len();
        if n >= 2 {
            // Replay with the last two guesses swapped.
            let mut h = st.history.clone();
            h.swap(n - 2, n - 1);
            let mut s2 = State::initial(list);
            for &(g, p) in &h {
                s2 = s2.apply(ctx, g, p);
            }
            assert_eq!(s2.candidates, st.candidates);
            extra.push(s2);
        }
        if st.candidates.len() <= 40 {
            // A guess that gives every candidate the same feedback.
            let blank = (0..list.n_guesses() as u16).find(|&g| ctx.matrix.partition(&st.candidates, g).len() == 1);
            if let Some(g) = blank {
                let p = ctx.matrix.get(g, st.candidates.first().unwrap());
                let s2 = st.apply(ctx, g, p);
                assert_eq!(s2.candidates, st.candidates);
                extra.push(s2);
            }
        }
    }
    states.extend(extra);
    states
}

/// Equal keys ⇒ equal distributions, for every spec, with and without hard mode.
#[test]
fn equal_keys_give_equal_distributions() {
    let list = reference();
    let m = matrix(&list);
    for hard in [false, true] {
        let ctx = Ctx::new(&list, &m, rules(hard));
        let states = exploration_states(&ctx, 21 + hard as u64);
        // Same candidates, different histories: the interesting pairs.
        let mut by_cands: HashMap<u64, usize> = HashMap::new();
        for st in &states {
            *by_cands.entry(st.candidates.hash64()).or_default() += 1;
        }
        assert!(by_cands.values().filter(|&&n| n > 1).count() > 20);
        for spec in ref_specs() {
            let s = spec.build(&list).unwrap();
            let mut seen: HashMap<StateKey, (Dist, &State)> = HashMap::new();
            let mut shared = 0;
            for st in &states {
                let d = s.distribution(&ctx, st);
                let k = s.state_key(st);
                assert_eq!(k, s.state_key(st), "keys are stable");
                match seen.get(&k) {
                    Some((d0, st0)) => {
                        shared += (st0.history != st.history) as usize;
                        assert_eq!(
                            d0,
                            &d,
                            "{} (hard={hard}): equal keys, different distributions\n{:?}\n{:?}",
                            spec.canonical_json(),
                            st0.history,
                            st.history
                        );
                    }
                    None => {
                        seen.insert(k, (d, st));
                    }
                }
            }
            // Candidate-keyed strategies share entries across histories.
            if matches!(spec, StrategySpec::MaxInfo { pool: Pool::Candidates } | StrategySpec::Random { pool: Pool::Candidates }) {
                assert!(shared > 0, "{}", spec.canonical_json());
            }
        }
    }
}

/// Keys separate what must be separated: the turn for sequences and
/// after-k switches, the history for hard mode over the allowed pool.
#[test]
fn keys_include_turn_and_history_when_needed() {
    let list = reference();
    let m = matrix(&list);
    let ctx = Ctx::new(&list, &m, rules(false));
    let a = state_after(&ctx, "brand", &["slate"]);
    // "zzzzz" is not a word; find a guess that reveals nothing here.
    let g = (0..list.n_guesses() as u16).find(|&g| m.partition(&a.candidates, g).len() == 1).unwrap();
    let b = a.apply(&ctx, g, m.get(g, a.candidates.first().unwrap()));
    assert_eq!((a.candidates == b.candidates, a.turn + 1), (true, b.turn));
    let key = |json: &str, st: &State| build(json, &list).state_key(st);
    // Same C, different turn.
    assert_eq!(key(r#"{"kind":"max_info"}"#, &a), key(r#"{"kind":"max_info"}"#, &b));
    for json in [
        r#"{"kind":"fixed_sequence","words":["slate","build","dough"]}"#,
        r#"{"kind":"switch","first":{"kind":"random"},"then":{"kind":"max_info"},"when":{"when":"after_turns","k":2}}"#,
        r#"{"kind":"max_info","pool":"allowed"}"#,
        r#"{"kind":"coverage_then","switch":{"when":"candidates_le","n":1},"then":{"kind":"max_info"}}"#,
    ] {
        assert_ne!(key(json, &a), key(json, &b), "{json}");
    }
}

// ---------------------------------------------------------------------------
// Serde, schemas, presets

fn round_trip(spec: &StrategySpec) {
    let json = serde_json::to_string(spec).unwrap();
    assert_eq!(&StrategySpec::from_json(&json).unwrap(), spec, "{json}");
    let canonical = spec.canonical_json();
    let back = StrategySpec::from_json(&canonical).unwrap();
    assert_eq!(&back, spec);
    assert_eq!(back.canonical_json(), canonical);
}

#[test]
fn specs_round_trip_through_json() {
    for s in ref_specs() {
        round_trip(&s);
    }
    for p in presets() {
        round_trip(&p.spec);
    }
    // Defaults are filled in, so the canonical form is complete.
    assert_eq!(
        spec(r#"{"kind":"info_proportional"}"#).canonical_json(),
        r#"{"beta":1.0,"kind":"info_proportional","pool":"candidates"}"#
    );
    assert_eq!(spec(r#"{"kind":"max_info"}"#).canonical_json(), r#"{"kind":"max_info","pool":"candidates"}"#);
    assert_eq!(
        spec(r#"{"kind":"fixed_sequence","words":["slate"]}"#).canonical_json(),
        r#"{"kind":"fixed_sequence","solve_when_one":true,"words":["slate"]}"#
    );
    assert_eq!(
        spec(r#"{"kind":"switch","first":{"kind":"random"},"then":{"kind":"max_info"},"when":{"when":"bits_le","h":2.5}}"#)
            .canonical_json(),
        r#"{"first":{"kind":"random","pool":"candidates"},"kind":"switch","then":{"kind":"max_info","pool":"candidates"},"when":{"h":2.5,"when":"bits_le"}}"#
    );
    assert_eq!(default_arrival().canonical_json(), r#"{"beta":1.0,"kind":"info_proportional","pool":"candidates"}"#);
    // Unknown kinds, fields and rules are rejected.
    for bad in [
        r#"{"kind":"best_guess"}"#,
        r#"{"kind":"random","beta":1}"#,
        r#"{"kind":"max_info","pool":"everything"}"#,
        r#"{"kind":"switch","first":{"kind":"random"},"then":{"kind":"random"},"when":{"when":"never"}}"#,
        r#"{"kind":"mixture","weights":[1]}"#,
    ] {
        assert!(StrategySpec::from_json(bad).is_err(), "{bad}");
    }
}

#[test]
fn schemas_cover_every_kind_in_order() {
    let schemas = all_schemas();
    let kinds: Vec<_> = schemas.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        [
            "max_info",
            "most_frequent",
            "fixed_sequence",
            "random",
            "info_proportional",
            "freq_proportional",
            "coverage_then",
            "sequence_then",
            "switch",
            "mixture",
            "solve_when_le"
        ]
    );
    let open = load("open-en-5");
    for schema in &schemas {
        assert!(!schema.label.is_empty() && !schema.description.is_empty());
        assert!(["deterministic", "stochastic", "hybrid"].contains(&schema.determinism));
        let names: HashSet<_> = schema.params.iter().map(|p| p.name).collect();
        assert_eq!(names.len(), schema.params.len(), "{}: duplicate parameter", schema.kind);
        // The defaults form a valid spec of this kind that builds.
        let mut obj = serde_json::Map::new();
        obj.insert("kind".into(), schema.kind.into());
        for p in &schema.params {
            assert!(!p.label.is_empty() && !p.help.is_empty(), "{}.{}", schema.kind, p.name);
            match &p.ty {
                ParamType::Number { min, max, step } => {
                    let d = p.default.as_f64().unwrap();
                    assert!(min <= &d && &d <= max && *step > 0.0, "{}.{}", schema.kind, p.name);
                }
                ParamType::Integer { min, max } => {
                    let d = p.default.as_i64().unwrap();
                    assert!(*min <= d && d <= *max, "{}.{}", schema.kind, p.name);
                }
                ParamType::Words { min, max } => {
                    let n = p.default.as_array().unwrap().len();
                    assert!(*min <= n && n <= *max);
                }
                ParamType::Choice { options } => {
                    assert!(options.iter().any(|o| p.default == o.value), "{}.{}", schema.kind, p.name);
                }
                _ => {}
            }
            obj.insert(p.name.into(), p.default.clone());
        }
        let json = serde_json::Value::Object(obj).to_string();
        let spec = StrategySpec::from_json(&json).unwrap_or_else(|e| panic!("{json}: {e}"));
        assert_eq!(spec.kind(), schema.kind);
        let built = spec.build(&open).unwrap_or_else(|e| panic!("{json}: {e}"));
        assert_eq!(built.resources(), schema.needs, "{}", schema.kind);
        let det = match schema.determinism {
            "deterministic" => Some(true),
            "stochastic" => Some(false),
            _ => None,
        };
        if let Some(det) = det {
            assert_eq!(built.is_deterministic(), det, "{}", schema.kind);
        }
    }
    // The JSON shape the Lab reads (web/src/backend/types.ts, StrategySchema).
    let v = serde_json::to_value(&schemas[4]).unwrap();
    assert_eq!(v["kind"], "info_proportional");
    assert_eq!(v["needs"]["frequencies"], false);
    assert_eq!(v["params"][0]["type"], serde_json::json!({"type": "number", "min": 0.0, "max": 20.0, "step": 0.1}));
    assert_eq!(v["params"][1]["type"]["type"], "choice");
    let v = serde_json::to_value(&schemas[8]).unwrap();
    assert_eq!(v["params"][2]["type"], serde_json::json!({"type": "switch_rule"}));
}

#[test]
fn presets_cover_the_catalogue() {
    let ps = presets();
    let open = load("open-en-5");
    assert_eq!(ps[0].spec, default_arrival());
    let ids: HashSet<_> = ps.iter().map(|p| p.id).collect();
    let colours: HashSet<_> = ps.iter().map(|p| p.colour.to_ascii_lowercase()).collect();
    let labels: HashSet<_> = ps.iter().map(|p| p.label).collect();
    assert_eq!((ids.len(), colours.len(), labels.len()), (ps.len(), ps.len(), ps.len()));
    let kinds: HashSet<_> = ps.iter().map(|p| p.spec.kind()).collect();
    for k in [
        "max_info",
        "most_frequent",
        "fixed_sequence",
        "random",
        "info_proportional",
        "freq_proportional",
        "coverage_then",
        "sequence_then",
        "mixture",
    ] {
        assert!(kinds.contains(k), "no preset for {k}");
    }
    assert!(ps.iter().any(|p| p.spec == StrategySpec::MaxInfo { pool: Pool::Allowed }));
    assert!(ps.iter().any(|p| p.spec == StrategySpec::MaxInfo { pool: Pool::Candidates }));
    for p in &ps {
        assert!(p.label.chars().count() <= 32, "{}: label too long", p.id);
        assert!(p.colour.len() == 7 && p.colour.starts_with('#'));
        assert!(p.colour[1..].chars().all(|c| c.is_ascii_hexdigit()));
        let s = p.spec.build(&open).unwrap_or_else(|e| panic!("{}: {e}", p.id));
        assert!(!s.phases().is_empty());
        let v = serde_json::to_value(p).unwrap();
        assert_eq!(v["spec"]["kind"], p.spec.kind());
    }
    // The hybrids report their parts.
    let phases = |id: &str| ps.iter().find(|p| p.id == id).unwrap().spec.build(&open).unwrap().phases();
    assert_eq!(phases("coverage_then"), ["coverage", "max_info"]);
    assert_eq!(phases("sequence_then"), ["sequence", "max_info"]);
    assert_eq!(phases("epsilon_greedy"), ["max_info", "random"]);
}

/// A few games of every preset on the shipped list, memoised by state key
/// as the engine does (which also keeps this fast in debug builds).
#[test]
fn presets_play_on_open_en_5() {
    let list = load("open-en-5");
    let m = matrix(&list);
    let mut r = rng(31);
    let targets = sample_targets(&list, 6, &mut r);
    for hard in [false, true] {
        let ctx = Ctx::new(&list, &m, rules(hard));
        for p in presets() {
            let s = p.spec.build(&list).unwrap();
            let mut memo: HashMap<StateKey, Dist> = HashMap::new();
            for &t in &targets {
                play_memo(&ctx, &*s, t, &mut memo, &mut r);
            }
        }
    }
}

fn play_memo(
    ctx: &Ctx,
    s: &dyn Strategy,
    target: AnswerIdx,
    memo: &mut HashMap<StateKey, Dist>,
    r: &mut rand_chacha::ChaCha8Rng,
) {
    let mut st = State::initial(ctx.list);
    while st.turn < ctx.rules.max_guesses {
        let d = memo.entry(s.state_key(&st)).or_insert_with(|| s.distribution(ctx, &st));
        check_dist(ctx, s, &st, d);
        let c = d.sample(r);
        let p = ctx.matrix.get(c.word, target);
        if p.is_all_correct(ctx.list.word_len()) {
            return;
        }
        st = st.apply(ctx, c.word, p);
    }
}

// ---------------------------------------------------------------------------
// Build errors and the cost guard

#[test]
fn build_errors() {
    let list = reference();
    let bare = WordList::from_words(wl_core::Manifest::adhoc("bare", 5), &["crane", "slate"], &["crane"]).unwrap();
    let err = |json: &str, l: &WordList| spec(json).build(l).err();
    assert_eq!(
        err(r#"{"kind":"sequence_then","words":["slate","qqqqq"],"switch":{"when":"sequence_exhausted"},"then":{"kind":"random"}}"#, &list),
        Some(BuildError::UnknownWord("qqqqq".into()))
    );
    // Frequencies are needed wherever the part sits.
    assert_eq!(
        err(r#"{"kind":"mixture","weights":[1,1],"strategies":[{"kind":"random"},{"kind":"solve_when_le","n":2,"inner":{"kind":"freq_proportional"}}]}"#, &bare),
        Some(BuildError::NeedsFrequencies("freq_proportional"))
    );
    assert_eq!(
        err(r#"{"kind":"coverage_then","switch":{"when":"after_turns","k":2},"then":{"kind":"most_frequent"}}"#, &bare),
        Some(BuildError::NeedsFrequencies("most_frequent"))
    );
    assert!(spec(r#"{"kind":"max_info"}"#).build(&bare).is_ok());
    for bad in [
        r#"{"kind":"info_proportional","beta":-1}"#,
        r#"{"kind":"freq_proportional","beta":-0.5}"#,
        r#"{"kind":"mixture","weights":[1],"strategies":[{"kind":"random"},{"kind":"max_info"}]}"#,
        r#"{"kind":"mixture","weights":[0,0],"strategies":[{"kind":"random"},{"kind":"max_info"}]}"#,
        r#"{"kind":"mixture","weights":[-1,2],"strategies":[{"kind":"random"},{"kind":"max_info"}]}"#,
        r#"{"kind":"mixture","weights":[],"strategies":[]}"#,
        r#"{"kind":"switch","first":{"kind":"random"},"then":{"kind":"random"},"when":{"when":"bits_le","h":-1}}"#,
        r#"{"kind":"solve_when_le","n":0,"inner":{"kind":"random"}}"#,
        r#"{"kind":"fixed_sequence","words":[]}"#,
    ] {
        assert!(matches!(err(bad, &list), Some(BuildError::Invalid(_))), "{bad}");
    }
    // Phases are numbered in a u8 (254 and 255 are reserved).
    let many = StrategySpec::Mixture {
        weights: vec![1.0; 300],
        strategies: vec![StrategySpec::Random { pool: Pool::Candidates }; 300],
    };
    assert!(matches!(many.build(&list), Err(BuildError::Invalid(_))));
    let ok = StrategySpec::Mixture {
        weights: vec![1.0; 200],
        strategies: vec![StrategySpec::Random { pool: Pool::Candidates }; 200],
    };
    assert_eq!(ok.build(&list).unwrap().phases().len(), 200);
}

#[test]
fn cost_guard_flags_allowed_pool_information() {
    let (g, a) = (8636, 2500);
    let cost = |json: &str| estimated_ops_per_state(&spec(json), g, a);
    let cheap = cost(r#"{"kind":"max_info"}"#);
    let dear = cost(r#"{"kind":"max_info","pool":"allowed"}"#);
    assert!(dear > 3.0 * cheap);
    assert_eq!(cost(r#"{"kind":"info_proportional","pool":"allowed"}"#), dear);
    assert!(cost(r#"{"kind":"most_frequent"}"#) < cheap);
    // A switch pays for its dearer side; a mixture for every weighted part.
    assert_eq!(
        cost(r#"{"kind":"switch","first":{"kind":"max_info","pool":"allowed"},"then":{"kind":"random"},"when":{"when":"after_turns","k":1}}"#),
        dear
    );
    assert_eq!(
        cost(r#"{"kind":"mixture","weights":[1,1],"strategies":[{"kind":"max_info"},{"kind":"max_info","pool":"allowed"}]}"#),
        cheap + dear
    );
}
