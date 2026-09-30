# wordlology — Specification

Sep 30, 2026 · @Simon Lilburn

## Overview

wordlology opens as a five-letter word-guessing game and zooms out, one aggregation at a time, into the statistics of guessing strategies. Every aggregate can be clicked back down to a single playable game, so the four levels read as one continuous space.

wordlology is built for a single class. Its name is the only reference to Wordle: interface text never mentions that game or its publisher, and every word list and frequency list is openly licensed.

| Level | Name | Held fixed | Varies | What the screen shows |
| --- | --- | --- | --- | --- |
| 0 | Game | target, one sequence of guesses | nothing | letter tiles and keyboard |
| 1 | Tree | target, strategy, opener | the guesses the strategy makes | every game against one target, as a tree |
| 2 | Card | strategy, opener | target (marginalised) | the outcome distribution on a card |
| 3 | Atlas | word list, rules | strategy × opener | a grid of cards for comparison |

Goals for v1:

- Make the step from one game to strategy-level statistics feel continuous and explorable.
- Run all computation in the browser through a Rust solver compiled to WebAssembly.
- Export tidy CSV at every level, with a button that copies the R code to load it.
- Keep word lists, strategies and compute backends pluggable.

Out of scope for v1: accounts, a server, the daily puzzle, multiplayer, and search for optimal decision trees.

## Core model

Every view is computed from one object: the multiset of games that a configuration plays, one or more per target. Trees are prefix tries of those games; cards and the atlas are aggregates of them.

**Configuration.** A configuration is (word list, rules, strategy spec, opener, replicates R, base seed). Rules hold max guesses (default 6) and hard mode; word length comes from the word list. The config ID is a hash of the canonical JSON plus the solver version, so any cache or backend can serve it.

**Game.** A game is (config ID, target, replicate index, turns, solved). Each turn records the guess, its feedback pattern, candidates before and after, expected and observed bits, the probability the strategy gave that guess, and which hybrid phase chose it.

**Target tree.** The target tree for target t is the prefix trie of every game the configuration plays against t. A node is a game state: the guesses so far (feedback is implied, since the target is fixed). Node mass is the number of games passing through it; mass / R estimates the probability of that prefix.

- Deterministic strategies play exactly one game per target, so R is fixed at 1 and the target tree is a single path.
- Stochastic strategies draw R independent games per target. The tree branches wherever draws differ, and can branch widely even with the opener, strategy and target all fixed.
- Exact mode (later) enumerates a stochastic tree with exact probabilities for small pools, folding branches below a threshold ε into one “other” river.

**Player paths.** The user’s own games are inserted into the trie as flagged paths that carry no mass. On first arrival the player’s first guess becomes the opener, so the player’s game and the strategy’s games share a root.

**Default configuration.** A player’s first arrival uses `info_proportional` (β = 1, candidate pool), with their first guess as the opener. The default is a branching strategy so the first tree anyone sees is a real tree.

**Card.** A card is the stack of all target trees for one configuration. Its statistic is the outcome distribution over K ∈ {1, …, 6, X}, giving every answer word equal weight:

```latex
P(K = k \mid C) = \frac{1}{|A|} \sum_{t \in A} \frac{1}{R} \sum_{r=1}^{R} \mathbf{1}\left[ K_{t,r} = k \right]
```

For stochastic strategies the card also reports standard errors across replicates.

**Atlas.** An atlas is a set of configurations that share a word list and rules, laid out as strategies × openers. Games are indexed by (target, replicate), so any two configurations can be compared target by target.

**Random streams.** Each game’s generator is seeded from a hash of (base seed, strategy ID, opener, target, replicate). Replicate r of target t is therefore identical in every view that asks for it: a 200-game tree and a 20-per-target card share their first 20 games.

## Level 0 — Game view

The app loads straight into a standard word-guessing board: six rows of five tiles, an on-screen keyboard, and physical keyboard input. Row count follows max guesses and tile count follows the word list’s word length.

**Targets.** A random answer is drawn from the open answer list at load. A URL can set the target as an encoded index, so a teaching link does not spoil the word. A New game button draws another.

**Rules.** Guesses must be in the allowed list; invalid words shake the row. Hard mode is an optional setting and is enforced for strategies too.

**Colours and colour-blind indicators.** Tiles use the familiar green, yellow and grey, with a high-contrast orange and blue palette as a setting. Colour is never the only signal:

- Correct tiles carry a small filled dot in the top-right corner; present tiles carry a hollow ring; absent tiles carry no mark.
- Keyboard keys carry the same marks.
- Each tile has an accessible label (“S, correct”), and each submitted row is announced.

**End of game.** On a win or loss the row flips, a short message shows, and after 800 ms the board zooms out into the Tree view. A setting keeps the user on the board instead.

**Replay mode.** Clicking any path at any higher level opens the board with that game’s guesses filled in.

- A scrubber under the board has one stop per turn. Dragging it, or pressing ← and →, moves a cursor; rows after the cursor turn translucent.
- Typing a guess at the cursor branches a new player path from that prefix, against the same target.
- A Next button, or Enter on an empty row, plays the strategy’s move: the path’s own next guess if the cursor is on it, otherwise a fresh seeded draw.
- A hint chip shows the word the strategy would play next and its probability; tapping it plays that word.

