# wordlology — Architecture and contracts

This document pins down the interfaces between the parts of wordlology so they
can be built and tested independently. The product behaviour is in
[specification.md](specification.md); where this document is more precise, it
is the reference. Deviations from the specification are listed at the end.

## Repository layout and ownership

```text
crates/wl-core/       words, patterns, bitsets, entropy, hard mode, letter filters
crates/wl-strategy/   Strategy trait, catalogue, combinators, schemas
crates/wl-engine/     games, tries, cards, pairs, export rows (CSV)
crates/wl-wasm/       wasm-bindgen API, worker protocol encoding
crates/wl-cli/        native binary: play, card, export, bench, precompute
data/wordlists/       build.py, blocklist, review exclusions, built lists
data/testvectors/     JSON vectors shared by the Rust and TypeScript tests
precomputed/          results built by wl-cli, copied into the web app
web/src/app/          store, init, URL state, keyboard, settings persistence, toasts
web/src/backend/      SolverBackend types and implementations, worker pool
web/src/model/        word data, feedback, runs, tries, card statistics, filter, rankings, compare
web/src/export/       CSV writers, zip, R snippet, export dialog
web/src/views/game/   the board, replay mode, annotations, hint chip
web/src/scene/        three.js scene core, tree layer, card and atlas layers, transitions
web/src/views/        DOM overlays and text alternatives for tree, card and atlas
web/src/panes/        side pane, target browser, filter builder, search, dialogs
web/src/lab/          Strategy Lab
```

## Word lists

A word list is a directory with `manifest.json` and plain files:

- `guesses.txt`: one lowercase word per line, sorted. A **word id** (`WordId`,
  u16) is a word's line index, so lower ids are alphabetically earlier.
- `answers.txt`: the default answers, sorted; a subset of guesses. An
  **answer index** (`AnswerIdx`, u16) is a word's line index here.
- `answers-ranked.txt` (optional): reviewed answers, most frequent first. A
  frequency cutoff of n answers is the first n lines, re-sorted alphabetically.
- `frequencies.tsv`: `word<TAB>zipf` for every guess.
- `NOTICE`: licence and credits, which must ship beside the files.

Loading validates: word length 4 to 7, every word the stated length, only
`a`–`z`, no duplicates, answers ⊆ guesses, at least one answer.

**Answer selection** (part of a configuration): `{"kind":"default"}`,
`{"kind":"top","n":3000}`, or `{"kind":"pasted","sha256":"…","words":[…]}`
where `sha256` is the hex SHA-256 of the sorted words joined by `\n`. The
answer list for a selection is always sorted alphabetically, so answer indices
are stable for a given selection.

## Feedback

`pattern = Σ c_i · 3^i`, `c = 0` absent, `1` present, `2` correct. Greens are
marked first, then yellows left to right against the remaining letter counts.
Spelled with `g`, `y`, `b`. Test vectors: `data/testvectors/feedback.json`
(both Rust and TypeScript tests read it).

## Configuration and config ID

```json
{
  "word_list": { "id": "open-en-5", "version": "1.0.0", "answers": { "kind": "default" } },
  "rules": { "max_guesses": 6, "hard_mode": false },
  "strategy": { "kind": "info_proportional", "beta": 1.0, "pool": "candidates" },
  "opener": "crane",
  "replicates": 200,
  "base_seed": 1,
  "weighting": "equal"
}
```

- `opener` is a lowercase allowed guess or `null` ("strategy's choice").
- **Canonicalisation** before hashing: strategy defaults filled in (the Rust
  `StrategySpec` round-trip does this), `replicates` forced to 1 when the
  strategy is deterministic, pasted answer `words` dropped (the `sha256`
  identifies them), JSON keys sorted, no whitespace, floats in serde_json's
  shortest round-trip form.
- **Config ID** = the first 16 hex digits of
  `BLAKE3(canonical_json + "\n" + SOLVER_VERSION)`. Only the solver computes
  it (the web app asks the backend), so there is one implementation.
- `SOLVER_VERSION` lives in `wl_core::SOLVER_VERSION`. Bump it whenever any
  game could change; golden cards change only with a bump.

## Playing a game

For target `t` (an answer word) and replicate `r`:

