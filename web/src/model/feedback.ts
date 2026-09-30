// Feedback patterns in TypeScript (mirrors wl_core::pattern). Owned by the platform agent.

/** Feedback code for guess against target: sum of c_i * 3^i, c = 0 absent, 1 present, 2 correct. */
export function feedback(guess: string, target: string): number {
  throw new Error('not implemented');
}
/** Cells of a code: 0 absent, 1 present, 2 correct. */
export function patternCells(code: number, len: number): number[] {
  throw new Error('not implemented');
}
/** Spell a code with g/y/b. */
export function patternLetters(code: number, len: number): string {
  throw new Error('not implemented');
}
export function allCorrect(len: number): number {
  return 3 ** len - 1;
}
