<script lang="ts">
  // The letter filter builder: one slot per letter position, extra rules, and a
  // text field, both editing app.filter (two-way). Scope, mode, readout and
  // "Reveal matches" sit below.
  import { app } from '../../app/store.svelte';
  import { parseFilter } from '../../model/filter';
  import { paneState, requestRevealMatches } from '../state.svelte';
  import { draftsToText, emptyDraft, ruleToDraft, slotLabel, textToDrafts, type RuleDraft } from './builder';
  import FilterReadout from './FilterReadout.svelte';
  import SlotEditor from './SlotEditor.svelte';

  let { textEl = $bindable(null) }: { textEl?: HTMLInputElement | null } = $props();

  const len = $derived(app.words?.wordLength ?? 5);
  const maxGuesses = $derived(app.result.maxGuesses);

  let lastCommitted = app.filter?.text ?? '';
  let drafts = $state<RuleDraft[]>(textToDrafts(app.filter?.text ?? '', app.words?.wordLength ?? 5));
  let text = $state(app.filter?.text ?? '');
  let error = $state<{ message: string; at: number } | null>(null);
  let selected = $state<{ rule: number; slot: number } | null>(null);
  const slotButtons: HTMLButtonElement[][] = [];

  // Follow external changes to app.filter (URL restore, clearing elsewhere) and word length changes.
  $effect(() => {
    const f = app.filter;
    const t = f?.text ?? '';
    const l = len;
    if (t !== lastCommitted || drafts[0]?.slots.length !== l) {
      lastCommitted = t;
      drafts = textToDrafts(t, l);
      text = t;
      // A filter from a link (or a list with another word length) may not parse: say where.
      const r = t.trim() ? parseFilter(t, l) : null;
      error = r && !r.ok ? { message: r.error, at: r.at } : null;
      selected = null;
    }
    if (f) {
      paneState.filterCombine = f.combine;
      paneState.filterMode = f.mode;
      paneState.filterRows = [...f.rows];
      paneState.filterIncludeFinal = f.includeFinal;
    }
  });

  function commit(t: string) {
    lastCommitted = t;
    if (t === '') {
      app.filter = null;
      return;
    }
    app.filter = {
      text: t,
      combine: paneState.filterCombine,
      mode: paneState.filterMode,
      rows: [...paneState.filterRows],
      includeFinal: paneState.filterIncludeFinal,
    };
  }

  /** The builder changed: regenerate the text and commit. */
  function fromDrafts() {
    const t = draftsToText(drafts);
    text = t;
    error = null;
    commit(t);
  }

  /** The text changed: parse; valid text updates the builder and commits. */
  function fromText() {
    if (text.trim() === '') {
      error = null;
      drafts = [emptyDraft(len)];
      commit('');
      return;
    }
    const r = parseFilter(text, len);
    if (!r.ok) {
      error = { message: r.error, at: r.at };
      return;
    }
    error = null;
    drafts = r.rules.map(ruleToDraft);
    selected = null;
    commit(draftsToText(drafts));
  }

  function canonicalise() {
    if (!error) text = lastCommitted;
  }

  function settings() {
    if (app.filter) {
      app.filter.combine = paneState.filterCombine;
      app.filter.mode = paneState.filterMode;
      app.filter.rows = [...paneState.filterRows];
      app.filter.includeFinal = paneState.filterIncludeFinal;
    }
  }

  function addRule() {
    drafts.push(emptyDraft(len));
    selected = { rule: drafts.length - 1, slot: 0 };
  }

  function removeRule(i: number) {
    drafts.splice(i, 1);
    if (!drafts.length) drafts.push(emptyDraft(len));
    selected = null;
    fromDrafts();
  }

  function clearAll() {
    drafts = [emptyDraft(len)];
    selected = null;
    fromDrafts();
  }

  function toggleRow(row: number, on: boolean) {
    const rows = new Set(paneState.filterRows);
    if (on) rows.add(row);
    else rows.delete(row);
    paneState.filterRows = [...rows].sort((a, b) => a - b);
    settings();
  }

  /** Fast entry: typing a letter on a focused slot sets it and moves on; ? or Backspace clears. */
  function slotKey(e: KeyboardEvent, ri: number, si: number) {
    const k = e.key;
    let handled = true;
    const slot = drafts[ri].slots[si];
    if (/^[a-z]$/i.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      slot.mode = 'letter';
      slot.letters = k.toLowerCase();
      fromDrafts();
      slotButtons[ri]?.[Math.min(si + 1, len - 1)]?.focus();
    } else if (k === '?' || k === 'Backspace' || k === 'Delete') {
      slot.mode = 'any';
      slot.negate = false;
      slot.letters = '';
      fromDrafts();
      if (k === 'Backspace') slotButtons[ri]?.[Math.max(si - 1, 0)]?.focus();
    } else if (k === 'ArrowRight') {
      slotButtons[ri]?.[Math.min(si + 1, len - 1)]?.focus();
    } else if (k === 'ArrowLeft') {
      slotButtons[ri]?.[Math.max(si - 1, 0)]?.focus();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function token(ri: number, si: number): string {
    const d = drafts[ri].slots[si];
    switch (d.mode) {
      case 'any':
        return '?';
      case 'letter':
        return d.letters ? (d.negate ? '!' : '') + d.letters.toUpperCase() : '?';
      case 'set':
        return d.letters ? (d.negate ? '^' : '') + d.letters.toUpperCase() : '?';
      case 'vowel':
        return d.negate ? '¬V' : 'V';
      case 'consonant':
        return d.negate ? '¬C' : 'C';
    }
  }

  const errorParts = $derived(
    error ? { before: text.slice(0, error.at), at: text.slice(error.at, error.at + 1) || ' ', after: text.slice(error.at + 1) } : null,
  );
</script>

<div class="builder">
  {#each drafts as rule, ri (ri)}
    <fieldset class="rule">
      <legend>
        {drafts.length > 1 ? `Rule ${ri + 1}` : 'Letters by position'}
        {#if drafts.length > 1}
          <button type="button" class="link" onclick={() => removeRule(ri)} aria-label="Remove rule {ri + 1}">Remove</button>
        {/if}
      </legend>
      <div class="slots" role="group" aria-label="Rule {ri + 1} letter positions. Type a letter on a position to set it; ? clears it.">
        {#each rule.slots as slot, si (si)}
          {@const open = selected?.rule === ri && selected?.slot === si}
          <button
            type="button"
            class="slot"
            class:set={slot.mode !== 'any'}
            class:open
            bind:this={
              () => slotButtons[ri]?.[si],
              (el) => {
                (slotButtons[ri] ??= [])[si] = el as HTMLButtonElement;
              }
            }
            aria-expanded={open}
            aria-controls="slot-editor-{ri}"
            aria-label="Position {si + 1}: {slotLabel(slot)}"
            onclick={() => (selected = open ? null : { rule: ri, slot: si })}
            onkeydown={(e) => slotKey(e, ri, si)}
          >
            <span class="tok">{token(ri, si)}</span>
            <span class="pos" aria-hidden="true">{si + 1}</span>
          </button>
        {/each}
      </div>
      {#if selected?.rule === ri}
        <SlotEditor bind:slot={rule.slots[selected.slot]} position={selected.slot + 1} id="slot-editor-{ri}" onchange={fromDrafts} />
      {/if}
      <div class="extras">
        <label>
          <span>Contains</span>
          <input
            value={rule.contains}
            oninput={(e) => {
              rule.contains = e.currentTarget.value.toUpperCase();
              fromDrafts();
            }}
            placeholder="E"
            autocomplete="off"
            spellcheck="false"
            aria-label="Rule {ri + 1}: contains these letters anywhere"
          />
        </label>
        <label>
          <span>Excludes</span>
          <input
            value={rule.excludes}
            oninput={(e) => {
              rule.excludes = e.currentTarget.value.toUpperCase();
              fromDrafts();
            }}
            placeholder="S"
            autocomplete="off"
            spellcheck="false"
            aria-label="Rule {ri + 1}: excludes these letters"
          />
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={rule.repeated}
            onchange={(e) => {
              rule.repeated = e.currentTarget.checked;
              fromDrafts();
            }}
          />
          <span>Has a repeated letter</span>
        </label>
      </div>
    </fieldset>
  {/each}

  <div class="row">
    <button type="button" onclick={addRule}>+ Add rule</button>
    {#if drafts.length > 1}
      <div class="seg" role="radiogroup" aria-label="Combine rules">
        {#each [['all', 'All'], ['any', 'Any']] as [v, l] (v)}
          <button
            type="button"
            role="radio"
            aria-checked={paneState.filterCombine === v}
            class:on={paneState.filterCombine === v}
            onclick={() => {
              paneState.filterCombine = v as 'all' | 'any';
              settings();
            }}>{l}</button
          >
        {/each}
      </div>
    {/if}
  </div>

  <label class="textlabel" for="filter-text">Pattern</label>
  <input
    id="filter-text"
    class="text"
    class:bad={!!error}
    bind:this={textEl}
    bind:value={text}
    oninput={fromText}
    onblur={canonicalise}
    autocomplete="off"
    autocapitalize="characters"
    spellcheck="false"
    placeholder={'?'.repeat(len) + '  e.g. ?A??Y +E -S'}
    aria-invalid={!!error}
    aria-describedby="filter-help filter-error"
  />
  {#if errorParts && error}
    <p id="filter-error" class="error" role="alert">
      <span class="show" aria-hidden="true">{errorParts.before}<mark>{errorParts.at}</mark>{errorParts.after}</span>
      Column {error.at + 1}: {error.message}
    </p>
  {:else}
    <p id="filter-help" class="help">
      <code>?</code> any · <code>A</code> letter · <code>[AE]</code> set · <code>{'{v}'}</code>/<code>{'{c}'}</code> vowel/consonant ·
      <code>!S</code>, <code>[^AE]</code>, <code>{'{^v}'}</code> not · <code>+E</code> contains · <code>-S</code> excludes · <code>*</code> repeat ·
      <code>|</code> another rule
    </p>
  {/if}

  <fieldset class="scope">
    <legend>Apply to</legend>
    <div class="seg" role="radiogroup" aria-label="Rows">
      <button
        type="button"
        role="radio"
        aria-checked={paneState.filterRows.length === 0}
        class:on={paneState.filterRows.length === 0}
        onclick={() => {
          paneState.filterRows = [];
          settings();
        }}>Any guess</button
      >
      <button
        type="button"
        role="radio"
        aria-checked={paneState.filterRows.length > 0}
        class:on={paneState.filterRows.length > 0}
        onclick={() => {
          if (!paneState.filterRows.length) paneState.filterRows = [1];
          settings();
        }}>Chosen guesses</button
      >
    </div>
    {#if paneState.filterRows.length > 0}
      <div class="rows" role="group" aria-label="Guess numbers">
        {#each Array.from({ length: maxGuesses }, (_, i) => i + 1) as row (row)}
          <label class="rowbox">
            <input type="checkbox" checked={paneState.filterRows.includes(row)} onchange={(e) => toggleRow(row, e.currentTarget.checked)} />
            <span>{row}</span>
          </label>
        {/each}
      </div>
    {/if}
    <label class="check">
      <input
        type="checkbox"
        checked={paneState.filterIncludeFinal}
        onchange={(e) => {
          paneState.filterIncludeFinal = e.currentTarget.checked;
          settings();
        }}
      />
      <span>Include the final solving guess</span>
    </label>
  </fieldset>

  <div class="row">
    <span class="lbl" id="filter-mode-label">Mode</span>
    <div class="seg" role="radiogroup" aria-labelledby="filter-mode-label">
      {#each [['highlight', 'Highlight'], ['isolate', 'Isolate']] as [v, l] (v)}
        <button
          type="button"
          role="radio"
          aria-checked={paneState.filterMode === v}
          class:on={paneState.filterMode === v}
          onclick={() => {
            paneState.filterMode = v as 'highlight' | 'isolate';
            settings();
          }}>{l}</button
        >
      {/each}
    </div>
  </div>

  <FilterReadout />

  <div class="row">
    <button type="button" disabled={!app.filter} onclick={requestRevealMatches}>Reveal matches</button>
    <button type="button" disabled={!app.filter && !text} onclick={clearAll}>Clear filter</button>
  </div>
</div>

<style>
  .builder {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  fieldset {
    margin: 0;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  legend {
    padding: 0 4px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .slots {
    display: flex;
    gap: 4px;
  }
  .slot {
    flex: 1;
    min-width: 0;
    min-height: 52px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    border: 1px dashed var(--muted);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font-family: var(--font-mono);
  }
  .slot.set {
    border: 2px solid var(--accent);
  }
  .slot.open {
    background: color-mix(in srgb, var(--accent) 14%, var(--bg));
  }
  .tok {
    font-weight: 700;
    font-size: 0.95rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pos {
    font-size: 0.65rem;
    color: var(--muted);
  }
  .extras {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .extras label:not(.check) {
    display: flex;
    flex-direction: column;
    font-size: 0.75rem;
    color: var(--muted);
    gap: 2px;
  }
  .extras input:not([type='checkbox']),
  .text {
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: 600 0.95rem var(--font-mono);
    min-width: 0;
  }
  .check {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    font-size: 0.85rem;
  }
  .check input,
  .rowbox input {
    width: 20px;
    height: 20px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .lbl,
  .textlabel {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .textlabel {
    margin-bottom: -6px;
  }
  .text.bad {
    border-color: #d64545;
  }
  .error {
    margin: 0;
    font-size: 0.8rem;
    color: #c03030;
  }
  .error .show {
    display: block;
    font-family: var(--font-mono);
    white-space: pre;
    overflow-x: auto;
    color: var(--fg);
  }
  .error mark {
    background: #f4b4b4;
    color: #000;
    text-decoration: underline wavy #c03030;
  }
  .help {
    margin: 0;
    font-size: 0.75rem;
    color: var(--muted);
    line-height: 1.6;
  }
  .help code {
    font-family: var(--font-mono);
    color: var(--fg);
  }
  .rows {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .rowbox {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    min-width: 44px;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
  }
  button {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .link {
    min-height: 0;
    padding: 0 4px;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 0.8rem;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
  }
  .seg button {
    border: 0;
    border-radius: 0;
  }
  .seg button + button {
    border-left: 1px solid var(--line);
  }
  .seg button.on {
    background: var(--fg);
    color: var(--bg);
    font-weight: 600;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
