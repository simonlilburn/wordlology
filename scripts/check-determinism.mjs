#!/usr/bin/env node
// Native vs WASM determinism check (docs/specification.md, "Testing").
//
// Plays the same configurations and scopes with the WASM solver (the package
// `npm run wasm` builds into web/src/wasm/pkg) and with the native CLI
// (`wordlology batch`), and compares the games byte for byte. Batch
// boundaries depend on time budgets, so the comparison is on the game
// records with the 8-byte batch headers removed. It also compares config IDs
// and continued games (`continueGame` against `wordlology play --out`).
//
// Node 22, no npm dependencies. It builds nothing itself; build first with
//   (cd web && npm run wasm)
//   cargo build --release -p wl-cli
// The CLI is looked up in $WORDLOLOGY_BIN, $CARGO_TARGET_DIR/release and
// target/release (then debug).
//
// Usage: node scripts/check-determinism.mjs [--quick]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const quick = process.argv.includes('--quick');
const HEADER = 8;

function fail(message) {
  console.error(`check-determinism: ${message}`);
  process.exit(2);
}

// ---------------------------------------------------------------- setup

const pkgDir = join(root, 'web/src/wasm/pkg');
const pkgJs = join(pkgDir, 'wl_wasm.js');
const pkgWasm = join(pkgDir, 'wl_wasm_bg.wasm');
if (!existsSync(pkgJs) || !existsSync(pkgWasm)) {
  fail(`the WASM package is missing (${pkgDir}).\nBuild it first:  cd web && npm run wasm`);
}

function findCli() {
  const candidates = [];
  if (process.env.WORDLOLOGY_BIN) candidates.push(process.env.WORDLOLOGY_BIN);
  if (process.env.CARGO_TARGET_DIR) candidates.push(join(process.env.CARGO_TARGET_DIR, 'release/wordlology'));
  candidates.push(join(root, 'target/release/wordlology'));
  if (process.env.CARGO_TARGET_DIR) candidates.push(join(process.env.CARGO_TARGET_DIR, 'debug/wordlology'));
  candidates.push(join(root, 'target/debug/wordlology'));
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    fail(
      `the native CLI is missing (looked for ${candidates.join(', ')}).\n` +
        'Build it first:  cargo build --release -p wl-cli   (or set WORDLOLOGY_BIN)',
    );
  }
  return found;
}
const cli = findCli();

const wasm = await import(pkgJs);
wasm.initSync({ module: readFileSync(pkgWasm) });

