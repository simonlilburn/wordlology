<script lang="ts">
  // Owned by the platform agent: export dialog. Level contents per the
  // specification, a size guard above app.display.exportWarnRows offering
  // summary tables only, partial exports (complete = FALSE), a limit to games
  // that touch a filter match, and Copy R code with a base-R toggle.
  import Dialog from '../panes/dialogs/Dialog.svelte';
  import { app } from '../app/store.svelte';
  import { copyRCode, currentSnippet, prepareExport, runExport, type ExportLevel, type PreparedExport } from './index';
  import { exportState, setBaseR } from './state.svelte';

  const LEVELS: { id: ExportLevel; label: string }[] = [
    { id: 'tree', label: 'Tree' },
    { id: 'card', label: 'Card' },
    { id: 'atlas', label: 'Atlas' },
  ];

  const CONTENTS: Record<ExportLevel, string> = {
    tree: "configs, this target's games and plays (every strategy game plus your own paths), nodes, and this target's distribution",
    card: 'configs, games, plays, distribution and summary for every target',
    atlas: 'configs, games, plays, distribution and summary for every configuration in the grid, plus paired.csv for each compared pair',
  };

  let onlyMatching = $state(false);
  let prepared = $state<PreparedExport | null>(null);
  let error = $state<string | null>(null);
  let showCode = $state(false);
  let seq = 0;

  const fmt = (n: number) => Math.round(n).toLocaleString('en');

  async function refresh(): Promise<void> {
    const my = ++seq;
    try {
      const p = await prepareExport(exportState.level, onlyMatching);
      if (my === seq) {
        prepared = p;
        error = null;
      }
    } catch (e) {
      if (my === seq) error = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    if (!app.ui.exportDialog) {
      prepared = null;
      return;
    }
    void exportState.level;
    void onlyMatching;
    void refresh();
    // Keep counts fresh while a run is still going.
    const timer = setInterval(() => {
      if (prepared?.partial) void refresh();
    }, 1000);
    return () => clearInterval(timer);
  });

  const limit = $derived(app.display.exportWarnRows);
  const tooBig = $derived(!!prepared && !prepared.empty && limit > 0 && prepared.rows > limit);

  async function doExport(summaryOnly: boolean): Promise<void> {
    if (!prepared || exportState.busy) return;
    exportState.busy = true;
    try {
      // Re-gather so a partial export holds every game that has arrived.
      const fresh = await prepareExport(exportState.level, onlyMatching);
      await runExport(fresh, summaryOnly);
      showCode = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      exportState.busy = false;
    }
  }

  function close(): void {
    app.ui.exportDialog = false;
    showCode = false;
  }

  const snippet = $derived(showCode ? currentSnippet(exportState.baseR).text : '');
</script>

<Dialog open={app.ui.exportDialog} title="Export" subtitle="Tidy CSV in a zip, with R code to load it" onclose={close} size="md">
  <div class="export" data-export-dialog>
    <div class="levels" role="radiogroup" aria-label="Level to export">
      {#each LEVELS as l (l.id)}
        <button
          type="button"
          role="radio"
          aria-checked={exportState.level === l.id}
          class:on={exportState.level === l.id}
          onclick={() => {
            exportState.level = l.id;
            showCode = false;
          }}>{l.label}</button
        >
      {/each}
    </div>

    <p class="contents">{CONTENTS[exportState.level]}.</p>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {:else if !prepared}
      <p class="muted">Gathering games…</p>
    {:else if prepared.empty}
      <p class="muted">{prepared.empty}</p>
    {:else}
      <p class="count">
        About <strong>{fmt(prepared.rows)}</strong> rows
        {#if prepared.configs.length > 1}across {prepared.configs.length} configurations{/if}.
      </p>
      {#if prepared.partial}
        <p class="note" data-partial>
          Still computing: the export holds the games so far ({fmt(prepared.targetsFinished)} / {fmt(prepared.targetsTotal)} targets
          finished), and configs.csv records <code>complete = FALSE</code>.
        </p>
      {/if}
      {#if prepared.filterActive}
        <label class="check">
          <input type="checkbox" bind:checked={onlyMatching} />
          Only games that touch a filter match
        </label>
      {/if}
      {#if tooBig}
        <p class="warn" role="alert" data-size-warning>
          This export is large (over {fmt(limit)} rows). Export the summary tables only (configs, distribution, summary
          {#if exportState.level === 'atlas'}, paired{/if})?
        </p>
      {/if}
    {/if}

    {#if showCode && exportState.last}
      <div class="code">
        <div class="coderow">
          <span class="file">{exportState.last.fileName}</span>
          <label class="check small">
            <input type="checkbox" checked={exportState.baseR} onchange={(e) => setBaseR((e.currentTarget as HTMLInputElement).checked)} />
            Base R
          </label>
        </div>
        <pre aria-label="R code">{snippet}</pre>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <div class="actions">
      {#if showCode}
        <button type="button" onclick={() => void copyRCode()} data-copy-r>Copy R code</button>
      {/if}
      {#if tooBig}
        <button type="button" onclick={() => void doExport(false)} disabled={exportState.busy}>Export everything</button>
        <button type="button" class="primary" onclick={() => void doExport(true)} disabled={exportState.busy} data-export-go>Summary tables only</button>
      {:else}
        <button
          type="button"
          class="primary"
          onclick={() => void doExport(false)}
          disabled={exportState.busy || !prepared || !!prepared.empty}
          data-export-go>{exportState.busy ? 'Exporting…' : 'Export'}</button
        >
      {/if}
    </div>
  {/snippet}
</Dialog>

<style>
  .export {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .levels {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    align-self: flex-start;
  }
  .levels button {
    min-height: 44px;
    min-width: 72px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0 14px;
  }
  .levels button + button {
    border-left: 1px solid var(--line);
  }
  .levels button.on {
    background: var(--fg);
    color: var(--bg);
  }
  .contents,
  .count,
  .note,
  .warn,
  .muted,
  .error {
    margin: 0;
    line-height: 1.45;
  }
  .muted {
    color: var(--muted);
  }
  .note {
    font-size: 14px;
    color: var(--muted);
  }
  .warn {
    padding: 8px 10px;
    border-radius: 8px;
    background: color-mix(in srgb, #e8a33d 18%, transparent);
  }
  .error {
    color: #b3261e;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    cursor: pointer;
  }
  .check.small {
    min-height: 0;
    font-size: 14px;
  }
  .code {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .coderow {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .file {
    font-family: var(--font-mono);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  pre {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    padding: 10px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--line);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }
  .actions button {
    min-height: 44px;
    padding: 0 16px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .actions button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
