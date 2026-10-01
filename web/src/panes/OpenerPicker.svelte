<script lang="ts">
  // Owned by the panes agent: opener picker (app.ui.openerPicker), mounted by Dialogs.svelte.
  // A text field validated against the guess list, the top 10 openers by
  // one-step information for the current configuration, common human openers
  // and recent ones. What choosing does depends on how it was opened
  // (paneState.openerPickerMode, see state.svelte.ts): 'atlas-row' appends an
  // Atlas row (the card's dashed "+ Opener" card), 'focus' sets the opener.
  import { setOpener } from '../app/actions';
  import { app } from '../app/store.svelte';
  import { configFor, focusedSpec, labelOf, openerInfo } from './services';
  import { closeOpenerPicker, paneState } from './state.svelte';
  import { HUMAN_OPENERS, openerProblem, topK, withAtlasRow } from './opener';
  import Modal from './ui/Modal.svelte';
  import { attempt, fmtNum } from './util';

  let text = $state('');
  let top = $state<{ word: string; bits: number }[] | null>(null);
  let topState = $state<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');

  const open = $derived(app.ui.openerPicker);
  const atlasMode = $derived(paneState.openerPickerMode === 'atlas-row');
  const len = $derived(app.words?.wordLength ?? 5);
  const index = $derived(app.words?.index ?? null);
  const problem = $derived(openerProblem(text, len, index ? (w) => index.has(w) : null));
  const word = $derived(text.trim().toLowerCase());
  const valid = $derived(!!word && !problem);
  const strategyName = $derived(app.focus.strategy?.label ?? labelOf(focusedSpec()));

  const human = $derived(HUMAN_OPENERS.filter((w) => w.length === len && (!index || index.has(w))));
  const recent = $derived(app.focus.recentOpeners.filter((w) => w.length === len).slice(0, 8));
  /** Openers already shown: the Atlas rows (atlas mode) or the current opener. */
  const taken = $derived(atlasMode ? (app.atlas.rows.length ? app.atlas.rows : [app.focus.opener]) : [app.focus.opener]);

  // Screen the openers once per opening (the backend caches the scores per word list and rules).
  let requested = '';
  $effect(() => {
    if (!open) {
      requested = '';
      return;
    }
    const words = app.words;
    const config = configFor(focusedSpec(), null, 'card');
    const key = `${words?.manifest.id}|${words?.answers.length}|${app.result.hardMode}|${app.result.maxGuesses}`;
    if (!words || !config || key === requested) return;
    requested = key;
    topState = 'loading';
    void openerInfo(config).then((info) => {
      if (requested !== key) return;
      if (!info || !info.length) {
        topState = 'unavailable';
        top = null;
        return;
      }
      top = topK(info, 10).map((id) => ({ word: words.guesses[id] ?? '', bits: info[id] })).filter((x) => x.word);
      topState = 'ready';
    });
  });

  function close() {
    text = '';
    closeOpenerPicker();
  }

  function choose(opener: string | null) {
    if (atlasMode) {
      const s = app.focus.strategy;
      if (s && !app.atlas.columns.length) app.atlas.columns = [s];
      app.atlas.rows = withAtlasRow(app.atlas.rows, app.focus.opener, opener);
    } else {
      attempt(() => setOpener(opener), undefined);
    }
    close();
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (valid) choose(word);
  }

  function rankAll() {
    const s = app.focus.strategy;
    if (!s) return;
    app.ui.rankingFor = { kind: 'column', strategy: s.id };
    close();
  }
</script>

{#snippet chip(w: string | null, detail?: string)}
  {@const isTaken = taken.includes(w)}
  <li>
    <button type="button" class="chip" class:mono={w !== null} disabled={atlasMode && isTaken} aria-pressed={!atlasMode ? isTaken : undefined} onclick={() => choose(w)}>
      <span>{w === null ? "Strategy's choice" : w.toUpperCase()}</span>
      {#if detail}<span class="detail">{detail}</span>{/if}
      {#if atlasMode && isTaken}<span class="detail">in grid</span>{/if}
    </button>
  </li>
{/snippet}

{#if open}
  <Modal title={atlasMode ? 'Add an opener row' : 'Choose an opener'} onclose={close} width={520}>
    <p class="intro">
      {#if atlasMode}Adds a row to the grid: every strategy column plays the new opener.{:else}The first guess of every game in the Tree and Card views.{/if}
    </p>
    <form class="row" onsubmit={submit}>
      <label class="visually-hidden" for="opener-picker-input">Opener word</label>
      <input
        id="opener-picker-input"
        data-autofocus
        bind:value={text}
        class:bad={!!problem && word.length >= len}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        maxlength={len + 2}
        placeholder="Type a word"
        aria-invalid={!!problem && word.length >= len}
        aria-describedby="opener-picker-msg"
      />
      <button type="submit" class="primary" disabled={!valid}>{atlasMode ? 'Add row' : 'Use'}</button>
    </form>
    <p id="opener-picker-msg" class="msg" aria-live="polite">{problem}</p>

    <section aria-labelledby="op-top">
      <h3 id="op-top">Top 10 by one-step information</h3>
      {#if topState === 'loading'}
        <p class="muted">Scoring every guess…</p>
      {:else if topState === 'unavailable'}
        <p class="muted">Scores are not available until the solver has loaded.</p>
      {:else if top}
        <ol class="chips">
          {#each top as t (t.word)}
            {@render chip(t.word, `${fmtNum(t.bits, 2)} bits`)}
          {/each}
        </ol>
      {/if}
      {#if app.focus.strategy}
        <button type="button" class="link" onclick={rankAll}>Rank every opener under {strategyName}…</button>
      {/if}
    </section>

    <section aria-labelledby="op-human">
      <h3 id="op-human">Common human openers</h3>
      <ul class="chips">
        {@render chip(null)}
        {#each human as w (w)}
          {@render chip(w)}
        {/each}
      </ul>
    </section>

    {#if recent.length}
      <section aria-labelledby="op-recent">
        <h3 id="op-recent">Recent</h3>
        <ul class="chips">
          {#each recent as w (w)}
            {@render chip(w)}
          {/each}
        </ul>
      </section>
    {/if}
  </Modal>
{/if}

<style>
  .intro {
    margin: 0 0 10px;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 6px;
  }
  input {
    flex: 1;
    min-width: 0;
    min-height: 48px;
    box-sizing: border-box;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--fg);
    font: 600 1.1rem var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  input.bad {
    border-color: #d64545;
  }
  .msg {
    min-height: 1.2em;
    margin: 4px 0 8px;
    font-size: 0.8rem;
    color: var(--muted);
  }
  section {
    margin-top: 10px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .chips {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  button {
    min-height: 44px;
    min-width: 44px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border-radius: 999px;
  }
  .chip.mono span:first-child {
    font: 700 0.95rem var(--font-mono);
    letter-spacing: 0.06em;
  }
  .chip[aria-pressed='true'] {
    border-color: var(--fg);
  }
  .detail {
    font-size: 0.75rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .primary {
    background: var(--fg);
    color: var(--bg);
    border-color: var(--fg);
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .link {
    margin-top: 6px;
    border: 0;
    padding: 0 4px;
    background: none;
    color: var(--accent);
  }
  .muted {
    margin: 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  button:focus-visible,
  input:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
</style>
