// Write .br and .gz copies of the compressible files in a built app (default
// web/dist), so the static server can send them without compressing on each
// request (deploy/Caddyfile: file_server { precompressed br gzip }).
// Files that do not shrink by at least 5% are left alone.
//
// usage: node scripts/precompress.mjs [DIR]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'dist'));
const COMPRESSIBLE = /\.(html|js|mjs|css|wasm|json|txt|tsv|svg|wlgb)$/;

let files = 0;
let before = 0;
let after = 0;

function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (COMPRESSIBLE.test(name) && st.size >= 512) compress(p, st.size);
  }
}

function compress(p, size) {
  const buf = readFileSync(p);
  const br = brotliCompressSync(buf, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: size },
  });
  const gz = gzipSync(buf, { level: 9 });
  if (gz.length > size * 0.95) return;
  writeFileSync(`${p}.gz`, gz);
  if (br.length < gz.length) writeFileSync(`${p}.br`, br);
  files++;
  before += size;
  after += Math.min(br.length, gz.length);
}

walk(dir);
const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
console.log(`precompressed ${files} files in ${dir}: ${kib(before)} -> ${kib(after)} (best of br/gzip)`);
