import { mount } from 'svelte';
import App from './App.svelte';
import './app/global.css';
import { init } from './app/init';
import { app } from './app/store.svelte';
import { focusData } from './model/focus';

const target = document.getElementById('app')!;
mount(App, { target });
void init();

// Read-only handle for end-to-end tests (web/tests/e2e), which wait on real
// state instead of timers. Exposed in dev builds or with ?e2e in the URL.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('e2e')) {
  (window as unknown as { __wordlology: unknown }).__wordlology = { app, focusData };
}
