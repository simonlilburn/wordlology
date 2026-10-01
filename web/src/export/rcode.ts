// The R snippet for an export (docs/specification.md, "Copy R code"). Owned by the platform agent.
//
// Written for the exact zip just exported: its file name, the tables it
// holds and the configuration's max guesses. For a card export the tidyverse
// snippet is exactly the specification's; a toggle switches to base R
// (read.csv with stringsAsFactors = FALSE) for machines without the tidyverse.

export interface RSnippetOptions {
  /** Zip file name, e.g. "wordlology-card-20260930-1533.zip". */
  fileName: string;
  /** CSV files in the zip. */
  files: string[];
  /** Max guesses (outcome levels 1..max and X). */
  maxGuesses?: number;
  /** Base R instead of readr and dplyr. */
  base?: boolean;
  /** Directory the zip was saved to (default ~/Downloads). */
  dir?: string;
}

/** R string literal. */
function rString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function has(files: string[], name: string): boolean {
  return files.includes(name);
}

/** Tables read after configs/games/plays, in this order. */
const EXTRA_TABLES = ['nodes', 'distribution', 'summary', 'paired', 'ranking'] as const;

function preamble(o: RSnippetOptions): string[] {
  const dir = o.dir ?? '~/Downloads';
  const max = o.maxGuesses ?? 6;
  return [
    `zip <- path.expand(${rString(`${dir.replace(/\/+$/, '')}/${o.fileName}`)})`,
    'dir <- sub("\\\\.zip$", "", zip)',
    'unzip(zip, exdir = dir)',
    '',
    `outcome_levels <- c(as.character(1:${max}), "X")`,
    '',
  ];
}

/** Whether a table should be read: summary tables beyond the card's four are read only when there is no summary. */
function extraTables(files: string[]): string[] {
  const out: string[] = [];
  for (const t of EXTRA_TABLES) {
    if (!has(files, `${t}.csv`)) continue;
    // The card snippet (the specification's) reads summary but not distribution;
    // distribution is read when there is no summary (tree exports).
    if (t === 'distribution' && has(files, 'summary.csv')) continue;
    out.push(t);
  }
  return out;
}

function tidy(o: RSnippetOptions): string {
  const f = o.files;
  const lines = ['library(readr)', 'library(dplyr)', '', ...preamble(o)];
  if (has(f, 'configs.csv')) lines.push('configs <- read_csv(file.path(dir, "configs.csv"), show_col_types = FALSE)');
  if (has(f, 'games.csv')) {
    lines.push(
      'games <- read_csv(file.path(dir, "games.csv"),',
      '  col_types = cols(',
      '    outcome = col_factor(levels = outcome_levels, ordered = TRUE),',
      '    solved = col_logical(), is_player = col_logical(),',
      '    n_guesses = col_integer(), replicate = col_integer(),',
      '    .default = col_character()))',
    );
  }
  if (has(f, 'plays.csv')) {
    lines.push(
      'plays <- read_csv(file.path(dir, "plays.csv"),',
      '  col_types = cols(turn = col_integer(), feedback_code = col_integer(),',
      '    candidates_before = col_integer(), candidates_after = col_integer(),',
      '    .default = col_guess()))',
    );
  }
  for (const t of extraTables(f)) {
    if (t === 'nodes') {
      lines.push(
        'nodes <- read_csv(file.path(dir, "nodes.csv"),',
        '  col_types = cols(depth = col_integer(), n_games = col_integer(),',
        '    outcome = col_factor(levels = outcome_levels, ordered = TRUE),',
        '    .default = col_guess()))',
      );
    } else if (t === 'distribution') {
      lines.push(
        'distribution <- read_csv(file.path(dir, "distribution.csv"),',
        '  col_types = cols(outcome = col_factor(levels = outcome_levels, ordered = TRUE),',
        '    n_games = col_integer(), .default = col_guess()))',
      );
    } else lines.push(`${t} <- read_csv(file.path(dir, "${t}.csv"), show_col_types = FALSE)`);
  }
  if (has(f, 'games.csv') && has(f, 'configs.csv')) {
    lines.push('', 'games <- games |>', '  left_join(select(configs, config_id, strategy_label, opener), by = "config_id")');
  }
  return lines.join('\n') + '\n';
}

function baseR(o: RSnippetOptions): string {
  const f = o.files;
  const lines = [...preamble(o)];
  const read = (name: string, colClasses?: string) =>
    `${name} <- read.csv(file.path(dir, "${name}.csv"), stringsAsFactors = FALSE${colClasses ? `,\n  colClasses = c(${colClasses})` : ''})`;
  if (has(f, 'configs.csv')) lines.push(read('configs', 'config_id = "character", strategy_label = "character", opener = "character"'));
  if (has(f, 'games.csv')) {
    lines.push(
      read('games', 'game_id = "character", config_id = "character", target = "character",\n    replicate = "integer", n_guesses = "integer", outcome = "character", path = "character"'),
      'games$outcome <- factor(games$outcome, levels = outcome_levels, ordered = TRUE)',
    );
  }
  if (has(f, 'plays.csv')) {
    lines.push(
      read('plays', 'game_id = "character", config_id = "character", turn = "integer",\n    guess = "character", feedback = "character", feedback_code = "integer",\n    candidates_before = "integer", candidates_after = "integer"'),
    );
  }
  for (const t of extraTables(f)) {
    if (t === 'nodes') {
      lines.push(
        read('nodes', 'node_id = "character", parent_id = "character", config_id = "character",\n    depth = "integer", n_games = "integer", outcome = "character"'),
        'nodes$outcome <- factor(nodes$outcome, levels = outcome_levels, ordered = TRUE)',
      );
    } else if (t === 'distribution') {
      lines.push(
        read('distribution', 'config_id = "character", outcome = "character", n_games = "integer"'),
        'distribution$outcome <- factor(distribution$outcome, levels = outcome_levels, ordered = TRUE)',
      );
    } else if (t === 'summary') lines.push(read('summary', 'config_id = "character"'));
    else if (t === 'paired') lines.push(read('paired', 'target = "character", config_a = "character", config_b = "character"'));
    else lines.push(read(t));
  }
  if (has(f, 'games.csv') && has(f, 'configs.csv')) {
    lines.push('', 'games <- merge(games, configs[, c("config_id", "strategy_label", "opener")],', '  by = "config_id", all.x = TRUE)');
  }
  return lines.join('\n') + '\n';
}

/** The R code that loads an export. */
export function rSnippet(o: RSnippetOptions): string {
  return o.base ? baseR(o) : tidy(o);
}

/** `wordlology-<level>-<yyyymmdd-hhmm>.zip` in local time. */
export function zipName(level: string, when: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}`;
  return `wordlology-${level}-${stamp}.zip`;
}
