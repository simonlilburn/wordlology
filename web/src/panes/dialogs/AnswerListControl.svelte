<script lang="ts">
  // The answer-list setting: the 2,500 default, a frequency cutoff from 1,000
  // up to the ranked list's length, or a pasted list validated against the
  // guess list.
  import { app } from '../../app/store.svelte';
  import { setPastedAnswers } from '../../app/settings';
  import { answerSummary, checkPastedWords, clampCutoff, cutoffRange, fmtInt, listSome, pastedMessage } from './settings';

  let { labelledby, onchanged }: { labelledby: string; onchanged: () => void } = $props();

  const name = `answers-${Math.random().toString(36).slice(2, 8)}`;
  const initial = app.result.answers;
  let mode = $state<'default' | 'top' | 'pasted'>(initial.kind);
  let cutoff = $state(initial.kind === 'top' ? initial.n : 2500);
  let pasteText = $state(initial.kind === 'pasted' ? initial.words.join(' ') : '');

  const range = $derived(cutoffRange(app.words?.ranked?.length ?? app.words?.manifest.counts?.answers_ranked));
  const hasRanked = $derived(!app.words || !!app.words.ranked);
  const lexicon = $derived(app.words ? { wordLength: app.words.wordLength, index: app.words.index } : null);
  const check = $derived(lexicon && pasteText.trim() ? checkPastedWords(pasteText, lexicon) : null);
  const current = $derived(app.result.answers);
  const pastedApplied = $derived(
    current.kind === 'pasted' && !!check && check.words.length === current.words.length && check.words.every((w, i) => w === current.words[i]),
  );

  function commit(next: typeof app.result.answers) {
    if (JSON.stringify(next) === JSON.stringify(app.result.answers)) return;
    app.result.answers = next;
    onchanged();
  }

  function chooseMode(m: 'default' | 'top' | 'pasted') {
    mode = m;
    if (m === 'default') commit({ kind: 'default' });
    else if (m === 'top') commitCutoff();
    // A pasted list waits for "Use these words".
  }

  function commitCutoff() {
    cutoff = clampCutoff(cutoff, range);
    commit({ kind: 'top', n: cutoff });
  }

  function applyPaste() {
    if (!check || check.words.length === 0) return;
    const before = JSON.stringify(app.result.answers);
    try {
      setPastedAnswers(check.words);
    } catch {
      app.result.answers = { kind: 'pasted', words: [...check.words] };
    }
    if (JSON.stringify(app.result.answers) !== before) onchanged();
  }
</script>

<div class="answers" role="radiogroup" aria-labelledby={labelledby}>
  <label class="opt">
    <input type="radio" {name} checked={mode === 'default'} onchange={() => chooseMode('default')} />
    <span>2,500 most frequent words</span>
  </label>

  <label class="opt" class:disabled={!hasRanked}>
    <input type="radio" {name} checked={mode === 'top'} disabled={!hasRanked} onchange={() => chooseMode('top')} />
    <span>Frequency cutoff</span>
  </label>
  {#if mode === 'top'}
    <div class="sub">
      <input
        type="range"
        min={range.min}
        max={range.max}
        step="50"
        bind:value={cutoff}
        onchange={commitCutoff}
        aria-label="Number of most frequent words"
        aria-valuetext="{fmtInt(cutoff)} words"
      />
      <label class="num">
        <input type="number" inputmode="numeric" min={range.min} max={range.max} step="1" bind:value={cutoff} onchange={commitCutoff} />
        <span>words</span>
      </label>
      <p class="note">From {fmtInt(range.min)} up to all {fmtInt(range.max)} reviewed answers, most frequent first.</p>
    </div>
  {/if}

  <label class="opt">
    <input type="radio" {name} checked={mode === 'pasted'} onchange={() => chooseMode('pasted')} />
    <span>A pasted list</span>
  </label>
  {#if mode === 'pasted'}
    <div class="sub">
      <label class="visually-hidden" for="{name}-paste">Words for the answer list</label>
      <textarea
        id="{name}-paste"
        rows="4"
        bind:value={pasteText}
        placeholder="Paste words separated by spaces, commas or new lines"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
      ></textarea>
      {#if !lexicon}
        <p class="note">The guess list is still loading.</p>
      {:else if check}
        <p class="note" aria-live="polite">{pastedMessage(check, lexicon.wordLength)}.</p>
        {#if check.unknown.length}<p class="warn">Not in the guess list: {listSome(check.unknown)}</p>{/if}
        {#if check.malformed.length}<p class="warn">Not {lexicon.wordLength}-letter words: {listSome(check.malformed)}</p>{/if}
      {/if}
      <div class="apply">
        <button type="button" class="btn kc" disabled={!check || check.words.length === 0 || pastedApplied} onclick={applyPaste}>
          {pastedApplied ? 'In use' : check && check.words.length ? `Use these ${fmtInt(check.words.length)} words` : 'Use these words'}
        </button>
        {#if check && (check.unknown.length || check.malformed.length) && check.words.length}
          <span class="note">Words not in the guess list are left out.</span>
        {/if}
      </div>
    </div>
  {/if}
  <p class="now">In use: {answerSummary(current)}</p>
</div>

<style>
  .answers {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    cursor: pointer;
  }
  .opt input {
    width: 20px;
    height: 20px;
    margin: 0;
    accent-color: var(--accent);
  }
  .opt.disabled {
    opacity: 0.5;
    cursor: default;
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: 0 0 8px 30px;
  }
  .sub input[type='range'] {
    flex: 1 1 180px;
    min-height: 44px;
    accent-color: var(--accent);
  }
  .num {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .num input {
    width: 6.5em;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 6em;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 0.9rem;
    text-transform: uppercase;
    resize: vertical;
  }
  .note,
  .now,
  .warn {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
    flex-basis: 100%;
  }
  .warn {
    color: var(--fg);
  }
  .now {
    margin-top: 4px;
  }
  .apply {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .apply .note {
    flex-basis: auto;
  }
</style>
