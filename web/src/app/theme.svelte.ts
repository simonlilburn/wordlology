// Light or dark. The Appearance setting decides (light by default); "system"
// follows prefers-color-scheme. The resolved scheme is written to
// <html data-theme>, which global.css keys its colour tokens on, and every
// canvas or WebGL drawing asks isDark() so it matches the DOM.

import { app } from './store.svelte';

const scheme = $state({ systemDark: false });
let query: MediaQueryList | null = null;

function systemDark(): boolean {
  if (!query && typeof matchMedia === 'function') {
    try {
      query = matchMedia('(prefers-color-scheme: dark)');
      scheme.systemDark = query.matches;
      query.addEventListener?.('change', () => (scheme.systemDark = query!.matches));
    } catch {
      query = null;
    }
  }
  return scheme.systemDark;
}

/** Whether the dark palette is in effect (reactive: reads the setting and the system preference). */
export function isDark(): boolean {
  const t = app.display.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return systemDark();
}

/** Write the resolved scheme to the document (call from an effect). */
export function applyTheme(dark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#131512' : '#fbfbf8');
}
