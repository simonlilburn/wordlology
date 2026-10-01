# Export test vectors

A small fixed export that both CSV writers are tested against: the Rust one
(`crates/wl-engine/src/export.rs`, test `crates/wl-engine/tests/export_vectors.rs`)
and the TypeScript one (`web/src/export`). Given the games in `games.json`,
an exporter must write every CSV file here byte for byte.

Regenerate (only together with a `SOLVER_VERSION` bump, or when the export
format changes on purpose):

```sh
UPDATE_GOLDEN=1 cargo test -p wl-engine --test export_vectors
```

## Contents

- `games.json`: the input (below).
- `card/`: a card export of configuration 0 (`max_info`, candidate pool,
  opener `slate`, every answer of `ref-en-5`).
- `atlas/`: an atlas export of configurations 0 and 1 with `paired.csv` for
  the pair (0, 1).
- `tree/`: a tree export of configuration 1 for one target, including a
  player game (`nodes.csv`).

Configuration 1 is `info_proportional` (β = 1, candidate pool, opener
`slate`, R = 2) over a seeded sample of 6 targets, stopped after 9 games
(every target at replicate 0, three at replicate 1), so it is a **partial**
export (`complete = FALSE`, `targets_finished = 3`). It also holds one player
game (`isPlayer: true`, numbered 1, so its `game_id` ends in `-p1`).

The word list is `data/wordlists/ref-en-5` with its default answers: word ids
index `guesses.txt`, answer indices (`target`) index `answers.txt`.

## games.json

```jsonc
{
  "description": "…",
  "solver_version": "0.1.0",
  "word_list": { "id": "ref-en-5", "version": "1.0.0", "dir": "data/wordlists/ref-en-5" },
  "exported_at": "2026-09-30T15:33:00Z",      // written as is into configs.csv
  "app_version": "testvectors",               // written as is into configs.csv
  "configs": [
    {
      "config_id": "af49e7502a35bc9e",
      "config": { … },                        // the canonical Config (web/src/backend/types.ts)
      "strategy_id": "max_info",              // preset id (the spec's kind when no preset matches)
      "strategy_label": "Max information",
      "phases": ["max_info"],                 // phase labels, indexed by Turn.phase
      "deterministic": true,
      "complete": true,                       // configs.csv complete
      "targets_finished": 300,                // configs.csv targets_finished
      "n_targets": 300,                       // targets in the run's scope
      "games": [ Game, … ]                    // in arrival order (not export order)
    }
  ],
  "exports": [
    { "dir": "card",  "level": "card",  "configs": [0] },
    { "dir": "atlas", "level": "atlas", "configs": [0, 1], "pairs": [[0, 1]] },
    { "dir": "tree",  "level": "tree",  "configs": [1], "target": "began" }
  ]
}
```

A `Game` is exactly the TypeScript `Game` (web/src/backend/types.ts):
`{ target, replicate, solved, isPlayer, turns: [{ guess, pattern, candsBefore,
candsAfter, pChosen, bitsExpected, phase, isCandidate }] }`. `pChosen` and
`bitsExpected` are f32 values in batches; the JSON holds their exact f64
widening, so `JSON.parse` gives the same numbers `DataView.getFloat32` does.
`pairs` index into the export's own `configs` list.

## Conventions the files pin down

- UTF-8, `,` separated, `\n` line ends (also after the last row), a header
  row. A field is quoted only if it contains `,`, `"`, `\r` or `\n`, with
  `"` doubled (`strategy_json` always is).
- `TRUE`/`FALSE`; `NA` for missing values (no filter, root node fields,
  `replicate` of player games, `share_se`/`se_mean` of deterministic cards).
- **Numbers** (`bits_*`, `p_chosen`, `share*`, means, `diff`, …): the value
  rounded to 6 significant digits exactly as JavaScript's
  `x.toExponential(5)` does (on the exact binary value, ties away from
  zero), then written in plain decimal without an exponent and without
  trailing zeros or a trailing point: `0.333333`, `1234570`, `0.00000015`,
  `5.87`, `1`. Zero is `0`; NaN and infinities are `NA`. f32 values are
  formatted from their f64 widening. Counts and integers are plain.
- `configs.csv`: the specification's columns, then `complete`,
  `targets_finished`, `answers` (`default`, `top:N` or `pasted:<sha256>`) and
  `weighting` (`equal` or `frequency`). `strategy_json` is the canonical
  strategy JSON; `opener` is `NA` for the strategy's choice.
- **Game order** (games.csv, plays.csv): configurations in export order; within
  one, games sorted by target answer index, strategy games before player
  games, then by replicate (player games by number).
- `game_id` = `{config_id}-{target}-{replicate}`, or `{config_id}-{target}-p{n}`
  for player games. `outcome` is `1`…`max_guesses` or `X`; `n_guesses`
  counts guesses made; `path` joins the guesses with `>`.
- `plays.csv`: `turn` is 1-based; `feedback` spells the pattern with
  `g`/`y`/`b`; `bits_observed` = log2(candidates_before / candidates_after);
  `phase` is the phase label, `opener` for 255 and `player` for 254.
- `nodes.csv` (tree level): one trie per configuration built by inserting the
  target's games **in game order** (above); node ids count up from the root
  (`n0`) in creation order. `n_games` is the number of strategy games
  through the node (player paths add nodes with 0), `share` = n_games / total
  strategy games (so the root is 1), `outcome` is the guess number when the
  node's guess is the target, `X` for other nodes where a game ends, `NA`
  otherwise.
- `distribution.csv` and `summary.csv` use the formulas of
  docs/architecture.md ("Card statistics") over strategy games only (player
  games are skipped); at tree level they cover the one target. Rows run
  `1`…`max_guesses`, then `X`. `summary.n_targets` counts targets with at
  least one game.
- `paired.csv`: for each pair, the targets both configurations played, in
  answer order; `mean_a`/`mean_b` are mean `n_guesses` over strategy games.
