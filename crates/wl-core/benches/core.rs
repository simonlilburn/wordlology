use criterion::{criterion_group, criterion_main, Criterion};
use wl_core::{feedback, CandidateSet, PatternMatrix};

fn load() -> wl_core::WordList {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/wordlists/open-en-5");
    wl_core::load_dir(&dir).expect("word list")
}

fn benches(c: &mut Criterion) {
    let list = load();
    c.bench_function("feedback", |b| {
        b.iter(|| feedback(std::hint::black_box(b"speed"), std::hint::black_box(b"abide")))
    });
    let mut g = c.benchmark_group("matrix");
    g.sample_size(10);
    g.bench_function("build open-en-5", |b| b.iter(|| PatternMatrix::build(&list)));
    g.finish();
    let m = PatternMatrix::build(&list);
    let all = CandidateSet::full(list.n_answers());
    let mut scratch = vec![0u32; m.n_patterns()];
    c.bench_function("expected_info all answers", |b| {
        b.iter(|| wl_core::expected_info(&m, list.id("crane").unwrap(), &all, &mut scratch))
    });
}

criterion_group!(core, benches);
criterion_main!(core);
