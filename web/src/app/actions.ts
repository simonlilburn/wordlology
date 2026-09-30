// Shared actions on the store. Owned by the platform agent.
import type { Config } from '../backend/types';
import type { Level, StrategyEntry } from './store.svelte';

/** Animate to a level (buttons, keys). */
export function setLevel(level: Level): void {}
/** Focus a target (answer index) in the Tree view. */
export function focusTarget(target: number): void {}
/** Select a trie node (end of a path) in the focused tree; -1 clears. */
export function selectNode(nodeId: number): void {}
/** Open a path in replay mode on the board. */
export function openReplay(path: { target: number; guesses: number[]; patterns: number[]; config: Config | null }): void {}
/** Change the focused strategy / opener. */
export function setStrategy(entry: StrategyEntry): void {}
export function setOpener(opener: string | null): void {}
/** Start a new game with a random (or given) target. */
export function newGame(target?: number): void {}
/** Record a finished player game (adds a player path, sets the opener on first arrival). */
export function finishGame(): void {}
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {}
