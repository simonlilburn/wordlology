<script lang="ts">
  // Owned by the panes agent: the Strategy Lab (app.ui.lab).
  // A library of presets and saved strategies, an editor generated from each
  // strategy's parameter schema, a hybrid (phase) builder, a cost guard, Quick
  // check, Run full, and import/export with a shareable link.
  import { app } from '../app/store.svelte';
  import type { StrategySpec } from '../backend/types';
  import { deterministic, hasFrequencies, presets, schemas } from '../panes/services';
  import Modal from '../panes/ui/Modal.svelte';
  import HybridBuilder from './HybridBuilder.svelte';
  import QuickCheck from './QuickCheck.svelte';
  import SpecEditor from './SpecEditor.svelte';
  import { costWarnings, exportJson, shareUrl, unsupportedReason, validateSpec } from './lab';
  import { loadSaved, storeSaved } from './saved';
  import { untrack } from 'svelte';
  import {
    deleteSaved,
    draftForFocus,
    draftFromImport,
    draftFromPreset,
    draftFromSaved,
    hasEdits,
    labState,
    loadDraft,
    newDraft,
    runFull,
    saveDraft,
    sharedDraft,
    useDraft,
    type EditorMode,
  } from './state.svelte';

  // Saved strategies: load once (app/settings.ts restores the same record at
  // start-up too), then write back on every change.
  if (!app.saved.length) {
    const stored = loadSaved();
    if (stored.length) app.saved = stored;
  }
  $effect(() => {
    storeSaved($state.snapshot(app.saved));
  });

  // A shared link ("#lab=CODE") opens the Lab with that strategy.
  const shared = sharedDraft();
  if (shared) {
    loadDraft(shared);
    labState.notice = 'Opened a shared strategy. Save it to keep it in your library.';
    labState.pinned = true;
    app.ui.lab = true;
  }

  const open = $derived(app.ui.lab);
  let importText = $state('');
  let importError = $state('');
  let shareLink = $state('');
  let confirmDelete = $state(false);

  // On opening, start from the strategy in focus unless there is unsaved work
  // (or a shared link just loaded a draft).
  let wasOpen = false;
  $effect(() => {
    const o = open;
    if (o && !wasOpen) {
      untrack(() => {
        if (!labState.draft || (!hasEdits() && !labState.pinned)) loadDraft(draftForFocus());
        labState.pinned = false;
      });
    }
    wasOpen = o;
  });

  const draft = $derived(labState.draft);
  const sch = $derived(schemas());
  const freq = $derived(hasFrequencies());
  const edited = $derived(!!draft && hasEdits());
  const issues = $derived(
    draft
      ? validateSpec(draft.spec, sch, {
          guesses: app.words?.index,
          wordLength: app.words?.wordLength,
          hasFrequencies: freq,
          maxGuesses: app.result.maxGuesses,
        })
      : [],
  );
  const unsupported = $derived(draft ? unsupportedReason(draft.spec, sch, freq) : null);
  const blocked = $derived(unsupported ?? (issues.length ? `Fix ${issues.length === 1 ? 'the problem' : `the ${issues.length} problems`} above first.` : null));
  const warnings = $derived(
    draft
      ? costWarnings(draft.spec, sch, {
          nGuesses: app.words?.guesses.length ?? 14855,
          nAnswers: app.words?.answers.length ?? 2500,
          replicates: app.result.replicatesCard,
          globalPool: app.result.stochasticPool,
          workers: typeof navigator !== 'undefined' ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 3,
        })
      : [],
  );
  const isDet = $derived(draft ? deterministic(draft.spec) : true);
  const json = $derived(draft ? exportJson({ label: draft.label, colour: draft.colour, spec: draft.spec }) : '');
  const colourValue = $derived(draft ? hexColour(draft.colour) : '#7c5cff');

  function hexColour(c: string): string {
    const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
    if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : '#7c5cff';
  }

  function close() {
    app.ui.lab = false;
    confirmDelete = false;
  }

  function pick(load: () => void) {
    if (edited && !confirm('Discard your unsaved changes to this strategy?')) return;
    load();
    shareLink = '';
    confirmDelete = false;
  }

  function setMode(m: EditorMode) {
    labState.mode = m;
  }

  function setSpec(s: StrategySpec) {
    if (labState.draft) labState.draft.spec = s;
  }

  function doImport() {
    const r = draftFromImport(importText);
    if (!r.draft) {
      importError = r.error;
      return;
    }
    importError = '';
    importText = '';
    pick(() => loadDraft(r.draft!));
    labState.notice = 'Imported. Save it to keep it in your library.';
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      labState.notice = `${what} copied.`;
    } catch {
      labState.notice = `Copying is blocked here: select the ${what.toLowerCase()} and copy it by hand.`;
    }
  }

  function download() {
    if (!draft) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${draft.label.trim().replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'strategy'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    labState.notice = 'Downloaded the strategy JSON.';
  }

  function share() {
    if (!draft) return;
    shareLink = shareUrl({ label: draft.label, colour: draft.colour, spec: draft.spec }, location);
    void copy(shareLink, 'Share link');
  }

  function doDelete() {
    if (!draft?.savedId) return;
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    deleteSaved(draft.savedId);
    confirmDelete = false;
  }

  function newStrategy() {
    pick(() => loadDraft(newDraft()));
  }

  function newHybrid() {
    pick(() =>
      loadDraft(
        newDraft(
          {
            kind: 'switch',
            first: { kind: 'fixed_sequence', words: ['crane'], solve_when_one: true },
            when: { when: 'sequence_exhausted' },
            then: { kind: 'max_info', pool: 'candidates' },
          },
          'My hybrid',
        ),
        'phases',
      ),
    );
  }

  const isSel = (kind: 'preset' | 'saved', id: string) =>
    !!draft && (kind === 'saved' ? draft.savedId === id : !draft.savedId && draft.presetId === id);
</script>

{#snippet libraryItem(kind: 'preset' | 'saved', id: string, label: string, colour: string, spec: StrategySpec, load: () => void)}
  {@const reason = unsupportedReason(spec, sch, freq)}
  <li class:selected={isSel(kind, id)}>
    <button type="button" class="libbtn" aria-current={isSel(kind, id) ? 'true' : undefined} onclick={() => pick(load)}>
      <span class="swatch" style:background={colour} aria-hidden="true"></span>
      <span class="name">{label}</span>
      <span class="tag">{deterministic(spec) ? 'deterministic' : 'stochastic'}</span>
    </button>
    {#if reason}<p class="why">{reason}</p>{/if}
    <details>
      <summary>JSON</summary>
      <pre>{JSON.stringify(spec, null, 1)}</pre>
    </details>
  </li>
{/snippet}

{#if open}
  <Modal title="Strategy Lab" onclose={close} width={1100} fill>
    <div class="lab">
      <nav class="library" aria-label="Strategy library">
        <div class="newbtns">
          <button type="button" onclick={newStrategy}>+ New</button>
          <button type="button" onclick={newHybrid}>+ Hybrid</button>
        </div>
        <h3>Presets</h3>
        <ul>
          {#each presets() as p (p.id)}
            {@render libraryItem('preset', p.id, p.label, p.colour, p.spec, () => loadDraft(draftFromPreset(p)))}
          {/each}
        </ul>
        <h3>Saved in this browser</h3>
        {#if app.saved.length}
          <ul>
            {#each app.saved as s (s.id)}
              {@render libraryItem('saved', s.id, s.label, s.colour, s.spec, () => loadDraft(draftFromSaved(s)))}
            {/each}
          </ul>
        {:else}
          <p class="muted">Nothing saved yet. Edit a preset or start a new strategy, then Save.</p>
        {/if}
        <h3><label for="lab-import">Import</label></h3>
        <textarea id="lab-import" bind:value={importText} rows="3" placeholder="Paste strategy JSON or a share link" aria-describedby="lab-import-err" spellcheck="false"></textarea>
        <button type="button" onclick={doImport} disabled={!importText.trim()}>Import</button>
        {#if importError}<p class="issue" id="lab-import-err" role="alert">{importError}</p>{/if}
      </nav>

      {#if draft}
        <div class="editor">
          <div class="identity">
            <label class="namefield">
              <span>Name</span>
              <input data-autofocus bind:value={draft.label} maxlength="60" autocomplete="off" />
            </label>
            <label class="colourfield">
              <span>Colour</span>
              <input type="color" value={colourValue} oninput={(e) => draft && (draft.colour = e.currentTarget.value)} />
            </label>
          </div>
          <p class="status">
            <span class="tag">{isDet ? 'Deterministic: one game per target' : 'Stochastic: R games per target'}</span>
            {#if draft.savedId}<span class="tag">saved</span>{:else if draft.presetId}<span class="tag">preset copy</span>{:else}<span class="tag">new</span>{/if}
            {#if edited}<span class="tag edited">unsaved changes</span>{/if}
          </p>

          {#if unsupported}
            <p class="warn" role="alert"><strong>Not available with this word list.</strong> {unsupported}</p>
          {/if}
          {#each warnings as w, i (i)}
            <p class="warn cost" role="note">
              <strong>Cost guard.</strong>
              {w.message}
              {#if app.result.stochasticPool === 'allowed'}The “Stochastic guess pool” setting is “all allowed guesses”; set it to candidates to speed this up.{:else}Choose the candidate pool to speed this up.{/if}
            </p>
          {/each}

          <div class="tabs" role="tablist" aria-label="Editor">
            <button type="button" role="tab" id="lab-tab-form" aria-controls="lab-panel" aria-selected={labState.mode === 'form'} onclick={() => setMode('form')}>Parameters</button>
            <button type="button" role="tab" id="lab-tab-phases" aria-controls="lab-panel" aria-selected={labState.mode === 'phases'} onclick={() => setMode('phases')}>Phases (hybrid builder)</button>
          </div>
          <div class="panel" id="lab-panel" role="tabpanel" aria-labelledby={labState.mode === 'form' ? 'lab-tab-form' : 'lab-tab-phases'}>
            {#key `${labState.draftVersion}|${labState.mode}`}
              {#if labState.mode === 'form'}
                <SpecEditor spec={draft.spec} onchange={setSpec} schemas={sch} {issues} idPrefix="lab" {freq} maxGuesses={app.result.maxGuesses} />
              {:else}
                <HybridBuilder spec={draft.spec} onchange={setSpec} schemas={sch} {issues} {freq} maxGuesses={app.result.maxGuesses} />
              {/if}
            {/key}
          </div>

          {#if issues.length}
            <div class="issues" role="status">
              <strong>{issues.length === 1 ? '1 problem' : `${issues.length} problems`}</strong>
              <ul>
                {#each issues as i, k (k)}<li>{i.path ? `${i.path}: ` : ''}{i.message}</li>{/each}
              </ul>
            </div>
          {/if}

          <details class="json">
            <summary>Strategy JSON</summary>
            <textarea readonly rows="8" value={json} aria-label="Strategy JSON"></textarea>
          </details>

          <QuickCheck spec={draft.spec} colour={draft.colour} {blocked} />

          <div class="actions" role="group" aria-label="Strategy actions">
            <button type="button" class="primary" onclick={runFull} disabled={!!blocked} title={blocked ?? 'Add as an Atlas column and focus it'}>Run full</button>
            <button type="button" onclick={useDraft} disabled={!!blocked} title={blocked ?? 'Use in the Tree and Card views'}>Use</button>
            <button type="button" onclick={() => saveDraft()} disabled={!!draft.savedId && !edited}>{draft.savedId ? 'Save' : 'Save to library'}</button>
            {#if draft.savedId}
              <button type="button" onclick={() => saveDraft(true)}>Save as new</button>
              <button type="button" class:danger={confirmDelete} onclick={doDelete}>{confirmDelete ? 'Confirm delete' : 'Delete'}</button>
            {/if}
          </div>
          <div class="actions" role="group" aria-label="Export">
            <button type="button" onclick={() => copy(json, 'Strategy JSON')}>Copy JSON</button>
            <button type="button" onclick={download}>Download JSON</button>
            <button type="button" onclick={share}>Copy share link</button>
          </div>
          {#if shareLink}
            <label class="share">
              <span>Share link</span>
              <input readonly value={shareLink} onfocus={(e) => e.currentTarget.select()} />
            </label>
          {/if}
          <p class="notice" aria-live="polite">{labState.notice}</p>
          {#if blocked && !unsupported}<p class="muted">Run full, Use and Quick check need a valid strategy.</p>{/if}
          <p class="muted small">
            Run full adds this strategy to the Atlas as a column ({app.result.replicatesCard} replicates per target for stochastic strategies) and focuses it.
            Run full and Use save an edited strategy to your library first; an unchanged preset is used as it is.
          </p>
        </div>
      {/if}
    </div>
  </Modal>
{/if}

<style>
  .lab {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 270px 1fr;
  }
  .library {
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
    border-right: 1px solid var(--line);
    background: var(--panel);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .editor {
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  @media (max-width: 720px) {
    .lab {
      display: block;
      overflow-y: auto;
    }
    .library {
      border-right: 0;
      border-bottom: 1px solid var(--line);
      overflow: visible;
    }
    .editor {
      overflow: visible;
    }
  }
  h3 {
    margin: 6px 0 0;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    border: 1px solid transparent;
    border-radius: 8px;
  }
  li.selected {
    border-color: var(--fg);
    background: var(--bg);
  }
  .libbtn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    border: 0;
    background: transparent;
  }
  .swatch {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 4px;
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .tag {
    display: inline-block;
    font-size: 0.7rem;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 6px;
    margin-right: 4px;
    white-space: nowrap;
  }
  .tag.edited {
    color: var(--fg);
    border-color: var(--accent);
  }
  .why {
    margin: 0 8px 4px 30px;
    font-size: 0.75rem;
    color: #b0461c;
  }
  details {
    margin: 0 8px 4px 30px;
    font-size: 0.75rem;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
    min-height: 24px;
  }
  pre {
    margin: 4px 0;
    white-space: pre-wrap;
    word-break: break-word;
    font: 0.72rem var(--font-mono);
  }
  .newbtns {
    display: flex;
    gap: 6px;
  }
  .newbtns button {
    flex: 1;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    padding: 8px;
    font: 0.8rem var(--font-mono);
    resize: vertical;
  }
  .identity {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .namefield {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .namefield input {
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: 600 1.05rem var(--font-sans);
  }
  .colourfield {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .colourfield input {
    width: 56px;
    height: 44px;
    padding: 2px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
  }
  .status {
    margin: 0;
  }
  .warn {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid #e0a64a;
    border-radius: 8px;
    background: color-mix(in srgb, #e0a64a 14%, var(--bg));
    font-size: 0.85rem;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    border: 0;
    border-bottom: 3px solid transparent;
    border-radius: 0;
    background: transparent;
  }
  .tabs button[aria-selected='true'] {
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .issues {
    padding: 8px 10px;
    border: 1px solid #d64545;
    border-radius: 8px;
    font-size: 0.82rem;
  }
  .issues ul {
    margin-top: 4px;
    padding-left: 18px;
    list-style: disc;
    gap: 0;
  }
  .issue {
    margin: 0;
    font-size: 0.8rem;
    color: #c03030;
  }
  .json textarea {
    margin-top: 6px;
  }
  .json {
    margin: 0;
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .share {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.8rem;
  }
  .share input {
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: 0.75rem var(--font-mono);
  }
  .notice {
    margin: 0;
    min-height: 1.2em;
    font-size: 0.85rem;
  }
  .muted {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .small {
    font-size: 0.75rem;
  }
  button {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
  }
  .libbtn {
    padding: 6px 8px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .primary {
    background: var(--fg);
    color: var(--bg);
    border-color: var(--fg);
    font-weight: 600;
  }
  .danger {
    border-color: #d64545;
    color: #c03030;
    font-weight: 600;
  }
  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible,
  summary:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
