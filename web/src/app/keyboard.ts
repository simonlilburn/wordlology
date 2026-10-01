// Global keyboard shortcuts. Owned by the platform agent.
//
// One keydown listener on window dispatches to registered shortcuts. Letter
// shortcuts (a single letter key) are inactive in the Game view, where letters
// type guesses, and every shortcut is inactive while a text field has focus or
// a Ctrl/Meta/Alt modifier is held. The platform registers its defaults
// (−/= zoom, Esc, , and . targets, E export, ? help, ; settings) in
// installKeyboard(); other areas register theirs with registerShortcut.

import { app, type Level } from './store.svelte';

export interface Shortcut {
  /** KeyboardEvent.key values, e.g. ['f', 'F'] or ['ArrowLeft']. */
  keys: string[];
  description: string;
  /** Only active when this returns true (default: always). */
  when?: () => boolean;
  handler: (e: KeyboardEvent) => void;
}

const shortcuts: Shortcut[] = [];
let installed: (() => void) | null = null;

/** Register a shortcut; returns an unregister function. Letter shortcuts are inactive in the Game view. */
export function registerShortcut(s: Shortcut): () => void {
  shortcuts.push(s);
  return () => {
    const i = shortcuts.indexOf(s);
    if (i >= 0) shortcuts.splice(i, 1);
  };
}

/** All registered shortcuts, for the help dialog. */
export function listShortcuts(): Shortcut[] {
  return [...shortcuts];
}

/** Whether the Game view is the current level (letters type guesses there). */
export function inGameView(): boolean {
  return Math.round(app.zTarget) === 0 && app.z < 0.5;
}

function isLetterKey(key: string): boolean {
  return key.length === 1 && /[a-z]/i.test(key);
}

function isTextTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== 'string') return false;
  const el = t as HTMLElement;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
  }
  return el.isContentEditable === true;
}

/** Dispatch a keydown to the shortcuts (exported for tests). Returns true if one handled it. */
export function dispatchKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (isTextTarget(e.target)) return false;
  const letter = isLetterKey(e.key);
  if (letter && inGameView()) return false;
  // Most recently registered first, so areas can override platform defaults.
  for (let i = shortcuts.length - 1; i >= 0; i--) {
    const s = shortcuts[i];
    if (!s.keys.includes(e.key)) continue;
    if (s.when && !s.when()) continue;
    e.preventDefault();
    s.handler(e);
    return true;
  }
  return false;
}

/**
 * Register a platform default: defaults sit below every area's shortcuts
 * whatever the registration order, so an area can always override one.
 */
function registerDefault(s: Shortcut): () => void {
  shortcuts.unshift(s);
  return () => {
    const i = shortcuts.indexOf(s);
    if (i >= 0) shortcuts.splice(i, 1);
  };
}

/** Dialog flags Esc closes before it zooms out, topmost first. */
const DIALOG_FLAGS = ['help', 'about', 'exportDialog', 'settings', 'search', 'openerPicker', 'compare', 'lab'] as const;

/** Close the topmost open dialog; returns false when none was open. */
export function closeTopDialog(): boolean {
  for (const k of DIALOG_FLAGS) {
    if (app.ui[k]) {
      app.ui[k] = false;
      return true;
    }
  }
  return false;
}

export interface KeyboardActions {
  stepLevel(delta: 1 | -1): void;
  stepTarget(delta: 1 | -1): void;
  openExport(): void;
}

let defaultsInstalled: (() => void) | null = null;

/**
 * Install the platform's default shortcuts (the spec's key table): − and =
 * zoom one level out or in, Esc closes a dialog or zooms out, , and . flip
 * targets, E exports, ? opens help and ; the settings (outside the Game
 * view). Other areas register F, S, O, / and ← → themselves.
 */
export function installDefaultShortcuts(actions: KeyboardActions): () => void {
  if (defaultsInstalled) return defaultsInstalled;
  const notGame = () => !inGameView();
  const offs = [
    registerDefault({ keys: ['-', '_', '−'], description: 'Zoom out one level', handler: () => actions.stepLevel(1) }),
    registerDefault({ keys: ['=', '+'], description: 'Zoom in one level', handler: () => actions.stepLevel(-1) }),
    registerDefault({
      keys: ['Escape'],
      description: 'Close a dialog, or zoom out',
      handler: () => {
        if (!closeTopDialog()) actions.stepLevel(1);
      },
    }),
    registerDefault({ keys: [','], description: 'Previous target', when: notGame, handler: () => actions.stepTarget(-1) }),
    registerDefault({ keys: ['.'], description: 'Next target', when: notGame, handler: () => actions.stepTarget(1) }),
    registerDefault({ keys: ['e', 'E'], description: 'Export', when: notGame, handler: () => actions.openExport() }),
    registerDefault({ keys: ['?'], description: 'Shortcut help', handler: () => (app.ui.help = !app.ui.help) }),
    registerDefault({ keys: [';'], description: 'Settings', when: notGame, handler: () => (app.ui.settings = true) }),
  ];
  defaultsInstalled = () => {
    for (const off of offs) off();
    defaultsInstalled = null;
  };
  return defaultsInstalled;
}

/** The level a key press should consider current (for tests and handlers). */
export function keyboardLevel(): Level {
  return Math.round(Math.min(3, Math.max(0, app.zTarget))) as Level;
}

/** Install the one global listener (idempotent). Returns an uninstall function. */
export function installKeyboardListener(): () => void {
  if (installed) return installed;
  if (typeof window === 'undefined') return () => {};
  const onKey = (e: KeyboardEvent) => {
    dispatchKey(e);
  };
  window.addEventListener('keydown', onKey);
  installed = () => {
    window.removeEventListener('keydown', onKey);
    installed = null;
  };
  return installed;
}
