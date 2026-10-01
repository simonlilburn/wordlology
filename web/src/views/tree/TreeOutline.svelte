<script lang="ts">
  // The Tree view's DOM overlays (zoom controls, Skip, tooltip, minimap) and
  // its text alternative: a navigable outline of the nodes with their game
  // counts, as a WAI-ARIA tree. The outline follows the focused tree: the
  // selected path is expanded, Enter selects a node (it becomes the trunk and
  // the view pans to it), Shift+Enter plays it on the board.
  import { tick } from 'svelte';
  import { selectNode } from '../../app/actions';
  import { app } from '../../app/store.svelte';
  import { compileFilter, matchesNode } from '../../model/filter';
  import { focusData } from '../../model/focus';
  import type { TrieNode } from '../../model/types';
  import { playNode, treeControls } from '../../scene/tree/controls';
  import { treeUi } from '../../scene/tree/ui.svelte';
  import Minimap from './Minimap.svelte';
  import { flattenOutline, outlineKey, type OutlineRow } from './outline';
  import PathTooltip from './PathTooltip.svelte';
  import { cells, fmtInt, fmtProb, nodeLabel, pathNodes } from './pathinfo';
  import TreeControls from './TreeControls.svelte';

  let open = $state(false);
  $effect(() => {
    treeUi.outlineOpen = open;
  });
  let expanded = $state(new Set<number>());
  let focusIndex = $state(0);
  let listEl: HTMLElement | undefined = $state();
  let treeKey = '';

  const vp = $derived(treeUi.viewport);

  function childrenOf(n: TrieNode): readonly TrieNode[] {
    const tree = focusData.tree;
    if (!tree) return [];
    return tree.sortedChildren(n).filter((c) => c.mass > 0 || c.player);
  }

  // A new tree (target or configuration): expand the path to the selection.
  $effect(() => {
    void treeUi.version;
    const tree = focusData.tree;
    const key = tree ? `${tree.target}|${focusData.version}` : '';
    const sel = app.focus.node;
    if (!tree) return;
    if (key !== treeKey) {
      treeKey = key;
      expanded = new Set();
      focusIndex = 0;
    }
    if (sel >= 0 && sel < tree.nodes.length) {
      const path = pathNodes(tree.nodes[sel]);
      let changed = false;
      const next = new Set(expanded);
      for (const n of path.slice(0, -1)) {
        if (!next.has(n.id)) {
          next.add(n.id);
          changed = true;
        }
      }
      if (changed) expanded = next;
    }
  });

  const filter = $derived(app.words && app.filter ? compileFilter(app.filter, app.words.wordLength, app.display.yIsVowel) : null);

  const rows = $derived.by((): OutlineRow[] => {
    void treeUi.version;
    void focusData.version;
    const tree = focusData.tree;
    if (!open || !tree) return [];
    return flattenOutline(tree.root, expanded, childrenOf, 3000);
  });

  const solvedCode = $derived(app.words ? Math.pow(3, app.words.wordLength) - 1 : -1);

  function label(r: OutlineRow): string {
    const words = app.words;
    const tree = focusData.tree;
    if (!words || !tree) return '';
    const n = r.node;
    const word = words.guesses[n.guess] ?? '?';
    let match = false;
    if (filter) {
      try {
        match = matchesNode(filter, word, n.depth, n.pattern === solvedCode);
      } catch {
        match = false;
      }
    }
    return nodeLabel(n, word, tree.totalMass, app.result.maxGuesses, words.wordLength, match);
  }

  async function focusRow(i: number) {
    focusIndex = Math.max(0, Math.min(rows.length - 1, i));
    await tick();
    listEl?.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`)?.focus();
  }

  function onKey(e: KeyboardEvent, i: number) {
    const res = outlineKey(rows, i, e.key, e.shiftKey);
    if (!res) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    switch (res.kind) {
      case 'focus':
        void focusRow(res.index);
        break;
      case 'expand': {
        const next = new Set(expanded);
        next.add(res.id);
        expanded = next;
        break;
      }
      case 'collapse': {
        const next = new Set(expanded);
        next.delete(res.id);
        expanded = next;
        void focusRow(res.index);
        break;
      }
      case 'select':
        choose(res.id);
        break;
      case 'play':
        playNode(res.id);
        break;
    }
  }

  function choose(id: number) {
    selectNode(id);
    treeControls.reveal(id);
  }

  function toggle(r: OutlineRow, i: number) {
    focusIndex = i;
    if (!r.expandable) return;
    const next = new Set(expanded);
    if (next.has(r.node.id)) next.delete(r.node.id);
    else next.add(r.node.id);
    expanded = next;
  }

  async function openOutline() {
    open = true;
    await tick();
    const sel = app.focus.node;
    const i = rows.findIndex((r) => r.node.id === sel);
    void focusRow(i >= 0 ? i : 0);
  }
  function close() {
    open = false;
    void tick().then(() => document.querySelector<HTMLElement>('[aria-controls="tree-outline"]')?.focus());
  }

  const heading = $derived(`${fmtInt(treeUi.games)} game${treeUi.games === 1 ? '' : 's'} against ${treeUi.target}`);
</script>

<TreeControls onOutline={() => (open ? close() : openOutline())} />
<PathTooltip />
<Minimap />

{#if open && treeUi.alpha > 0.02}
  <section
    id="tree-outline"
    class="outline"
    style:left="{vp.left + 12}px"
    style:top="{vp.top + 12}px"
    style:max-height="{Math.max(160, vp.height - 84)}px"
    style:opacity={treeUi.alpha}
    inert={!treeUi.active}
    aria-label="Tree outline"
  >
    <header>
      <h2>{heading}</h2>
      <button type="button" class="close" onclick={close} aria-label="Close the outline">×</button>
    </header>
    {#if treeUi.deterministic}
      <p class="note">Deterministic strategy: one game per target.</p>
    {/if}
    <ul role="tree" aria-label={heading} bind:this={listEl}>
      {#each rows as r, i (r.node.id)}
        {@const word = (app.words?.guesses[r.node.guess] ?? '?').toUpperCase()}
        <li
          role="treeitem"
          data-index={i}
          tabindex={i === focusIndex ? 0 : -1}
          aria-level={r.level}
          aria-setsize={r.setsize}
          aria-posinset={r.posinset}
          aria-expanded={r.expandable ? r.expanded : undefined}
          aria-selected={r.node.id === app.focus.node}
          aria-label={label(r)}
          class:selected={r.node.id === app.focus.node}
          style:padding-left="{8 + (r.level - 1) * 14}px"
          onkeydown={(e) => onKey(e, i)}
          onclick={() => toggle(r, i)}
          ondblclick={() => choose(r.node.id)}
        >
          <span class="twisty" aria-hidden="true">{r.expandable ? (r.expanded ? '▾' : '▸') : ''}</span>
          <span class="word" class:player={r.node.player && r.node.mass === 0}>{word}</span>
          <span class="strip" aria-hidden="true">
            {#each cells(r.node.pattern, [...word].length) as c, j (j)}<span class="cell c{c}"></span>{/each}
          </span>
          <span class="games">{r.node.mass > 0 ? `${fmtInt(r.node.mass)} · ${fmtProb(treeUi.games > 0 ? r.node.mass / treeUi.games : 0)}` : 'you'}</span>
        </li>
      {/each}
    </ul>
    <p class="hint">↑↓ move · → open · ← close · Enter select · Shift+Enter play</p>
  </section>
{/if}

<style>
  .close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .outline {
    position: absolute;
    z-index: 9;
    width: min(340px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg);
    color: var(--fg);
    box-shadow: 0 6px 22px rgb(0 0 0 / 0.14);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 6px 6px 12px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0;
    font-size: 0.85rem;
  }
  .close {
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--fg);
    font-size: 1.2rem;
    cursor: pointer;
  }
  .note,
  .hint {
    margin: 0;
    padding: 6px 12px;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .hint {
    border-top: 1px solid var(--line);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding-right: 10px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  li:hover {
    background: var(--panel);
  }
  li.selected {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  li:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .twisty {
    width: 1em;
    color: var(--muted);
  }
  .word {
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .word.player {
    text-decoration: underline dotted;
  }
  .strip {
    display: inline-flex;
    gap: 1px;
  }
  .cell {
    width: 7px;
    height: 7px;
    border-radius: 1.5px;
    background: var(--absent);
  }
  .cell.c1 {
    background: var(--present);
  }
  .cell.c2 {
    background: var(--correct);
  }
  .games {
    margin-left: auto;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
