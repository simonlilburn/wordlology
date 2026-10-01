// Feedback patterns in TypeScript (mirrors wl_core::pattern). Owned by the platform agent.
//
// A pattern is coded as the sum of c_i * 3^i, with c = 0 absent, 1 present and
// 2 correct. Greens are marked first, then yellows left to right against the
// remaining letter counts.

const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683];

/** Feedback code for guess against target: sum of c_i * 3^i, c = 0 absent, 1 present, 2 correct. */
export function feedback(guess: string, target: string): number {
  const len = guess.length;
  if (target.length !== len) throw new Error(`feedback: ${guess} and ${target} differ in length`);
  const counts = new Uint8Array(32);
  let code = 0;
  let green = 0;
  for (let i = 0; i < len; i++) {
    const g = guess.charCodeAt(i);
    const t = target.charCodeAt(i);
    if (g === t) {
      code += 2 * POW3[i];
      green |= 1 << i;
    } else {
      counts[t & 31]++;
    }
  }
  for (let i = 0; i < len; i++) {
    if (green & (1 << i)) continue;
    const c = guess.charCodeAt(i) & 31;
    if (counts[c] > 0) {
      counts[c]--;
      code += POW3[i];
    }
  }
  return code;
}

/** Cells of a code: 0 absent, 1 present, 2 correct. */
export function patternCells(code: number, len: number): number[] {
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(code / POW3[i]) % 3;
  return out;
}

/** Spell a code with g/y/b. */
export function patternLetters(code: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = Math.floor(code / POW3[i]) % 3;
    s += c === 2 ? 'g' : c === 1 ? 'y' : 'b';
  }
  return s;
}

/** Parse a g/y/b spelling (case-insensitive); null if invalid. */
export function patternFromLetters(s: string): number | null {
  if (s.length === 0 || s.length > 7) return null;
  let code = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i].toLowerCase();
    const c = ch === 'g' ? 2 : ch === 'y' ? 1 : ch === 'b' ? 0 : -1;
    if (c < 0) return null;
    code += c * POW3[i];
  }
  return code;
}

export function allCorrect(len: number): number {
  return 3 ** len - 1;
}