const tmp = mkdtempSync(join(tmpdir(), 'wl-determinism-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

function run(args) {
  return execFileSync(cli, args, { cwd: root, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------- word lists

const listDir = join(root, 'data/wordlists/open-en-5');
const manifestText = readFileSync(join(listDir, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const guesses = readFileSync(join(listDir, manifest.guesses), 'utf8');
const frequencies = readFileSync(join(listDir, manifest.frequencies), 'utf8');
const defaultAnswers = readFileSync(join(listDir, manifest.answers), 'utf8');
const ranked = readFileSync(join(listDir, manifest.answers_ranked), 'utf8').split('\n').filter(Boolean);

/** Answers text for a selection, as the web app hands it to a Solver. */
function answersFor(sel) {
  if (sel.kind === 'default') return defaultAnswers;
  if (sel.kind === 'top') return ranked.slice(0, sel.n).sort().join('\n') + '\n';
  throw new Error(`unsupported selection ${sel.kind}`);
}

const solvers = new Map();
function solverFor(sel) {
  const key = JSON.stringify(sel);
  if (!solvers.has(key)) {
    const s = new wasm.Solver(manifestText, guesses, answersFor(sel), frequencies);
    console.log(`  loaded ${key} (matrix ${s.matrixMs.toFixed(0)} ms in WASM)`);
    solvers.set(key, s);
  }
  return solvers.get(key);
}

// ---------------------------------------------------------------- helpers

/** The game records of concatenated batches (headers removed). */
function records(bytes) {
  const parts = [];
  let o = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (o < bytes.length) {
    if (dv.getUint32(o, true) !== 0x42474c57) throw new Error(`bad batch magic at ${o}`);
    const n = dv.getUint16(o + 6, true);
    let p = o + HEADER;
    for (let g = 0; g < n; g++) p += 6 + dv.getUint8(p + 4) * 18;
    parts.push(bytes.subarray(o + HEADER, p));
    o = p;
  }
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of parts) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

/** Index of the first differing game of two record streams, for the report. */
function firstDifference(a, b) {
  let o = 0;
  let g = 0;
  while (o < a.length && o < b.length) {
    const len = 6 + a[o + 4] * 18;
    for (let i = 0; i < len; i++) if (a[o + i] !== b[o + i]) return `game ${g} (byte ${o + i})`;
    o += len;
    g++;
  }
  return `game ${g} (lengths ${a.length} and ${b.length})`;
}

function countGames(rec) {
  let o = 0;
  let n = 0;
  while (o < rec.length) {
    o += 6 + rec[o + 4] * 18;
    n++;
  }
  return n;
}

function config(strategy, opts = {}) {
  return {
    word_list: { id: manifest.id, version: manifest.version, answers: opts.answers ?? { kind: 'default' } },
    rules: { max_guesses: opts.maxGuesses ?? 6, hard_mode: opts.hard ?? false },
    strategy,
    opener: opts.opener ?? null,
    replicates: opts.replicates ?? 20,
    base_seed: opts.seed ?? 1,
    weighting: opts.weighting ?? 'equal',
  };
}

let failures = 0;
const rows = [];

function check(name, cfg, scope) {
  const solver = solverFor(cfg.word_list.answers);
  const cfgJson = JSON.stringify(cfg);
  const cfgFile = join(tmp, 'config.json');
  writeFileSync(cfgFile, cfgJson);

  // Config IDs.
  const idWasm = solver.configId(cfgJson);
  const idCli = run(['config-id', '--config', cfgFile]).toString().split('\t')[0];

  // WASM, in 20 ms slices as the worker runs it.
  const t0 = performance.now();
  const handle = solver.startRun(cfgJson, JSON.stringify(scope));
  const chunks = [];
  while (!solver.isDone(handle)) chunks.push(solver.step(handle, 20));
  const wasmMs = performance.now() - t0;
  const summary = JSON.parse(solver.summary(handle));
  solver.cancel(handle);
  const joined = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  const a = records(joined);

  // Native.
  const outFile = join(tmp, 'games.wlgb');
  const t1 = performance.now();
  run(['batch', '--config', cfgFile, '--scope', JSON.stringify(scope), '--out', outFile]);
  const cliMs = performance.now() - t1;
  const b = records(new Uint8Array(readFileSync(outFile)));

  const same = a.length === b.length && a.every((x, i) => x === b[i]);
  const idsSame = idWasm === idCli && idWasm === summary.configId;
  const ok = same && idsSame && countGames(a) > 0;
  if (!ok) failures++;
  const why = !idsSame ? `config IDs differ (${idWasm} / ${idCli})` : !same ? `first difference at ${firstDifference(a, b)}` : '';
  rows.push([ok ? 'ok' : 'FAIL', name, countGames(a), `${wasmMs.toFixed(0)} ms`, `${cliMs.toFixed(0)} ms`, why]);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${countGames(a)} games${why ? ' — ' + why : ''}`);
}

function checkContinue(name, cfg, target, prefix, replicate, oneStep) {
  const solver = solverFor(cfg.word_list.answers);
  const cfgJson = JSON.stringify(cfg);
  const cfgFile = join(tmp, 'config.json');
  writeFileSync(cfgFile, cfgJson);
  const words = guesses.split('\n');
  const ids = prefix.map((w) => words.indexOf(w));
  const a = records(solver.continueGame(cfgJson, target, JSON.stringify(ids), replicate, oneStep));
  const outFile = join(tmp, 'game.wlgb');
  const args = ['play', '--config', cfgFile, '--target', String(target), '--replicate', String(replicate), '--out', outFile];
  if (prefix.length) args.push('--prefix', prefix.join(','));
  if (oneStep) args.push('--one-step');
  run(args);
  const b = records(new Uint8Array(readFileSync(outFile)));
  const ok = a.length === b.length && a.every((x, i) => x === b[i]);
  if (!ok) failures++;
  rows.push([ok ? 'ok' : 'FAIL', name, 1, '', '', ok ? '' : 'continued games differ']);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

// ---------------------------------------------------------------- the checks

console.log(`WASM package: ${pkgDir}\nnative CLI:   ${cli}`);
const infoProp = { kind: 'info_proportional', beta: 1, pool: 'candidates' };
const all = { targets: 'all' };

check('max_info (candidates), opener crane, card', config({ kind: 'max_info' }, { opener: 'crane' }), all);
check('max_info (allowed), hard mode, no opener, card', config({ kind: 'max_info', pool: 'allowed' }, { hard: true }), all);
check('info_proportional, opener slate, tree R = 200', config(infoProp, { opener: 'slate', replicates: 200 }), { targets: [123] });
check('info_proportional, opener crane, R = 3, sample 400', config(infoProp, { opener: 'crane', replicates: 3 }), {
  targets: { sample: 400 },
});
check('info_proportional, hard mode, no opener, R = 2, sample 60', config(infoProp, { hard: true, replicates: 2 }), {
  targets: { sample: 60 },
});
check('random (allowed), hard mode, R = 4, replicates [1, 3)', config({ kind: 'random', pool: 'allowed' }, { hard: true, replicates: 4 }), {
  targets: { sample: 150 },
  replicates: [1, 3],
});
check('info_proportional β = 2.5, seed 7, 8 guesses, top 1000', config({ kind: 'info_proportional', beta: 2.5 }, {
  opener: 'trace',
  replicates: 2,
  seed: 7,
  maxGuesses: 8,
  answers: { kind: 'top', n: 1000 },
}), { targets: { sample: 200 } });
if (!quick) {
  check('info_proportional, opener crane, card R = 20', config(infoProp, { opener: 'crane', replicates: 20 }), all);
}

// Every catalogue preset (whatever wl-strategy implements), normal and hard mode.
const presets = JSON.parse(solverFor({ kind: 'default' }).presets());
for (const p of presets) {
  for (const hard of [false, true]) {
    const cfg = config(p.spec, { opener: 'crane', replicates: 2, hard });
    try {
      solverFor(cfg.word_list.answers).configId(JSON.stringify(cfg));
    } catch (e) {
      console.log(`skip ${p.id}: ${e.message}`);
      rows.push(['skip', `preset ${p.id}${hard ? ', hard' : ''}`, 0, '', '', String(e.message)]);
      break;
    }
    check(`preset ${p.id}${hard ? ', hard mode' : ''}, opener crane, R = 2, sample 120`, cfg, { targets: { sample: 120 } });
  }
}

// Continued games (replay's Next button).
const contCfg = config(infoProp, { opener: 'crane', replicates: 200 });
checkContinue('continueGame: whole game from the opener', contCfg, 77, ['crane'], 5, false);
checkContinue('continueGame: player deviation, one step', contCfg, 77, ['crane', 'pious'], 5, true);
checkContinue('continueGame: empty prefix, deterministic', config({ kind: 'max_info', pool: 'allowed' }), 1234, [], 0, false);

console.log('');
for (const r of rows) console.log(r.map((x, i) => String(x).padEnd([5, 70, 7, 9, 9, 0][i])).join(' '));
if (failures) {
  console.error(`\n${failures} check(s) FAILED: native and WASM builds disagree`);
  process.exit(1);
}
console.log(`\nall ${rows.filter((r) => r[0] === 'ok').length} checks passed: native and WASM games are byte-identical`);