**Annotations.** A toggle adds a narrow column beside each row: candidates before → after, expected and observed bits, the probability of the chosen guess, and the hybrid phase. Tapping the candidate count lists the remaining words.

Zooming out (pinch, scroll, the level buttons or Esc) returns to the tree, with any new player branch overlaid.

## Level 1 — Tree view

The Tree view draws every game one configuration plays against one target, grown downward from the opener. The player’s own game is the trunk the tree grows around.

**Rows.** Horizontal rules divide the plane into bands labelled Guess 1 to Guess 6 and Out. A node sits in the band of its turn number. Solved games end in a filled check tile on their final row; failed games run on to Out and end in a cross.

**Trunk.** The focused path is a straight vertical line at the centre, from the opener to its end. On arrival that is the player’s game; later it is whichever path was last selected.

**Nodes.** Each node shows its word in uppercase monospace with a five-cell strip of that guess’s feedback colours, so the game board survives in miniature at every level.

**Rivers.** Edges are ribbons from parent to child whose width is proportional to the number of games they carry, with a 1 px minimum and a scale in the legend. Each node’s horizontal slot is proportional to its subtree’s games, with a minimum label width. Siblings are ordered by mass, alternating left and right of the trunk so heavy branches sit nearest it.

**Ellipses.** A node shows its children in descending mass while they fit the width budget at the current zoom (minimum 56 px per label, at most 12). The rest merge into an ellipsis node such as “… 37 more · 58 games”, fed by one river as wide as their combined games. Tapping the river or the ellipsis splits it into the next 12 streams plus a smaller ellipsis, repeating down to single games.

**Deterministic strategies.** The tree is a single path, and the pane says so: “Deterministic strategy: one game per target.” Counterfactual branches are an advanced setting, off by default.

**Growth animation.** After the Game → Tree transition, the strategy’s games stream in around the trunk.

- Games that stay with the trunk longest appear first, so growth radiates outward from the player’s game.
- The first five games draw one at a time, about 500 ms each, with their words readable.
- The reveal rate then doubles every second until all R games are in, capped at about 6 s in total.
- Any tap, or a Skip button, finishes the reveal. With reduced motion the whole tree fades in over 200 ms.
- Compute and reveal are decoupled: the solver streams batches into a buffer, and the ramp waits (“computing 142 / 200”) if compute falls behind.

**Selecting paths.** Hovering (desktop) or tapping highlights a whole path and shows its guesses, outcome and probability. Tapping Play, or double-tapping, opens that game in replay mode. Selection works at any time, including mid-animation.

**Navigation.** Drag pans; pinch, the scroll wheel and the +, − and Fit buttons zoom. Labels appear only above 10 px; below that, nodes become ticks. When the tree overflows the screen, a minimap in the lower right shows its silhouette and a draggable viewport rectangle.

&#91;embedded content: Tree view wireframe · rows, trunk, rivers, ellipsis, filter, panes\]

The wireframe is illustrative: the player’s path runs straight down the centre, strategy games branch off it as rivers sized by game count, and the Filter button’s colour marks matching nodes.

### Letter filter

A Filter button in the side pane (key F) highlights the nodes whose guess has chosen letters in chosen positions. Examples: an A second and a Y last; vowels first and second.

- **Builder.** One slot per letter position. Each slot is blank (any), a letter, a set, a class (vowel or consonant), or the negation of one of these. Extra rules: contains a letter anywhere, excludes a letter, has a repeated letter. A setting counts Y as a vowel.
- **Text form.** The builder and a pattern string edit the same filter: `?A??Y`, `{v}{v}???`, `[^S]????`, and `?A??Y +E -S` for “contains E, no S”. Several rules combine with All or Any.
- **Scope.** Apply to any row or only chosen guess numbers, and include or exclude the final solving guess.
- **Highlight mode (default).** Matching nodes get an accent outline and paths through them stay full strength; everything else dims to 25%.
- **Isolate mode.** Non-matching paths are removed and the tree re-lays out, so rivers show only the filtered games.
- **Collapsed groups.** A river or ellipsis hiding matches carries a badge (“3 matches”). Reveal matches expands just enough streams to show them, up to 50.
- **Readout.** The pane shows nodes matched, games touching a match (count and share of R), and matches per row.
- **Persistence.** The filter stays on while flipping targets, and each album-flow cover shows its match share as a small bar. It is part of the URL and of exports.

### Side pane

The side pane sits on the right on desktop and becomes a bottom sheet on phones.

- Strategy: preset list and Strategy Lab…
- Opener: validated text field, “strategy’s choice”, and recent openers.
- Replicates R for stochastic strategies: 50, 200 or 1,000.
- Filter (above), target search, Export and Copy R code.
- Level buttons (Game, Tree, Card, Atlas) and the legend.

### Target browser

A strip across the top flips through other targets’ trees in the same configuration, in the style of Cover Flow.

