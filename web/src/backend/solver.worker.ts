/// <reference lib="webworker" />
// Solver worker: hosts the WASM solver and implements the worker protocol
// (docs/architecture.md, "Worker protocol"). The logic lives in
// worker-host.ts; this file wires it to the worker global.

import type { ToWorker } from './protocol';
import { createWorkerHost, type WasmModule } from './worker-host';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// A glob import resolves to nothing while the package has not been built
// (`npm run wasm`), so the app still builds and reports a clear error.
const wasmModules = import.meta.glob('../wasm/pkg/wl_wasm.js');

async function loadWasm(): Promise<WasmModule> {
  const load = wasmModules['../wasm/pkg/wl_wasm.js'];
  if (!load) throw new Error('the solver has not been built (run `npm run wasm` in web/)');
  const mod = (await load()) as WasmModule;
  await mod.default();
  return mod;
}

const host = createWorkerHost({
  post: (msg, transfer = []) => scope.postMessage(msg, transfer),
  loadWasm,
});

scope.onmessage = (ev: MessageEvent<ToWorker>) => host.onmessage(ev.data);
