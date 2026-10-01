<script lang="ts">
  // Advanced settings: every row of the specification's table, grouped. Result
  // settings (part of the configuration) and display settings (kept in this
  // browser) are marked apart; a dot marks anything changed from its default.
  import { app, DEFAULT_DISPLAY, DEFAULT_RESULT } from '../../app/store.svelte';
  import { resetSettings, saveDisplaySettings, savePlayerBranches } from '../../app/settings';
  import { specLabel, strategyJson } from '../../app/config';
  import { FALLBACK_PRESETS } from '../../lab/catalogue';
  import type { StrategySpec } from '../../backend/types';
  import Dialog from './Dialog.svelte';
  import SettingRow from './SettingRow.svelte';
  import AnswerListControl from './AnswerListControl.svelte';
  import OpenerSetControl from './OpenerSetControl.svelte';
  import {
    EXPORT_WARN_OPTIONS,
    GROUPS,
    SETTINGS,
    exportWarnText,
    optionIndex,
    recomputeMessage,
    sameValue,
    settingId,
    settingsIn,
    type Group,
    type SettingDef,
  } from './settings';

  let status = $state('');
  /** Slider values while dragging (committed on release). */
  let drafts = $state<Record<string, number>>({});
  let bodyEl: HTMLElement | undefined = $state();

  function store(def: SettingDef): Record<string, unknown> {
    return (def.kind === 'result' ? app.result : app.display) as unknown as Record<string, unknown>;
  }
  function defaults(def: SettingDef): Record<string, unknown> {
    return (def.kind === 'result' ? DEFAULT_RESULT : DEFAULT_DISPLAY) as unknown as Record<string, unknown>;
  }
  function current(def: SettingDef): unknown {
    return store(def)[def.key];
  }
  /** Canonical form of a strategy spec (defaults filled, keys sorted). */
  function specKey(spec: unknown): string {
    try {
      return strategyJson(spec as StrategySpec);
    } catch {
      return JSON.stringify(spec);
    }
  }
  function changed(def: SettingDef): boolean {
    if (def.key === 'arrivalStrategy') return specKey(current(def)) !== specKey(defaults(def)[def.key]);
    return !sameValue(current(def), defaults(def)[def.key]);
  }

  const nChanged = $derived(SETTINGS.filter((d) => changed(d)).length);
  const groupChanged = $derived(Object.fromEntries(GROUPS.map((g) => [g, settingsIn(g).some((d) => changed(d))])) as Record<Group, boolean>);

  function persistDisplay() {
    try {
      saveDisplaySettings();
    } catch {
      /* platform persistence not ready */
    }
  }

  function resultChanged(label: string) {
    status = recomputeMessage(label);
  }

  function set(def: SettingDef, value: unknown) {
    if (sameValue(current(def), value)) return;
    store(def)[def.key] = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    if (def.kind === 'result') resultChanged(def.label);
    else {
      persistDisplay();
      if (def.key === 'keepPlayerBranches') {
        try {
          savePlayerBranches();
        } catch {
          /* ignore */
        }
      }
    }
  }

  function commitDraft(def: SettingDef) {
    const id = settingId(def);
    const v = drafts[id];
    delete drafts[id];
    if (v !== undefined) set(def, v);
  }

  function reset() {
    const hadResult = SETTINGS.some((d) => d.kind === 'result' && changed(d));
    try {
      resetSettings();
    } catch {
      app.result = structuredClone(DEFAULT_RESULT);
      app.display = structuredClone(DEFAULT_DISPLAY);
    }
    drafts = {};
    persistDisplay();
    try {
      savePlayerBranches();
    } catch {
      /* ignore */
    }
    status = hadResult
      ? 'Every setting is back to its default. Trees and cards recompute progressively.'
      : 'Every setting is back to its default.';
  }

  function close() {
    app.ui.settings = false;
    status = '';
    drafts = {};
  }

  function jump(g: Group) {
    const el = bodyEl?.querySelector<HTMLElement>(`[data-group="${g}"]`);
    el?.scrollIntoView({ block: 'start', behavior: app.reducedMotion ? 'auto' : 'smooth' });
  }

  // Strategies: catalogue presets (or the built-in fallback) and saved ones.
  const strategies = $derived.by(() => {
    const presets = app.catalogue.presets.length ? app.catalogue.presets : FALLBACK_PRESETS;
    return [
      ...presets.map((p) => ({ id: p.id, label: p.label, spec: p.spec as StrategySpec, saved: false })),
      ...app.saved.map((s) => ({ id: s.id, label: s.label, spec: s.spec, saved: true })),
    ];
  });
  const arrivalIdx = $derived.by(() => {
    const k = specKey(app.result.arrivalStrategy);
    return strategies.findIndex((s) => specKey(s.spec) === k);
  });

  function safeLabel(spec: StrategySpec): string {
    try {
      return specLabel(spec);
    } catch {
      return spec.kind;
    }
  }

  function setArrival(i: number) {
    const s = strategies[i];
    if (s && specKey(s.spec) !== specKey(app.result.arrivalStrategy)) set(SETTINGS.find((d) => d.key === 'arrivalStrategy')!, s.spec);
  }

  // Rankings strategy set.
  const rankDef = SETTINGS.find((d) => d.key === 'rankStrategySet')!;
  const rankSubset = $derived(Array.isArray(app.result.rankStrategySet) ? app.result.rankStrategySet : null);

  function setRankMode(all: boolean) {
    if (all) set(rankDef, 'all');
    else if (!rankSubset) set(rankDef, strategies.map((s) => s.id));
  }
  function toggleRank(id: string, on: boolean) {
    const cur = rankSubset ?? strategies.map((s) => s.id);
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    if (next.length === 0) {
      status = 'Keep at least one strategy in the ranking set.';
      return;
    }
    // Keep the catalogue order.
    set(
      rankDef,
      strategies.map((s) => s.id).filter((x) => next.includes(x)),
    );
  }

  // Export size warning.
  const exportDef = SETTINGS.find((d) => d.key === 'exportWarnRows')!;
  let exportCustom = $state(false);
  const exportIdx = $derived(optionIndex(EXPORT_WARN_OPTIONS, app.display.exportWarnRows));