- Each cover is a thumbnail of that target’s tree: its silhouette, its most likely path as the trunk, row shading for its outcome distribution, and the target word beneath.
- The centre cover is the current target; side covers tilt about 60° in 3D. Swipe, drag, or press , and . to flip.
- Sort by alphabet, mean guesses (hardest first), fail rate, tree breadth (distinct paths), or at random. An A–Z scrubber appears for alphabetical order.
- Tapping a cover morphs the main tree to that target: the root stays anchored and the rest re-lays out. Player paths hide unless they belong to that target.
- Only about eight covers either side render; thumbnails are computed lazily and cached.

## Level 2 — Card view

A card is every target tree for one strategy–opener pair, stacked like transparencies until individual words vanish and only the outcome distribution remains. The user reaches it by zooming out past the Tree threshold or with the Card button.

**Face of the card.** A portrait card, about 3:4, keeps the same row bands as the tree: Guess 1 to 6 and Out.

- Each row’s background darkens in proportion to the share of all games ending there, from transparent to full ink for the largest row, on a perceptually uniform ramp.
- The superimposed trees stay visible as a faint density ghost: every path drawn at very low opacity, no words, showing where games flow.
- A thin bar in each row, as long as its share, makes rows comparable precisely, since length is read more accurately than darkness. It can be switched off.
- The right edge of each row shows its count and percentage; label colour flips on dark rows to keep contrast.
- The header names the strategy, opener, word list, a hard-mode badge, and “exact” or “sampled, R = 20”.
- The footer gives mean guesses (± SE for stochastic strategies), percent solved, and the 95th percentile.

**Interactions.**

- Tap: opens target search (type a word, or pick from a list sorted by guesses) and jumps to that target’s Tree view.
- Pinch or scroll in: returns to the Tree view at the last focused target, or the median-difficulty target if none.
- Long press or right-click: export, duplicate with another opener, edit strategy, remove.
- Dashed card to the right, “+ Strategy”: opens the Strategy Lab; the new strategy’s card appears beside this one.
- Dashed card below, “+ Opener”: opens an opener picker with a text field, the top 10 openers under this strategy, and common human openers.

Adding either card turns the layout into the Atlas grid while staying at card zoom.

### Progressive fill

A card draws from its first game and settles smoothly into its final state; nothing waits for the solver to finish.

- **Deterministic strategies fill top-down.** The decision tree expands breadth-first, so rows settle in order: after depth d, every game ending at guess d or earlier is final. Unresolved games sit in a hatched band below the settled rows, labelled with their count, and the band drains downward as each level resolves.
- **Stochastic strategies fill by estimate.** Targets run in a seeded random order and replicates interleave (every target at r = 1, then r = 2), so each partial result is an unbiased estimate of the whole card. Row bars carry a 95% band, with the finite-population correction, that narrows as games arrive.
- **Motion.** Shading, bars and numbers ease toward each new estimate on a critically damped spring of about 300 ms, so values never jump. The density ghost accumulates: each frame draws only the newly arrived paths onto a persistent texture.
- **Provisional marks.** Until a card completes, its numbers carry a leading \~ and one fewer digit, and a thin progress line runs along its lower edge (“estimate · 640 / 2,315 targets”).
- **Completion.** When the last game lands, the band collapses, the \~ marks drop, and the card border briefly brightens.

The same rules drive every surface that shows a card: Atlas cells, ranking entries and target-browser covers.

## Level 3 — Atlas

The Atlas is a grid of cards: one column per strategy, one row per opener, all sharing a word list and rules. A dashed “+” column sits at the right and a dashed “+” row at the bottom.

- **Progressive cells.** A new column or row starts all its cells at once, and each fills progressively as its games arrive.
- **Headers.** Column headers show the strategy name and its colour swatch; row headers show the opener. An optional margin gives each row’s and column’s mean.
- **Chips.** Zooming further out shrinks cards to chips that keep only the shaded rows and the mean, readable up to about 8 × 8.
- **Arranging.** Columns and rows can be dragged, and openers sorted by mean under a chosen strategy.

### Rankings

Each row and each column of the Atlas can rank the full alternative set along its own axis.

- **Rank strategies (row).** A button at the left of each opener row, beside the leftmost card, runs that opener across a strategy set: every catalogue preset and saved strategy by default, or a chosen subset.
- **Rank openers (column).** A button above each strategy column runs that strategy across a set of openers: the answer list by default, or all allowed guesses, the top N by one-step information, or a pasted list.
- **Ranking panel.** Results open in a panel beside the row or below the column header. Each entry shows its rank, name, a seven-row mini distribution, mean guesses with a 95% interval, and fail rate.
- **Metric.** Mean guesses by default; alternatives are fail rate, share solved in three or fewer, and mean with a failure counted as max guesses + 1. Ties break on fail rate, then name.
- **Noise.** For stochastic strategies, entries whose intervals overlap on the paired per-target differences are bracketed as “tied within noise”.
- **Adding.** Tapping an entry adds it to the grid as a column or row; “Add top 5” adds the leaders at once.

