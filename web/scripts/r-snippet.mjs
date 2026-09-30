// Print the R snippet that Copy R code puts on the clipboard for an export
// (web/src/export/rcode.ts), so CI can run it under Rscript against a fresh
// export. Needs Node 22.18 or later (TypeScript type stripping).
//
// usage: node scripts/r-snippet.mjs --zip wordlology-card-20260930-1533.zip
//          [--files configs.csv,games.csv,...] [--base] [--max-guesses 6] [--dir ~/Downloads]
//
// --files defaults to the tables of the level named in the zip.

import { rSnippet } from '../src/export/rcode.ts';

const LEVEL_FILES = {
  tree: ['configs.csv', 'games.csv', 'plays.csv', 'nodes.csv', 'distribution.csv'],
  card: ['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv'],
  atlas: ['configs.csv', 'games.csv', 'plays.csv', 'distribution.csv', 'summary.csv', 'paired.csv'],
};

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const fileName = opt('--zip');
if (!fileName) {
  console.error('usage: node scripts/r-snippet.mjs --zip NAME [--files a.csv,b.csv] [--base] [--max-guesses N] [--dir DIR]');
  process.exit(2);
}
const level = /^wordlology-(tree|card|atlas)-/.exec(fileName)?.[1] ?? 'card';
const files = opt('--files')?.split(',') ?? LEVEL_FILES[level];
const maxGuesses = Number(opt('--max-guesses') ?? 6);

process.stdout.write(rSnippet({ fileName, files, maxGuesses, base: args.includes('--base'), dir: opt('--dir') }));