1. **Random stream.** ChaCha8 seeded with the 32-byte BLAKE3 hash of
   `"wordlology/rng/v1\0" ‖ base_seed (u64 LE) ‖ strategy canonical JSON ‖ "\0" ‖ opener or "" ‖ "\0" ‖ target word ‖ "\0" ‖ r (u32 LE)`.
   Keying on words (not indices) means a target keeps its stream across answer
   selections, and replicate r of target t is identical in every view.
2. The state starts with every answer as a candidate, turn 0.
3. If an opener is set, guess 1 is the opener (`p_chosen = 1`, phase 255).
   Otherwise the strategy chooses.
4. Each strategy turn: `dist = distribution(ctx, state)` (memoised by
   `state_key`), then `choice = dist.sample(rng)`. A single-entry
   distribution draws nothing from the stream; otherwise exactly one
   `next_u64` is drawn and mapped to `[0, 1)` with 53 bits.
5. Record the turn: guess, pattern, candidates before and after, expected
   bits (entropy of the guess's partition of the candidates before),
   `p_chosen` (total probability of the word), phase, and whether the guess
   was a candidate.
6. Stop when the pattern is all-correct (solved) or after `max_guesses`
   guesses (failed). `n_guesses` = number of turns, so a failure counts max
   guesses.

All transcendental maths goes through `wl_core::math` (libm), so native and
WASM builds give bit-identical games.

**Deterministic strategies** (`is_deterministic()`): R = 1. A full run builds
the decision tree breadth-first by recursing on candidate sets (never more
nodes than answers): at each node the strategy chooses once, the candidates
are partitioned by pattern, the all-correct bucket ends one game, and nodes at
depth `max_guesses` end their remaining targets as failures. Games are emitted
as their leaves resolve, so after finishing depth d every game ending at guess
d or earlier is final (`settledDepth = d`). A single-target scope just follows
the one path.

**Stochastic strategies**: replicates interleave and targets run in a seeded
random order: for `r` in the replicate range, for `t` in
`permutation(targets)`, play `(t, r)`. The permutation is a Fisher–Yates
shuffle driven by ChaCha8 seeded from BLAKE3 of
`"wordlology/order/v1\0" ‖ base_seed ‖ strategy canonical JSON ‖ "\0" ‖ opener or ""`.
Every prefix of the stream is therefore an unbiased sample of the card.
Distributions are memoised in an LRU cache keyed by `StateKey`.

**Scope** `{ "targets": "all" | [answer indices] | {"sample": n}, "replicates": [start, end] }`.
`"all"` plays every answer in the seeded order; a sample takes the first n
answers of the same seeded permutation; an explicit list is played in the
given order. The replicate range defaults to `[0, R)`.

## Strategies

`wl_strategy::Strategy` (see `crates/wl-strategy/src/lib.rs`):

- `distribution(ctx, state) -> Dist`: entries `(word, p, phase)`; a word may
  appear under several phases (mixtures); probabilities sum to 1.
- `state_key(state)`: equal keys ⇒ equal distributions.
- `scores(ctx, state, top_k)`: ranked alternatives for hint chips and annotations.
- `schema()`: parameter schema for the Lab form (JSON shape in `schema.rs`).
- `phases()`: phase labels; `Turn.phase` indexes them (255 = opener, 254 = player).
- Deterministic ties break toward words in C, then the lower word id (`argmax_tiebreak`).

`StrategySpec` is serde-tagged by `kind` (`max_info`, `most_frequent`,
`fixed_sequence`, `random`, `info_proportional`, `freq_proportional`,
`coverage_then`, `sequence_then`, `switch`, `mixture`, `solve_when_le`).
Switch rules are tagged by `when`: `after_turns {k}`, `candidates_le {n}`,
`bits_le {h}`, `sequence_exhausted`.

## Card statistics

Rows are outcomes `1..max_guesses` and `X`. With target weights `w_t`
(`1/|A|`, or each target's share of total frequency `10^zipf`):

- `share_k = Σ_t w_t · (1/R_t) Σ_r 1[K_{t,r} = k]` over targets seen so far,
  renormalised by `Σ_{t seen} w_t` while a run is partial.
- `mean_guesses` = weighted mean of `n_guesses` (a failure counts max guesses).
- `sd_guesses`: weighted standard deviation of `n_guesses` over games.
- `median`, `p95`: weighted quantiles of K with X counted as `max_guesses + 1`
  (smallest k whose cumulative share ≥ q).
- `solve_rate` = 1 − share_X.
- **Stochastic standard errors**: with `p_k^(r)` the card computed from
  replicate r alone, `share_se_k = sd_r(p_k^(r)) / √R` and
  `se_mean = sd_r(mean^(r)) / √R`. `NA` for deterministic cards.
- **Progressive 95% band** while the first replicate pass is incomplete (n of
  N targets seen): `share ± 1.96 · √((1 − n/N) · s² / n)` with `s²` the sample
  variance of the per-target indicator; after that, `± 1.96 · share_se`.
- `paired.csv`: per target, `mean_a` and `mean_b` are mean `n_guesses` over
  replicates; `diff = mean_a − mean_b`.

## Binary game batches

Workers send games as little-endian binary (`ArrayBuffer`, transferred):

```text
header   u32 magic 0x42474C57 ("WLGB")  u16 version = 1  u16 n_games
game     u16 target (answer index)  u16 replicate  u8 n_turns  u8 flags (bit 0 solved)
turn     u16 guess (word id)  u16 pattern  u16 cands_before  u16 cands_after
         f32 p_chosen  f32 bits_expected  u8 phase  u8 flags (bit 0 guess was a candidate)
```

A turn is 18 bytes. `wl_wasm::encode_games` and `web/src/backend/decode.ts`
implement the two ends; `wl-engine` tests round-trip through the encoder.

## WASM API (`wl-wasm`)

```text
new Solver(manifest_json, guesses_txt, answers_txt, frequencies_txt | undefined)   builds the pattern matrix
Solver.solverVersion() -> string                   (static)
solver.matrixMs -> f64                             time taken to build the matrix
solver.configId(config_json) -> string
solver.canonicalConfig(config_json) -> string
solver.startRun(config_json, scope_json) -> u32    a run handle
solver.step(run, budget_ms) -> Uint8Array          next game batch (possibly empty), within about budget_ms
solver.progress(run) -> string                     JSON ProgressEvent fields
solver.isDone(run) -> bool
solver.summary(run) -> string                      JSON SummaryEvent fields
solver.cancel(run)
solver.scores(config_json, history_json, top_k) -> string    JSON ScoresResult
solver.openerInfo(config_json) -> Float64Array     one-step expected information of every guess
solver.continueGame(config_json, target, history_json, replicate, one_step) -> Uint8Array
                                                   one game continued from a prefix of guess ids with
                                                   the stream of (target, replicate); the prefix turns
                                                   are recomputed, so the stream is advanced exactly as
                                                   if the strategy had played them
solver.schemas() -> string                         JSON StrategySchema[]
solver.presets() -> string                         JSON Preset[]
feedback(guess, target) -> u16                     (free function)
```

## Worker protocol

Main thread → worker (`postMessage`):

```ts
{ type: 'load', key, manifest, guesses, answers, frequencies }   // key = list id + answer selection hash
{ type: 'run', runId, key, config, scope }
{ type: 'pause', runId } | { type: 'resume', runId } | { type: 'cancel', runId }
{ type: 'scores', reqId, key, config, history, topK }
{ type: 'openerInfo', reqId, key, config }
{ type: 'configId', reqId, key, config }
{ type: 'continue', reqId, key, config, target, history, replicate, oneStep }   // result: binary batch of 1 game
{ type: 'meta', reqId }                                          // schemas, presets, solver version
```

Worker → main thread:

```ts
{ type: 'loaded', key, matrixMs }
{ type: 'games', runId, buffer }          // binary batch, transferred
{ type: 'progress', runId, ...ProgressEvent }
{ type: 'summary', runId, ...SummaryEvent }
{ type: 'result', reqId, data }
{ type: 'error', runId?, reqId?, message }
```

A worker runs slices of about 20 ms (`solver.step(run, 20)`) and yields to its
message queue between slices, so it can pause, cancel or switch jobs. It
always works on its highest-priority unpaused run. The pool has
`min(4, hardwareConcurrency − 1)` workers (at least 1). The scheduler assigns
runs in priority order (`focused`, `visible`, `background`); large
stochastic runs are sharded across idle workers by replicate range (each
shard is a full pass over the seeded target order, so every prefix stays an
unbiased estimate), and background runs pause while higher-priority work
waits.

## Frontend

TypeScript, Vite, Svelte 5 for the DOM, three.js for the scene.

- **Store** (`web/src/app/store.svelte.ts`): one `$state` object `app` with
  the zoom value `z`/`zTarget`, word data, result and display settings, the
  board, replay, focus (strategy, opener, target, selected node), filter,
  atlas grid and UI flags. The scene reads it on each animation frame; areas
  add fields only inside their own namespace.
- **Levels**: `z = 0` Game, `1` Tree, `2` Card, `3` Atlas. Pinch/scroll move
  `z` continuously; on release it snaps to the nearest level with ±0.15
  hysteresis. Buttons, `−`/`=` and Esc animate `zTarget`.
- **Scene** (`web/src/scene/`): `SceneCanvas.svelte` mounts `createScene()`
  once; level renderers are `SceneLayer`s (`scene/types.ts`) that decide
  their own visibility from `z`: the tree layer (`scene/tree/`), the card
  layer (`scene/card/`, `createCardLayer()`) and the atlas layer
  (`scene/atlas/`, `createAtlasLayer()`). Render on demand only.
  - World units are CSS pixels at camera scale 1. The tree layer owns the
    ortho camera for `z ≤ 1`; for `z > 1` the card and atlas layers own the
    camera (they may switch `ctx.camera` to `'persp'` during transitions).
    `scene/tree/bounds.ts` exports `treeBounds()`, the focused tree's world
    rectangle, so the Tree → Card transition can start from it.
  - During `1 < z < 2` the tree layer keeps drawing the focused tree in
    place, fading word labels out by `z = 1.4` and the whole tree by `z = 1.8`.
- **Runs** (`web/src/model/runs.ts`): `runs.request(config, scope, priority)`
  returns a shared `Run` whose `games` array grows as batches arrive; views
  poll `run.version` each frame or subscribe with `onChange`.
- **Trees** (`web/src/model/trie.ts`): `TargetTrie` implements `TargetTree`.
- **Cards** (`web/src/model/card.ts`): `CardAccumulator` turns games into a
  `CardSnapshot` using the formulas above.
- **Board markup**: the Game view renders `<div data-board>` containing rows
  `[data-row="i"]` of tiles `[data-tile]`, so the Game → Tree transition can
  measure them and replace them with WebGL tiles at the same positions.
- **Filter** (`web/src/model/filter.ts`): parser, formatter and matcher for
  the letter filter (grammar below), mirrored by `wl_core::filter`.

## Letter filter

A filter is one or more rules combined with All or Any. A rule has one slot
per letter position plus extra conditions. Text form (case-insensitive):

```text
rule    := slot{L} extra*          L = word length
slot    := '?'                     any letter
         | letter                  that letter
         | '[' letters ']'         any of a set
         | '{v}' | '{c}'           vowel / consonant class
         | '[^' letters ']'        none of a set
         | '{^v}' | '{^c}'         not a vowel / not a consonant
         | '!' letter              not that letter
extra   := '+' letter              contains the letter anywhere
         | '-' letter              excludes the letter
         | '*'                     has a repeated letter
filter  := rule (' | ' rule)*      combined with All or Any (stored beside the text)
```

Examples: `?A??Y`, `{v}{v}???`, `[^S]????`, `?A??Y +E -S`. Vowels are
`aeiou`, plus `y` when the "Y counts as a vowel" setting is on. `format(parse(s))`
is the canonical text; the builder edits the parsed structure. Scope (rows,
final guess) and mode (highlight, isolate) live beside the rule set.

## Export

Tidy CSV as in the specification ("Data export"). Both `wl-engine` (CLI) and
`web/src/export` (browser) write it; `data/testvectors/export/` holds a small
expected export that both are tested against. Conventions: UTF-8, comma
separated, header row, snake_case, lowercase words, `TRUE`/`FALSE`, `NA`,
ISO 8601 times, no comments; numbers with up to 6 significant decimals.
`game_id` = `{config_id}-{target word}-{replicate}` for strategy games and
`{config_id}-{target word}-p{n}` for player games. `node_id` =
`{config_id}-{target word}-n{id}`.

## Deviations from the specification

- **Answer cutoffs** reach at most the number of reviewed answers
  (3,416), not 4,000: the review excluded 2,757 of the 6,173 candidates.
- **Patterns** are u16 in game batches (the specification says u8) so that 6-
  and 7-letter lists work with the same format.
- **Shared pattern matrix**: each worker builds its own matrix inside WASM
  memory; a SharedArrayBuffer copy would still need copying into each
  instance's linear memory. COOP/COEP headers are still sent.
- **Plural rule**: words ending in `-ss` (abyss, brass, …) are not treated as
  -s plurals, so 2,455 words are removed rather than 2,461.
