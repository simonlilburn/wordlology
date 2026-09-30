# wordlology

wordlology opens as a five-letter word-guessing game and zooms out, one
aggregation at a time, into the statistics of guessing strategies:

| Level | Name | What you see |
| --- | --- | --- |
| 0 | Game | a board of letter tiles and a keyboard |
| 1 | Tree | every game a strategy plays against one target, as a tree grown around your own game |
| 2 | Card | the outcome distribution over every target, as a stack of those trees |
| 3 | Atlas | a grid of cards comparing strategies × openers, with rankings and paired comparisons |

Every aggregate can be clicked back down to a single playable game. All
computation runs in the browser: a Rust solver compiled to WebAssembly runs in
Web Workers. Every level exports tidy CSV with a button that copies the R code
to load it.

- Product specification: [docs/specification.md](docs/specification.md)
- Architecture and contracts: [docs/architecture.md](docs/architecture.md)
- Word lists and their review: [data/wordlists/README.md](data/wordlists/README.md)

## Repository

```text
crates/wl-core/       words, feedback patterns, pattern matrix, bitsets, entropy, letter filters
crates/wl-strategy/   Strategy trait, catalogue, combinators, parameter schemas
crates/wl-engine/     games, runs, tries, cards, pairs, CSV export
crates/wl-wasm/       wasm-bindgen API used by the web workers
crates/wl-cli/        native `wordlology` binary: play, card, export, bench, precompute
data/wordlists/       reproducible open word lists (ENABLE + wordfreq) and the LLM review
data/testvectors/     vectors shared by the Rust and TypeScript tests
precomputed/          results built by `wordlology precompute`, served by the StaticBackend
web/                  TypeScript + Vite + Svelte 5 + three.js app
```

## Getting started

Requirements: Rust (stable) with the `wasm32-unknown-unknown` target,
[wasm-pack](https://rustwasm.github.io/wasm-pack/), and Node 22.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

cd web
npm install
npm run wasm      # build the solver into web/src/wasm/pkg
npm run dev       # http://localhost:5173
```

`npm run dev` copies the word lists and precomputed results into
`web/public/` first. The dev server sends COOP/COEP headers so the page is
cross-origin isolated.

## Tests

```sh
cargo test --workspace                     # core, strategies (incl. golden cards), engine, CLI
node scripts/check-determinism.mjs         # native and WASM give byte-identical games
cd web && npm run check && npm test        # type-check and unit tests
cd web && npm run e2e                      # Playwright: play → tree → card → atlas → export
```

Golden cards live in `crates/wl-engine/tests/golden/` and change only with a
solver version bump (`wl_core::SOLVER_VERSION`); regenerate them with
`UPDATE_GOLDEN=1 cargo test -p wl-engine --test golden`.

## Command line

```sh
cargo run --release -p wl-cli -- --help
cargo run --release -p wl-cli -- card --strategy '{"kind":"max_info"}' --opener crane
cargo run --release -p wl-cli -- bench
cargo run --release -p wl-cli -- precompute --out precomputed/
```

## Deployment

The app is static. `Dockerfile` builds the WASM solver and the web app and
serves `web/dist` with the COOP/COEP headers the workers need; `fly.toml`
deploys it to fly.io.

## Licences

Code: MIT (see [LICENSE](LICENSE)). Word data: the guess list is the
public-domain ENABLE list; the answer list and frequencies derive from
[wordfreq](https://github.com/rspeer/wordfreq) (CC BY-SA 4.0, including
SUBTLEX data) and ship with their [NOTICE](data/wordlists/open-en-5/NOTICE).
