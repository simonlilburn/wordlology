<script lang="ts">
  // Lists the answers still consistent with the board after a row (from the
  // annotation column's candidate count).
  import { app } from '../../app/store.svelte';
  import { feedback } from '../../model/feedback';
  import Dialog from '../../panes/dialogs/Dialog.svelte';
  import { consistentAnswers, fmtCount } from './candidates';
  import { attempt } from './services';
  import { answerWord, boardRows, view } from './state.svelte';

  const open = $derived(view.listRow >= 0);
  const row = $derived(view.listRow);
  const rows = $derived(boardRows());
  const words = $derived.by(() => {
    if (row < 0 || !app.words) return null;
    const answers = app.words.answers.map((id) => app.words!.guesses[id]);
    return attempt<string[] | null>(() => consistentAnswers(answers, rows.slice(0, row + 1), feedback), null);
  });
  const target = $derived(answerWord(app.replay.target));
  const guess = $derived(rows[row]?.word.toUpperCase() ?? '');

  let query = $state('');
  const shown = $derived(words ? (query ? words.filter((w) => w.includes(query.toLowerCase())) : words) : []);
</script>

<Dialog
  {open}
  size="sm"
  title="{words ? fmtCount(words.length) : '…'} remaining {words?.length === 1 ? 'word' : 'words'}"
  subtitle="Answers consistent with the board after guess {row + 1} ({guess})"
  onclose={() => {
    view.listRow = -1;
    query = '';
  }}
>
  {#if !words}
    <p>The candidate list is not available yet.</p>
  {:else}
    {#if words.length > 24}
      <label class="search">
        <span class="visually-hidden">Filter the list</span>
        <input type="search" placeholder="Filter…" bind:value={query} autocomplete="off" spellcheck="false" />
      </label>
    {/if}
    <ul class="words">
      {#each shown as w (w)}
        <li class:target={w === target}>
          {w}{#if w === target}<span class="visually-hidden"> (the target)</span>{/if}
        </li>
      {/each}
    </ul>
    {#if shown.length === 0}<p class="muted">No words match.</p>{/if}
  {/if}
</Dialog>

<style>
  .search input {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    padding: 8px 12px;
    margin-bottom: 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
  .words {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr));
    gap: 4px 10px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    font-size: 0.95rem;
  }
  li {
    padding: 2px 0;
  }
  li.target {
    font-weight: 800;
    color: var(--correct);
  }
  .muted {
    color: var(--muted);
  }
</style>