**Successive halving.** Full evaluation of every opener is too slow in a browser: 2,300 full trees at up to 1 s each is about 40 minutes. Rankings therefore run in rounds.

1. Screen every candidate cheaply: one-step expected information for openers, or 200 sampled targets at R = 1 for strategies.
2. Keep the best half, double the effort (more targets, then higher R), and re-rank.
3. Stop when 10 candidates remain; these get full cards. Screened-out entries keep their screening score, marked “screened”.

The panel fills progressively and can be cancelled at any round. Entries glide to new positions as estimates change, reordering at most twice a second so the list stays readable. Rankings for common configurations can ship precomputed through the StaticBackend, and later come from the server.

### Compare mode

Selecting two cards opens a comparison panel built on the target-by-target pairing.

- Side-by-side outcome distributions.
- A histogram of per-target differences in mean guesses (A − B).
- Counts of targets where A wins, ties and loses.
- The targets with the largest differences; tapping one opens its Tree view for either configuration.

A split Tree view showing both configurations for one target is planned for later.

## Transitions and the 3D scene

All four levels live in one scene driven by a single zoom value z: 0 is Game, 1 Tree, 2 Card, 3 Atlas. Pinch and scroll move z continuously and the scene interpolates between levels; on release it snaps to the nearest level, with ±0.15 hysteresis so it never flickers at a threshold. Buttons and Esc animate z.

The scene uses three.js. An orthographic camera keeps the tree, card and atlas flat and legible; a perspective camera is used only during transitions and for the target browser, where depth carries meaning.

1. **Game → Tree, about 1.6 s.** The DOM board is measured and replaced by WebGL tiles at the same pixel positions. Each row of tiles compresses into a word label with its feedback strip and slides to its row band. The horizontal rules draw across left to right, the trunk draws down from the opener, then the growth animation starts.
2. **Tree ↔ Tree, via the target browser.** The main tree shrinks into the centre cover, the strip rotates, and the new cover grows into the main view. The shared root stays anchored while the rest morphs.
3. **Tree → Card, about 1.2 s.** The camera pulls back and tilts about 30°. About 24 sampled target trees slide in behind the current one as translucent planes at increasing depth. Words fade, the camera returns face-on so the planes superimpose, and the precomputed density texture cross-fades in as the row shading rises and the card frame appears.
4. **Card → Atlas.** The camera pulls back, the card settles into its grid cell, and the dashed cards appear.

Every transition runs in reverse on zooming in, and can be interrupted. With reduced motion, each becomes a cross-fade of at most 200 ms. Transition 3 is the one that explains the model: it shows the card literally as a stack of trees.

## Strategy Lab and catalogue

A strategy maps a game state to a probability distribution over guesses; a deterministic strategy puts all its mass on one word. The state holds the candidate set C, the turn number, the history, the allowed pool (narrowed in hard mode), and the word list’s resources, such as frequencies.

| ID | Kind | Choice rule | Parameters |
| --- | --- | --- | --- |
| `max_info` | deterministic | Word with the highest expected information: the entropy of its feedback distribution over C | pool: allowed or candidates |
| `most_frequent` | deterministic | Most frequent word in C | frequency source |
| `fixed_sequence` | deterministic | Plays a listed sequence in order | words; solve when one candidate is left |
| `random` | stochastic | Uniform over the pool | pool: candidates or allowed |
| `info_proportional` | stochastic | P(w) ∝ I(w)^β, with I(w) the expected information | β (default 1); pool |
| `freq_proportional` | stochastic | P(w) ∝ f(w)^β over C | β (default 1) |
| `coverage_then` | hybrid | Greedily picks words covering the most frequent untested letters (no repeats), then switches | switch rule; next strategy |
| `sequence_then` | hybrid | Plays a fixed sequence, then switches | words; switch rule; next strategy |

At β = 0 the proportional strategies are uniform; as β grows they approach their deterministic counterparts. Deterministic ties break toward words in C, then the lower word index, so results are reproducible.

**Combinators.** The two hybrids are presets built from general parts, so new hybrids need no new code.

- `Switch { first, then, when }`, where `when` is after k turns, candidates ≤ n, remaining bits ≤ h, or sequence exhausted.
- `Mixture { weights, strategies }`, for example ε-greedy.
- Modifiers: `solve_when_le(n)` guesses from C once |C| ≤ n; hard-mode compliance applies automatically from the rules.

Every turn records which part of a hybrid chose the guess, and exports carry it as `phase`.

**Lab interface.**

- A library of presets and saved strategies, each with a name, a colour and its JSON definition.
- An editor form generated from each strategy’s parameter schema, with validation of numbers, choices and word lists.
- A hybrid builder: an ordered list of phases, each with its switch rule, reorderable by drag.
- Quick check runs 200 sampled targets at R = 5 and shows a mini card; Run full adds the strategy to the Atlas.
- Import and export of strategy JSON, and a shareable link.

## Solver architecture

The solver is a Rust workspace compiled to WebAssembly and run in Web Workers. The same crates build a native CLI, which later becomes the server backend, so browser and server give identical results.

