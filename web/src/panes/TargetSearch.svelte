<script lang="ts">
  // Owned by the panes agent: target search dialog (/). Mounted by Dialogs.svelte;
  // renders only while app.ui.search is true.
  // Type a word, or pick from the list sorted by guesses (hardest first, from
  // the focused card run); choosing jumps to that target's Tree view.
  import { onMount } from 'svelte';
  import { focusTarget, setLevel } from '../app/actions';
  import { app } from '../app/store.svelte';
  import { sortTargets } from './browser/stats';
  import { allTargets, syncTargets, targetIndex, targets } from './browser/targets.svelte';
  import { live, startLive } from './live.svelte';
  import { answerWord } from './services';
  import Modal from './ui/Modal.svelte';
  import { fmtNum, fmtPct } from './util';

  onMount(startLive);

  let query = $state('');
  let active = $state(0);
  let listEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void live.card;
    if (app.ui.search) syncTargets();
  });

  /** The player's unsolved target is left out of the list (it would give the answer away). */
  const spoiler = $derived(app.game.board && app.game.board.status === 'playing' ? app.game.board.target : -1);
  const hasStats = $derived(targets.version >= 0 && targetIndex.byTarget.size > 0);
  const ranked = $derived.by(() => {
    void targets.version;
    void app.words;
    return sortTargets(allTargets(), targetIndex.byTarget, hasStats ? 'mean' : 'alpha');
  });
  const q = $derived(query.trim().toLowerCase());

  const results = $derived.by(() => {
    const prefix: number[] = [];
    const inner: number[] = [];
    for (const t of ranked) {
      if (t === spoiler) continue;
      const w = answerWord(t);
      if (!q || w.startsWith(q)) prefix.push(t);
      else if (q.length > 1 && w.includes(q)) inner.push(t);
      if (prefix.length >= 150) break;
    }
    return [...prefix, ...inner].slice(0, 150);
  });

  const exact = $derived.by(() => {
    const w = app.words;
    if (!w || !q) return -1;
    const id = w.index.get(q);
    return id === undefined ? -1 : w.answerOf[id];
  });

  const message = $derived.by(() => {
    const w = app.words;
    if (!w || !q) return '';
    if (q.length === w.wordLength && exact < 0) return w.index.has(q) ? `${q.toUpperCase()} is a valid guess but not in the answer list.` : `${q.toUpperCase()} is not in the word list.`;
    if (!results.length) return 'No answers match.';
    return '';
  });

  $effect(() => {
    void q;
    active = 0;
  });

  function close() {
    app.ui.search = false;
    query = '';
  }

  function choose(t: number) {
    if (t < 0) return;
    try {
      focusTarget(t);
      setLevel(1);
    } catch {
      // Platform not ready.
    }
    close();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      active = Math.min(results.length - 1, active + 1);
    } else if (e.key === 'ArrowUp') {
      active = Math.max(0, active - 1);
    } else if (e.key === 'Enter') {
      choose(exact >= 0 ? exact : (results[active] ?? -1));
    } else return;
    e.preventDefault();
    listEl?.querySelector(`#search-opt-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }
</script>

{#if app.ui.search}
  <Modal title="Find a target" onclose={close} width={440}>
    <label class="visually-hidden" for="target-search-input">Target word</label>
    <input
      id="target-search-input"
      data-autofocus
      bind:value={query}
      onkeydown={onKey}
      role="combobox"
      aria-expanded={results.length > 0}
      aria-controls="target-search-list"
      aria-activedescendant={results.length ? `search-opt-${active}` : undefined}
      aria-autocomplete="list"
      aria-describedby="target-search-msg"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      placeholder="Type a word"
    />
    <p id="target-search-msg" class="msg" aria-live="polite">
      {message || (hasStats ? 'Sorted by mean guesses, hardest first.' : 'Alphabetical (difficulty appears as the card computes).')}
    </p>
    <ul id="target-search-list" role="listbox" aria-label="Targets" bind:this={listEl}>
      {#each results as t, i (t)}
        {@const s = targetIndex.byTarget.get(t)}
        <li
          id="search-opt-{i}"
          role="option"
          aria-selected={i === active}
          class:active={i === active}
          onpointerenter={() => (active = i)}
          onclick={() => choose(t)}
          onkeydown={(e) => e.key === 'Enter' && choose(t)}
        >
          <span class="word">{answerWord(t).toUpperCase()}</span>
          {#if s}
            <span class="stat">{fmtNum(s.mean)} guesses</span>
            <span class="stat fail">{s.failRate > 0 ? fmtPct(s.failRate, 0) + ' failed' : ''}</span>
          {/if}
        </li>
      {/each}
    </ul>
  </Modal>
{/if}

<style>
  input {
    width: 100%;
    box-sizing: border-box;
    min-height: 48px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg);
    color: var(--fg);
    font: 600 1.15rem var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  input:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
  .msg {
    margin: 6px 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }
  li {
    display: grid;
    grid-template-columns: 1fr auto 5.5em;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 0 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  li.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .word {
    font: 700 0.95rem var(--font-mono);
    letter-spacing: 0.08em;
  }
  .stat {
    font-size: 0.8rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
</style>
