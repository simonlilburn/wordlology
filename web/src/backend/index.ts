// The app's solver backend: a cache over precomputed files over the local
// WASM solver, Cache(Static(Local)), exported as one instance.

import { CacheBackend } from './cache';
import { LocalWasmBackend } from './local';
import { StaticBackend } from './static';
import type { SolverBackend } from './types';

/** The worker-pool backend (init.ts loads the word list into it). */
export const localBackend = new LocalWasmBackend();
export const staticBackend = new StaticBackend(localBackend);
export const cacheBackend = new CacheBackend(staticBackend);

/** The one backend every view talks to. */
export const backend: SolverBackend & Required<Pick<SolverBackend, 'scores' | 'openerInfo' | 'configId' | 'continueGame'>> =
  cacheBackend;

export type { RunStream } from './stream';