| Crate | Responsibility |
| --- | --- |
| `wl-core` | Word lists, feedback patterns, the pattern matrix, candidate bitsets, partitions, entropy, letter filters |
| `wl-strategy` | The `Strategy` trait, the catalogue, combinators, the `StrategySpec` enum and parameter schemas |
| `wl-engine` | Playing games, building target tries, aggregating cards and pairs, producing export rows |
| `wl-wasm` | The wasm-bindgen API and the worker message protocol |
| `wl-cli` | Native binary for tests, benchmarks and precomputing shipped results; later the server |

&#91;embedded content: Solver architecture · backends, workers, crates\]

Arrows point to what each part calls or depends on; dashed parts come after v1.

**Feedback.** A pattern is coded as the sum of c\_i × 3^i, with c = 0 absent, 1 present, 2 correct. Greens are marked first, then yellows left to right against the remaining letter counts. For example, SPEED against ABIDE gives absent, absent, present, absent, present. Words of up to 7 letters fit in a u16 code.

**Pattern matrix.** Feedback for every allowed guess against every answer is precomputed as u8: about 30–35 MB for current five-letter lists. It is built once in a worker, targeting 0.5 s on a desktop. When the page is cross-origin isolated (COOP and COEP headers), workers share one copy through a SharedArrayBuffer; otherwise one worker holds it and helpers compute rows on demand.

**Candidate sets.** Candidates are bitsets over the answer list: 64 u64 words cover 4,096 answers. Partitioning C by a guess is one pass of matrix lookups into a 243-bucket count array.

**Deterministic runs.** The whole decision tree for (strategy, opener) is built once by recursing on candidate sets, never more nodes than answers. Each target’s game is its root-to-leaf path, so all targets come out of one pass.

**Stochastic runs.** The engine simulates R games per target. Each strategy declares a state key; the guess distribution for a state is memoised in an LRU cache under that key and reused by every game that reaches the same state.

**Streaming and scheduling.** Workers run in slices of about 20 ms, so they can cancel or switch jobs between slices. After each slice a worker sends a delta, new histogram counts and new paths, never the full state. The main thread ingests deltas within 4 ms per frame and interpolates everything else on requestAnimationFrame. Jobs run in visibility order: the focused card, then cards in the viewport, then off-screen cards, which pause while the queue is busy.

**Cost guard.** Information-based stochastic strategies over the full allowed pool cost the guess count times |C| for every new state they reach. Their default pool is the candidates; the full pool is opt-in and shows an estimated run time first.

**Randomness.** Each game uses ChaCha8 seeded from a BLAKE3 hash of (base seed, strategy ID, opener, target, replicate). This reproduces exactly across WASM and native builds.

**Workers.** A pool of hardware concurrency minus one workers, at most four, runs jobs. The protocol is `run(config, scope)`, answered by a stream of binary game batches (u16 word IDs, u8 patterns, f32 probabilities), progress events and a final summary; `cancel(run_id)` stops a job.

**Caching.** Results are cached in IndexedDB by config ID and scope, least recently used first out, capped at 200 MB. Precomputed results for common configurations ship as static binary files, so the first zoom-out is instant.

## Extension points

Word lists, strategies and backends each plug in behind one small interface, so adding one never touches the views.

### Word lists

A word list is a manifest plus plain files served as static assets.

- Manifest fields: id, name, version, word length, answers file, guesses file, optional frequency file, licence, SHA-256 and counts.
- Files: one lowercase word per line; frequencies as word, tab, Zipf value.
- Loading validates that answers are a subset of guesses, that every word has the stated length, and that there are no duplicates.
- Strategies declare the resources they need, such as frequencies; the UI disables a strategy a list cannot support and says why.
- Word length comes from the list (4 to 7 letters), so the feedback engine can also serve Herdle’s variable-length words.

**Default lists.** All word data is open. A build script in `data/wordlists/` produces the defaults.

