// Types for the wasm-bindgen package built by `npm run wasm` into
// web/src/wasm/pkg (docs/architecture.md, "WASM API"). When the package
// exists its own wl_wasm.d.ts takes precedence; this declaration keeps the
// worker compiling before it has been built.
declare module '*/wasm/pkg/wl_wasm.js' {
  export class Solver {
    free(): void;
    constructor(manifest_json: string, guesses_txt: string, answers_txt: string, frequencies_txt?: string | null);
    static solverVersion(): string;
    readonly matrixMs: number;
    configId(config_json: string): string;
    canonicalConfig(config_json: string): string;
    startRun(config_json: string, scope_json: string): number;
    step(run: number, budget_ms: number): Uint8Array;
    progress(run: number): string;
    isDone(run: number): boolean;
    summary(run: number): string;
    cancel(run: number): void;
    scores(config_json: string, history_json: string, top_k: number): string;
    openerInfo(config_json: string): Float64Array;
    continueGame(config_json: string, target: number, history_json: string, replicate: number, one_step: boolean): Uint8Array;
    schemas(): string;
    presets(): string;
  }
  export function feedback(guess: string, target: string): number;
  export function initSync(module: unknown): unknown;
  export default function init(module_or_path?: unknown): Promise<unknown>;
}
