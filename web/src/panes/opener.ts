// Opener picker helpers (pure, unit-tested).

/** Common human openers, offered when they are in the guess list. */
export const HUMAN_OPENERS = ['crane', 'slate', 'adieu', 'audio', 'raise', 'stare', 'arise', 'trace', 'crate', 'irate', 'roate', 'soare', 'salet', 'least', 'later'];

/** Validation message for a typed opener, or '' when it is playable (or nothing is typed). */
export function openerProblem(text: string, wordLength: number, inList: ((w: string) => boolean) | null): string {
  const word = text.trim().toLowerCase();
  if (!word) return '';
  if (!/^[a-z]+$/.test(word)) return 'Letters only.';
  if (word.length < wordLength) {
    const n = wordLength - word.length;
    return `${n} more letter${n === 1 ? '' : 's'}.`;
  }
  if (word.length > wordLength) return `Openers have ${wordLength} letters.`;
  if (inList && !inList(word)) return `${word.toUpperCase()} is not in the guess list.`;
  return '';
}

/** Word ids of the `k` highest scores (ties toward the lower id), skipping non-finite scores. */
export function topK(scores: ArrayLike<number>, k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!Number.isFinite(s)) continue;
    if (out.length < k) {
      out.push(i);
      out.sort((a, b) => scores[b] - scores[a] || a - b);
    } else if (s > scores[out[k - 1]]) {
      out[k - 1] = i;
      out.sort((a, b) => scores[b] - scores[a] || a - b);
    }
  }
  return out;
}

/**
 * Atlas rows after adding `opener`: the grid is seeded with the focused card's
 * opener first (when it has no rows yet), and an opener already present is not
 * added twice.
 */
export function withAtlasRow(rows: readonly (string | null)[], focusOpener: string | null, opener: string | null): (string | null)[] {
  const out = rows.length ? [...rows] : [focusOpener];
  if (!out.includes(opener)) out.push(opener);
  return out;
}
