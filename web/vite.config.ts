import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// COOP/COEP make the page cross-origin isolated so workers can share memory.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [svelte()],
  define: {
    // Recorded as app_version in configs.csv.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    // One app chunk of about 1 MB (300 KB gzipped); the first-load budget is
    // 1.5 MB gzipped including WASM and the word list, so do not warn below that.
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