| File | Contents | Source | Licence |
| --- | --- | --- | --- |
| guesses | every five-letter ENABLE word, 8,636 in all | [ENABLE word list](http://wiki.puzzlers.org/dokuwiki/doku.php?id=solving:wordlists:about:enable_readme) | public domain |
| answers | the 2,500 most frequent guesses, less simple -s plurals of four-letter words and a blocklist, then an LLM review | ENABLE ranked by [wordfreq](https://github.com/rspeer/wordfreq) | CC BY-SA 4.0, treated as a wordfreq derivative |
| frequencies | Zipf value, rounded to 0.01, for every guess | [wordfreq](https://github.com/rspeer/wordfreq), English | CC BY-SA 4.0 |

A check on the real lists: 2,461 of the 8,636 words are an -s added to a four-letter ENABLE word. With those removed, the 2,000th most frequent word sits at Zipf 3.0 (about once per million words) and the 2,500th at 2.69. 1,594 words have no wordfreq entry and get Zipf 0.

**Credits.** ENABLE’s authors ask to be credited. wordfreq’s licence requires attribution, including to the SUBTLEX authors, and its author asks that the data never be separated from that attribution. The answer and frequency files therefore ship beside a NOTICE with the licence and credits, the manifest carries them, and an About screen repeats them. wordfreq’s data is a snapshot through about 2021 and will not be updated.

**LLM review.** The build script sends the candidate answers to an LLM in batches of about 200, with a rubric: obscure, archaic, offensive, a disguised proper noun, or a variant spelling. Every flag comes back with a reason. Flags go into a committed `answers-excluded.tsv` (word, reason) that the build applies, so the list stays reproducible, changes show up as readable diffs, and the review reruns only when the source lists change.

### Strategies

Adding a strategy takes three steps and no frontend change, because the Lab renders its form from the schema.

1. Implement the `Strategy` trait in `wl-strategy`.
2. Add a variant to the serde-tagged `StrategySpec` enum, with its parameter schema.
3. Add a golden test of its card on the reference word list.

```rust
pub trait Strategy: Send + Sync {
    fn id(&self) -> &str;
    fn is_deterministic(&self) -> bool;
    /// Distribution over guess ids for this state; deterministic strategies return one entry.
    fn distribution(&self, ctx: &Ctx, state: &State) -> Dist;
    /// Memoisation key: states with equal keys must receive equal distributions.
    fn state_key(&self, state: &State) -> StateKey;
    /// Ranked alternatives with scores, for annotations and hint chips.
    fn scores(&self, ctx: &Ctx, state: &State, top_k: usize) -> Vec<(WordId, f64)>;
    /// Parameter schema that drives the Strategy Lab form.
    fn schema() -> ParamSchema where Self: Sized;
}
```

### Backends

The frontend talks only to a `SolverBackend`; backends compose, for example a cache over precomputed files over the local solver.

```ts
interface SolverBackend {
  id: string;
  capabilities(): Promise<Capabilities>; // strategies, word lists, exact mode, max R
  wordLists(): Promise<WordListManifest[]>;
  run(req: RunRequest, signal: AbortSignal): AsyncIterable<RunEvent>; // GameBatch | Progress | Summary
}
```

| Backend | Status | Role |
| --- | --- | --- |
| `LocalWasmBackend` | v1 | Runs the solver in the worker pool |
| `CacheBackend` | v1 | Wraps any backend with the IndexedDB cache |
| `StaticBackend` | v1 | Serves results precomputed by `wl-cli` at build time |
| `RemoteBackend` | later | Fetches and uploads trees and games from a server running the same crates |

The remote API reuses the `RunRequest` JSON and content-addressed config IDs. Planned endpoints: `POST /runs`, `GET /runs/{id}/events` as server-sent events, `GET /configs/{id}/games?target=`, and `POST /games` for uploading player games.

## Data export

Every level exports tidy CSV, one row per observation, bundled in a zip, with a Copy R code button beside Export. All tables join on `config_id` and `game_id`.

| File | One row per | Columns |
| --- | --- | --- |
| `configs.csv` | configuration | config\_id, strategy\_id, strategy\_label, strategy\_json, opener, word\_list\_id, word\_list\_version, hard\_mode, max\_guesses, replicates, base\_seed, filter, solver\_version, app\_version, exported\_at |
| `games.csv` | game | game\_id, config\_id, target, replicate, n\_guesses, solved, outcome, path, is\_player |
| `plays.csv` | guess | game\_id, config\_id, turn, guess, feedback, feedback\_code, candidates\_before, candidates\_after, bits\_expected, bits\_observed, p\_chosen, is\_candidate, phase, matches\_filter |
| `nodes.csv` | tree node | node\_id, parent\_id, config\_id, target, depth, guess, feedback, n\_games, share, is\_terminal, outcome, matches\_filter |
| `distribution.csv` | configuration × outcome | config\_id, outcome, n\_games, share, share\_se |
| `summary.csv` | configuration | config\_id, n\_targets, n\_games, mean\_guesses, sd\_guesses, se\_mean, median, solve\_rate, p95 |
| `paired.csv` | target × compared pair | target, config\_a, config\_b, mean\_a, mean\_b, diff |

A ranking panel exports `ranking.csv`, one row per ranked entry: ranking\_id, fixed\_kind (opener or strategy), fixed\_value, entry, rank, metric, value, ci\_low, ci\_high, fail\_rate, stage (full or screened). Full entries also add their rows to `distribution.csv`.

Conventions: `outcome` is "1" to "6" or "X"; `n_guesses` counts guesses made, so a failure counts max guesses; `feedback` spells the pattern as g, y and b letters; `path` joins guesses with “>”. `nodes.csv` is shaped for tidygraph and ggraph.

**What each level exports.**

- Tree: configs, that target’s games and plays (R games plus player paths), nodes, and that target’s distribution.
- Card: configs, games, plays, distribution and summary for every target.
- Atlas: the same for every configuration in the grid, plus `paired.csv` for each compared pair.
- An active letter filter is recorded in `configs.csv` and flagged per row; Export can also be limited to games that touch a match.

**Format.** UTF-8, comma-separated, a header row, snake\_case names, lowercase words, TRUE and FALSE, NA for missing, ISO 8601 times, and no comment lines. Zips are built in the browser (fflate) and named `wordlology-<level>-<yyyymmdd-hhmm>.zip`.

**Size guard.** Plays grow fast: a 6 × 6 atlas at R = 20 is about 36 × 2,315 × 20 × 4 ≈ 6.7 million rows. Above 1 million rows, Export warns and offers summary tables only.

**Partial exports.** While a run is still going, Export offers the games so far; `configs.csv` then records `complete = FALSE` and the number of targets finished.

**Copy R code.** The button copies a snippet written for the exact zip just exported, and a toast confirms it. For a card export at 15:33 today it reads:

```r
library(readr)
library(dplyr)

zip <- path.expand("~/Downloads/wordlology-card-20260930-1533.zip")
dir <- sub("\\.zip$", "", zip)
unzip(zip, exdir = dir)

outcome_levels <- c(as.character(1:6), "X")

configs <- read_csv(file.path(dir, "configs.csv"), show_col_types = FALSE)
games <- read_csv(file.path(dir, "games.csv"),
  col_types = cols(
    outcome = col_factor(levels = outcome_levels, ordered = TRUE),
    solved = col_logical(), is_player = col_logical(),
    n_guesses = col_integer(), replicate = col_integer(),
    .default = col_character()))
plays <- read_csv(file.path(dir, "plays.csv"),
  col_types = cols(turn = col_integer(), feedback_code = col_integer(),
    candidates_before = col_integer(), candidates_after = col_integer(),
    .default = col_guess()))
summary <- read_csv(file.path(dir, "summary.csv"), show_col_types = FALSE)

games <- games |>
  left_join(select(configs, config_id, strategy_label, opener), by = "config_id")
```

A toggle switches the snippet to base R (`read.csv` with `stringsAsFactors = FALSE`) for machines without the tidyverse.

## Frontend, design and accessibility

The frontend is TypeScript on Vite, with Svelte 5 for panes and controls and three.js for the scene. Static hosting on fly.io sends COOP and COEP headers so workers can share memory.

**Libraries.** three.js for the scene, troika-three-text for SDF word labels, fflate for zips, and wasm-bindgen with wasm-pack for the solver.

**Rendering.** Each tree’s ribbons are one batched triangle-strip buffer and its labels one instanced text mesh. The scene renders on demand, only when something changes, to save phone batteries.

**Svelte and the scene.** Svelte owns only the DOM: panes, sheets, the Strategy Lab and the game board. The three.js scene lives in a plain TypeScript module that one Svelte component mounts on a single canvas and never re-renders. Both sides share one store (zoom value, configuration, focus, filter), which the scene reads on each animation frame, so Svelte updates never trigger scene work.

A spike at the start of milestone 2 checks that this holds 60 fps on desktop with panes animating over the scene. If it does not, the panes move to plain TypeScript and nothing else in the design changes.

**Keyboard.** Every action has a key. Letter shortcuts work outside the Game view, where letters type guesses.

| Key | Action |
| --- | --- |
| letters, Enter, Backspace | play a guess |
| ← → | scrub replay |
| − = | zoom out or in one level |
| , . | previous or next target |
| / | target search |
| F | letter filter |
| S, O | strategy, opener |
| E | export |
| ? | shortcut help |

**Shareable state.** The URL hash encodes the level, configuration, opener, target index, filter and selected path, so a link reproduces the exact view.

**Type.** Tiles use a bold uppercase sans. Words in trees use an uppercase monospace, so five-letter words align in columns.

**Accessibility.**

- Colour-blind marks on tiles and keys, and a high-contrast palette.
- A text alternative at each level: row announcements for the Game, a navigable outline of nodes with counts for the Tree, a table of the distribution for a Card, and a table of means for the Atlas.
- Reduced motion replaces transitions with short cross-fades.
- Touch targets of at least 44 px, and WCAG AA contrast for labels on shaded rows.

**Performance targets.** To be checked against benchmarks in milestone 1.

| Measure | Target |
| --- | --- |
| First load, gzipped, including WASM and default list | ≤ 1.5 MB |
| Pattern matrix build | ≤ 0.5 s desktop, ≤ 1.5 s mid-range phone |
| Deterministic `max_info` card over all answers | ≤ 2 s desktop, ≤ 6 s phone |
| Stochastic tree for one target, R = 200 | ≤ 1 s |
| Stochastic card, R = 20 per target | ≤ 10 s desktop, drawn progressively |
| Frame rate in transitions | 60 fps desktop, ≥ 30 fps phone |
| Memory on phone | ≤ 300 MB |

## Repository, testing and milestones

One monorepo holds the Rust workspace, the web app and the word lists.

```text
wordlology/
  crates/
    wl-core/       words, patterns, bitsets, entropy, letter filters
    wl-strategy/   Strategy trait, catalogue, combinators, schemas
    wl-engine/     games, tries, cards, pairs, export rows
    wl-wasm/       wasm-bindgen API, worker protocol
    wl-cli/        tests, benchmarks, precompute; later the server
  web/src/
    app/           state machine, zoom value, URL state
    views/         game, tree, card, atlas
    scene/         three.js scene, layout, level of detail, transitions
    panes/         side pane, target browser, filter builder
    lab/           Strategy Lab
    backend/       SolverBackend and implementations
    export/        CSV writers, zip, R snippet
  data/wordlists/  manifests and word files
  precomputed/     results built by wl-cli
```

**Testing.**

- Feedback: duplicate-letter test vectors; properties that a guess against itself is all correct and that every target is consistent with its own feedback.
- Strategies: golden cards on a frozen reference list, changed only with a solver version bump.
- Determinism: CI checks that native and WASM builds give byte-identical games for the same config and seed.
- Export: CI runs the copied R snippet under Rscript against a fresh export and checks column types.
- Letter filter: parser round-trips between builder and text form, with property tests against a naive matcher.
- UI: Playwright runs play → tree → card → atlas → export, with screenshot diffs per level and a reduced-motion pass.
- Benchmarks: criterion natively, plus an in-browser harness for the performance targets.

**Milestones.**

1. Engine and CLI: word lists, feedback, `max_info`, `random` and `info_proportional`, deterministic trees, sampled games, CSV from the CLI, tests and benchmarks.
2. Svelte-over-three.js spike, then Game view and worker integration: playable game, both palettes, colour-blind marks, replay mode.
3. Tree view: layout, rivers, ellipsis expansion, minimap, path selection into replay, letter filter.
4. Game → Tree transition and the growth animation.
5. Target browser and target search.
6. Card view, the stacking transition, exports and the R snippet.
7. Atlas, the full Strategy Lab catalogue with hybrids, compare mode, and row and column rankings.
8. Polish: accessibility, performance targets, precomputed defaults, share links.

Later: `RemoteBackend`, exact stochastic enumeration, split-tree comparison, and more strategies such as minimax and expected remaining candidates.

## Advanced settings

Every option below has a default, so the app works without anyone opening the panel. A gear button in the side pane opens it (key ; outside the Game view).

- **Two kinds.** Result settings are part of the configuration: changing one gives a new config ID, recomputes progressively, and is recorded in `configs.csv`. Display settings change only how things look and are kept per browser.
- **Visible changes.** A dot marks any setting changed from its default, and Reset to defaults restores them all.
- **Presets.** Non-default settings travel in the share link, so an instructor can hand a whole class one preset.

| Group | Setting | Default | Options | Kind |
| --- | --- | --- | --- | --- |
| Game | Max guesses | 6 | 4 to 10 | result |
| Game | Hard mode | off | on | result |
| Game | Answer list | 2,500 most frequent words | 1,000 to 4,000 by frequency cutoff, or a pasted list | result |
| Game | Zoom out after a game | on | stay on the board | display |
| Game | Colour palette | standard | high contrast | display |
| Game | Colour-blind marks | on | off | display |
| Computation | Arrival strategy | `info_proportional`, β = 1 | any preset or saved strategy | result |
| Computation | Stochastic guess pool | candidates | all allowed guesses | result |
| Computation | Replicates, Tree view | 200 | 50, 200, 1,000 | result |
| Computation | Replicates per target, cards and Atlas | 20 | 5 to 100 | result |
| Computation | Target weighting | equal | word frequency | result |
| Computation | Base seed | 1 | any integer | result |
| Tree | Counterfactual branches, deterministic strategies | off | top 2 to 5 alternatives per turn | display |
| Tree | Growth animation | full | fast, off | display |
| Tree | Label threshold | 10 px | 8 to 16 px | display |
| Tree | Replay annotations | off | on | display |
| Filter | Y counts as a vowel | off | on | display |
| Filter | Filter scope | Tree view | Tree, Card and Atlas | display |
| Cards | Row length bars | on | off | display |
| Cards | Motion | follows the system | reduced, full | display |
| Rankings | Strategy set | every preset and saved strategy | a chosen subset | result |
| Rankings | Opener set | answer list | all allowed guesses, top N by information, a pasted list | result |
| Rankings | Full evaluations kept | 10 | 5 to 50 | result |
| Rankings | Metric | mean guesses | fail rate, share solved in three or fewer, mean with a failure as max + 1 | result |
| Data | Player branches | this session only | kept in this browser | display |
| Data | Export size warning | 1 million rows | any size | display |

Frequency weighting replaces 1/|A| in the card formula with each target’s share of total frequency. Counterfactual branches expand the top alternatives at each turn as dashed paths that carry no mass.

## Open decisions

No questions remain open: earlier ones are now defaults in Advanced settings, and the last two are decided below.

- [x] **UI framework.** Decided: Svelte 5, provided the milestone 2 spike shows it works well over the three.js scene.
- [x] **Answer list review.** Decided: an LLM review of the 2,500-word default, recorded in a committed exclusion file.

## Sources

- [ENABLE word list readme](http://wiki.puzzlers.org/dokuwiki/doku.php?id=solving:wordlists:about:enable_readme): the public-domain release and the request for credit.
- [wordfreq](https://github.com/rspeer/wordfreq): data licence, attribution terms, and the 2021 data snapshot.