</script>

<Dialog open={app.ui.settings} title="Settings" size="lg" onclose={close}>
  <div class="settings" bind:this={bodyEl}>
    <div class="legend">
      <p>
        <span class="kind-chip result">Result</span> settings are part of the configuration: changing one recomputes trees and cards
        progressively, and non-default values travel in share links.
      </p>
      <p><span class="kind-chip display">Display</span> settings only change how things look and are kept in this browser.</p>
      <p><span class="legend-dot" aria-hidden="true"></span> marks a setting changed from its default.</p>
    </div>

    <nav class="groups" aria-label="Setting groups">
      {#each GROUPS as g (g)}
        <button type="button" class="group-btn" onclick={() => jump(g)}>
          {g}{#if groupChanged[g]}<span class="legend-dot small" aria-hidden="true"></span><span class="visually-hidden"> (changed)</span>{/if}
        </button>
      {/each}
    </nav>

    {#each GROUPS as g (g)}
      <section class="group" data-group={g} aria-labelledby="set-group-{g}">
        <h3 id="set-group-{g}">{g}</h3>
        {#each settingsIn(g) as def (settingId(def))}
          {@const id = settingId(def)}
          {@const c = def.control}
          {@const v = current(def)}
          <SettingRow
            {id}
            label={def.label}
            kind={def.kind}
            defaultText={def.defaultText}
            changed={changed(def)}
            help={def.help}
            wide={c.type === 'custom' && def.key !== 'arrivalStrategy' && def.key !== 'exportWarnRows'}
          >
            {#if c.type === 'toggle'}
              <label class="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={v === true}
                  aria-labelledby="{id}-label"
                  aria-describedby="{id}-help"
                  onchange={(e) => set(def, e.currentTarget.checked)}
                />
                <span class="track" aria-hidden="true"><span class="thumb"></span></span>
                <span class="state" aria-hidden="true">{v ? 'On' : 'Off'}</span>
              </label>
            {:else if c.type === 'choice'}
              <div class="seg" role="radiogroup" aria-labelledby="{id}-label" aria-describedby="{id}-help">
                {#each c.options as o, i (i)}
                  <label class="seg-opt">
                    <input type="radio" name={id} checked={sameValue(o.value, v)} onchange={() => set(def, o.value)} />
                    <span>{o.label}</span>
                  </label>
                {/each}
              </div>
            {:else if c.type === 'select'}
              <select
                class="select"
                aria-labelledby="{id}-label"
                aria-describedby="{id}-help"
                value={optionIndex(c.options, v)}
                onchange={(e) => set(def, c.options[Number(e.currentTarget.value)]?.value)}
              >
                {#if optionIndex(c.options, v) < 0}<option value={-1}>{String(v)}</option>{/if}
                {#each c.options as o, i (i)}
                  <option value={i}>{o.label}</option>
                {/each}
              </select>
            {:else if c.type === 'range'}
              {@const shown = drafts[id] ?? (v as number)}
              <div class="range">
                <input
                  type="range"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={shown}
                  aria-labelledby="{id}-label"
                  aria-describedby="{id}-help"
                  aria-valuetext="{shown}{c.unit ? ` ${c.unit}` : ''}"
                  oninput={(e) => {
                    drafts[id] = Number(e.currentTarget.value);
                    if (def.kind === 'display') commitDraft(def);
                  }}
                  onchange={() => commitDraft(def)}
                />
                <output>{shown}{c.unit ? ` ${c.unit}` : ''}</output>
              </div>
            {:else if c.type === 'number'}
              <input
                class="number"
                type="number"
                inputmode="numeric"
                step={c.step ?? 1}
                min={c.min}
                max={c.max}
                value={v as number}
                aria-labelledby="{id}-label"
                aria-describedby="{id}-help"
                onchange={(e) => {
                  const n = Math.round(Number(e.currentTarget.value));
                  if (e.currentTarget.value.trim() === '' || !Number.isFinite(n)) e.currentTarget.value = String(v);
                  else set(def, n);
                }}
              />
            {:else if def.key === 'answers'}
              <AnswerListControl labelledby="{id}-label" onchanged={() => resultChanged(def.label)} />
            {:else if def.key === 'arrivalStrategy'}
              <select
                class="select wide"
                aria-labelledby="{id}-label"
                aria-describedby="{id}-help"
                value={arrivalIdx}
                onchange={(e) => setArrival(Number(e.currentTarget.value))}
              >
                {#if arrivalIdx < 0}<option value={-1}>{safeLabel(app.result.arrivalStrategy)}</option>{/if}
                {#each strategies as s, i (s.id + i)}
                  <option value={i}>{s.label}{s.saved ? ' (saved)' : ''}</option>
                {/each}
              </select>
            {:else if def.key === 'rankStrategySet'}
              <div class="rank-set">
                <div class="seg" role="radiogroup" aria-labelledby="{id}-label">
                  <label class="seg-opt">
                    <input type="radio" name={id} checked={!rankSubset} onchange={() => setRankMode(true)} />
                    <span>Every preset and saved strategy</span>
                  </label>
                  <label class="seg-opt">
                    <input type="radio" name={id} checked={!!rankSubset} onchange={() => setRankMode(false)} />
                    <span>A chosen subset</span>
                  </label>
                </div>
                {#if rankSubset}
                  <ul class="checks" aria-label="Strategies to rank">
                    {#each strategies as s, i (s.id + i)}
                      <li>
                        <label class="check">
                          <input type="checkbox" checked={rankSubset.includes(s.id)} onchange={(e) => toggleRank(s.id, e.currentTarget.checked)} />
                          <span>{s.label}{s.saved ? ' (saved)' : ''}</span>
                        </label>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {:else if def.key === 'rankOpenerSet'}
              <OpenerSetControl labelledby="{id}-label" onchanged={() => resultChanged(def.label)} />
            {:else if def.key === 'exportWarnRows'}
              <div class="export">
                <select
                  class="select"
                  aria-labelledby="{id}-label"
                  aria-describedby="{id}-help"
                  value={exportCustom || exportIdx < 0 ? -1 : exportIdx}
                  onchange={(e) => {
                    const i = Number(e.currentTarget.value);
                    exportCustom = i < 0;
                    if (i >= 0) set(exportDef, EXPORT_WARN_OPTIONS[i].value);
                  }}
                >
                  {#each EXPORT_WARN_OPTIONS as o, i (i)}
                    <option value={i}>{o.label}</option>
                  {/each}
                  <option value={-1}>{exportIdx < 0 ? exportWarnText(app.display.exportWarnRows) : 'Another size…'}</option>
                </select>
                {#if exportCustom || exportIdx < 0}
                  <label class="num">
                    <input
                      class="number"
                      type="number"
                      inputmode="numeric"
                      min="0"
                      step="1000"
                      value={app.display.exportWarnRows}
                      onchange={(e) => {
                        const n = Math.max(0, Math.round(Number(e.currentTarget.value)));
                        if (Number.isFinite(n)) set(exportDef, n);
                      }}
                    />
                    <span>rows</span>
                  </label>
                {/if}
              </div>
            {/if}
          </SettingRow>
        {/each}
      </section>
    {/each}
  </div>

  {#snippet footer()}
    <p class="status" role="status" aria-live="polite">{status}</p>
    <button type="button" class="btn" onclick={reset} disabled={nChanged === 0}>
      Reset to defaults{#if nChanged}{' '}<span class="count">({nChanged})</span>{/if}
    </button>
    <button type="button" class="btn primary" onclick={close}>Done</button>
  {/snippet}
</Dialog>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .legend {
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--panel);
    font-size: 0.85rem;
    color: var(--muted);
  }
  .legend p {
    margin: 0;
  }
  .kind-chip {
    padding: 0 6px;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid currentColor;
  }
  .kind-chip.result {
    color: var(--accent);
  }
  .legend-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin: 0 2px 1px;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: middle;
  }
  .legend-dot.small {
    width: 6px;
    height: 6px;
    margin-left: 5px;
  }
  .groups {
    position: sticky;
    top: -16px;
    z-index: 1;
    display: flex;
    gap: 4px;
    overflow-x: auto;
    margin: 0 -20px;
    padding: 6px 20px;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    scrollbar-width: none;
  }
  .group-btn {
    flex: none;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font-weight: 600;
    font-size: 0.85rem;
  }
  .group-btn:hover {
    background: var(--panel);
  }
  .group {
    scroll-margin-top: 64px;
  }
  h3 {
    margin: 14px 0 4px;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* Controls (also used by the answer-list and opener-set controls). */
  .settings :global(.btn),
  .btn {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font-weight: 600;
  }
  .settings :global(.btn:disabled),
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn.primary {
    background: var(--fg);
    border-color: var(--fg);
    color: var(--bg);
  }
  .settings :global(input[type='number']),
  .select {
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
  .select {
    max-width: 100%;
  }
  .select.wide {
    min-width: min(100%, 18rem);
  }
  .number {
    width: 8em;
  }
  .settings :global(:is(button, input, select, textarea):focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .switch {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    cursor: pointer;
    position: relative;
  }
  .switch input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .track {
    position: relative;
    width: 44px;
    height: 26px;
    border-radius: 999px;
    background: var(--line);
    transition: background 150ms ease;
  }
  .thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
    transition: transform 150ms ease;
  }
  .switch input:checked + .track {
    background: var(--accent);
  }
  .switch input:checked + .track .thumb {
    transform: translateX(18px);
  }
  .switch input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .state {
    min-width: 2em;
    font-size: 0.85rem;
    color: var(--muted);
  }

  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .seg-opt {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    cursor: pointer;
  }
  .seg-opt + .seg-opt {
    border-left: 1px solid var(--line);
  }
  .seg-opt input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .seg-opt span {
    flex: 1;
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 12px;
    font-size: 0.88rem;
    white-space: nowrap;
  }
  .seg-opt input:checked + span {
    background: var(--accent);
    color: #fff;
    font-weight: 650;
  }
  .seg-opt input:focus-visible + span {
    outline: 2px solid var(--accent);
    outline-offset: -4px;
    box-shadow: inset 0 0 0 4px var(--bg);
  }

  .range {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .range input {
    width: min(14rem, 50vw);
    min-height: 44px;
    accent-color: var(--accent);
  }
  .range output {
    min-width: 3.5em;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
  }
  .rank-set {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  }
  .check {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    cursor: pointer;
  }
  .check input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--accent);
  }
  .export {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .num {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .status {
    flex: 1;
    min-width: 12rem;
    margin: 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  @media (max-width: 600px) {
    .seg {
      display: flex;
      width: 100%;
    }
    .seg-opt {
      flex: 1 1 auto;
    }
    .seg-opt span {
      white-space: normal;
      text-align: center;
      padding: 4px 8px;
    }
  }
</style>
