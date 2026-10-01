// Export dialog state. Owned by the platform agent.
import type { ExportLevel } from './index';

const K_BASE_R = 'wordlology:r-base:v1';

function loadBase(): boolean {
  try {
    return globalThis.localStorage?.getItem(K_BASE_R) === '1';
  } catch {
    return false;
  }
}

export const exportState = $state({
  /** The level the dialog exports. */
  level: 'card' as ExportLevel,
  /** The most recent export: its zip name, files and max guesses (for Copy R code). */
  last: null as null | { fileName: string; files: string[]; maxGuesses: number; level: ExportLevel },
  /** Base R instead of the tidyverse in the snippet. */
  baseR: loadBase(),
  busy: false,
});

export function setBaseR(on: boolean): void {
  exportState.baseR = on;
  try {
    globalThis.localStorage?.setItem(K_BASE_R, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
