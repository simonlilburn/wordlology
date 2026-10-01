<script lang="ts">
  // Rankings opener set: the answer list, all allowed guesses, the top N by
  // one-step information, or a pasted list validated against the guess list.
  import { app, type ResultSettings } from '../../app/store.svelte';
  import { checkPastedWords, fmtInt, listSome, pastedMessage } from './settings';

  let { labelledby, onchanged }: { labelledby: string; onchanged: () => void } = $props();

  type OpenerSet = ResultSettings['rankOpenerSet'];
  const name = `openers-${Math.random().toString(36).slice(2, 8)}`;
  const initial = app.result.rankOpenerSet;
  let mode = $state<OpenerSet['kind']>(initial.kind);
  let topN = $state(initial.kind === 'top_info' ? initial.n : 100);
  let pasteText = $state(initial.kind === 'pasted' ? initial.words.join(' ') : '');

  const maxN = $derived(app.words?.guesses.length ?? 10000);
  const lexicon = $derived(app.words ? { wordLength: app.words.wordLength, index: app.words.index } : null);
  const check = $derived(lexicon && pasteText.trim() ? checkPastedWords(pasteText, lexicon) : null);
  const current = $derived(app.result.rankOpenerSet);
  const pastedApplied = $derived(
    current.kind === 'pasted' && !!check && check.words.length === current.words.length && check.words.every((w, i) => w === current.words[i]),
  );

  function commit(next: OpenerSet) {
    if (JSON.stringify(next) === JSON.stringify(app.result.rankOpenerSet)) return;
    app.result.rankOpenerSet = next;
    onchanged();
  }

  function choose(m: OpenerSet['kind']) {
    mode = m;
    if (m === 'answers') commit({ kind: 'answers' });
    else if (m === 'allowed') commit({ kind: 'allowed' });
    else if (m === 'top_info') commitTop();
  }

  function commitTop() {
    const n = Number.isFinite(topN) ? Math.round(topN) : 100;
    topN = Math.max(1, Math.min(maxN, n));
    commit({ kind: 'top_info', n: topN });
  }

  function applyPaste() {
    if (!check || check.words.length === 0) return;
    commit({ kind: 'pasted', words: [...check.words] });
  }
</script>

<div class="set" role="radiogroup" aria-labelledby={labelledby}>
  <label class="opt">
    <input type="radio" {name} checked={mode === 'answers'} onchange={() => choose('answers')} />
    <span>The answer list</span>
  </label>
  <label class="opt">
    <input type="radio" {name} checked={mode === 'allowed'} onchange={() => choose('allowed')} />
    <span>All allowed guesses</span>
  </label>
  <label class="opt">
    <input type="radio" {name} checked={mode === 'top_info'} onchange={() => choose('top_info')} />
    <span>Top N by information</span>
  </label>
  {#if mode === 'top_info'}
    <div class="sub">
      <label class="num">
        <span>N =</span>
        <input type="number" inputmode="numeric" min="1" max={maxN} step="1" bind:value={topN} onchange={commitTop} />
      </label>
      <span class="note">openers with the highest one-step expected information</span>
    </div>
  {/if}
  <label class="opt">
    <input type="radio" {name} checked={mode === 'pasted'} onchange={() => choose('pasted')} />
    <span>A pasted list</span>
  </label>
  {#if mode === 'pasted'}
    <div class="sub">
      <label class="visually-hidden" for="{name}-paste">Openers to rank</label>
      <textarea
        id="{name}-paste"
        rows="3"
        bind:value={pasteText}
        placeholder="Paste openers separated by spaces, commas or new lines"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
      ></textarea>
      {#if lexicon && check}
        <p class="note" aria-live="polite">{pastedMessage(check, lexicon.wordLength)}.</p>
        {#if check.unknown.length}<p class="warn">Not in the guess list: {listSome(check.unknown)}</p>{/if}
        {#if check.malformed.length}<p class="warn">Not {lexicon.wordLength}-letter words: {listSome(check.malformed)}</p>{/if}
      {/if}
      <button type="button" class="btn" disabled={!check || check.words.length === 0 || pastedApplied} onclick={applyPaste}>
        {pastedApplied ? 'In use' : check && check.words.length ? `Use these ${fmtInt(check.words.length)} openers` : 'Use these openers'}
      </button>
    </div>
  {/if}
</div>

<style>
  .set {
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
  .sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: 0 0 8px 30px;
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
  .warn {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .warn {
    color: var(--fg);
    flex-basis: 100%;
  }
  .sub > .note[aria-live] {
    flex-basis: 100%;
  }
</style>
