// Copy the word lists and precomputed results into public/ so Vite serves them.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pub = join(root, 'web', 'public');
for (const [src, dst] of [
  [join(root, 'data', 'wordlists', 'open-en-5'), join(pub, 'wordlists', 'open-en-5')],
  [join(root, 'data', 'wordlists', 'ref-en-5'), join(pub, 'wordlists', 'ref-en-5')],
  [join(root, 'precomputed'), join(pub, 'precomputed')],
]) {
  if (!existsSync(src)) continue;
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}
console.log('synced word lists and precomputed results into web/public');
