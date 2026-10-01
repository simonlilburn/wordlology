<script lang="ts">
  // Help: the keyboard shortcuts and a short explanation of the four levels.
  import { app, LEVEL_NAMES } from '../../app/store.svelte';
  import { listShortcuts } from '../../app/keyboard';
  import Dialog from './Dialog.svelte';
  import { extraShortcuts, LEVELS, SPEC_SHORTCUTS, type HelpRow } from './help';

  // Registered shortcuts are read each time the dialog opens (they are not reactive).
  const extra = $derived.by((): HelpRow[] => {
    if (!app.ui.help) return [];
    try {
      return extraShortcuts(listShortcuts());
    } catch {
      return [];
    }
  });

  function close() {
    app.ui.help = false;
  }

  function about() {
    app.ui.help = false;
    app.ui.about = true;
  }
</script>

{#snippet table(rows: HelpRow[], caption: string)}
  <table>
    <caption class="visually-hidden">{caption}</caption>
    <thead>
      <tr><th scope="col">Key</th><th scope="col">Action</th></tr>
    </thead>
    <tbody>
      {#each rows as r, i (i)}
        <tr>
          <td class="keys">
            {#each r.keys as k, j (j)}{#if j > 0}<span class="sep" aria-hidden="true"> </span>{/if}<kbd>{k}</kbd>{/each}
          </td>
          <td>
            {r.action}{#if r.where}<span class="where">{r.where}</span>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<Dialog open={app.ui.help} title="Help" subtitle="Keyboard shortcuts and the four levels" onclose={close} initialFocus="close">
  <section aria-labelledby="help-levels">
    <h3 id="help-levels">Four levels, one space</h3>
    <p class="intro">
      wordlology starts as a word-guessing game and zooms out one aggregation at a time. Pinch or scroll to move between levels, or use the
      level buttons, <kbd>−</kbd> and <kbd>=</kbd>. Any path at a higher level opens back on the board as a replay.
    </p>
    <ol class="levels">
      {#each LEVELS as l (l.n)}
        <li>
          <span class="lvl" aria-hidden="true">{l.n}</span>
          <div>
            <strong>{LEVEL_NAMES[l.n] ?? l.name}</strong>
            <p>{l.text}</p>
          </div>
        </li>
      {/each}
    </ol>
  </section>

  <section aria-labelledby="help-keys">
    <h3 id="help-keys">Keyboard</h3>
    <p class="intro">Every action has a key. Letter shortcuts work outside the Game view, where letters type guesses.</p>
    {@render table(SPEC_SHORTCUTS, 'Keyboard shortcuts')}
    {#if extra.length}
      <h4>More shortcuts</h4>
      {@render table(extra, 'More keyboard shortcuts')}
    {/if}
  </section>

  <section aria-labelledby="help-board">
    <h3 id="help-board">Reading the board</h3>
    <ul class="marks">
      <li><span class="swatch correct" aria-hidden="true"><span class="dot"></span></span> The letter is in the word, in this spot. A filled dot marks it.</li>
      <li><span class="swatch present" aria-hidden="true"><span class="ring"></span></span> The letter is in the word, in another spot. A ring marks it.</li>
      <li><span class="swatch absent" aria-hidden="true"></span> The letter is not in the word (or not as many times).</li>
    </ul>
  </section>

  {#snippet footer()}
    <button type="button" class="btn kc" onclick={about}>About wordlology</button>
    <span class="spacer"></span>
    <button type="button" class="btn kc primary" onclick={close}>Done</button>
  {/snippet}
</Dialog>

<style>
  section + section {
    margin-top: 18px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 1rem;
  }
  h4 {
    margin: 14px 0 4px;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .intro {
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .levels {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .levels li {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .levels p {
    margin: 2px 0 0;
    font-size: 0.9rem;
    line-height: 1.4;
  }
  .lvl {
    flex: none;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--line);
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th {
    text-align: left;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 4px 8px 6px 0;
    border-bottom: 1px solid var(--line);
  }
  td {
    padding: 7px 8px 7px 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  .keys {
    white-space: nowrap;
    width: 1%;
    padding-right: 16px;
  }
  kbd {
    display: inline-block;
    min-width: 1.6em;
    padding: 1px 6px;
    border: 1px solid var(--line);
    border-bottom-width: 2px;
    border-radius: 5px;
    background: var(--panel);
    font-family: var(--font-sans);
    font-size: 0.82rem;
    font-weight: 650;
    text-align: center;
  }
  .sep {
    display: inline-block;
    width: 4px;
  }
  .where {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .where::before {
    content: ' · ';
    white-space: pre;
  }
  .marks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
    font-size: 0.9rem;
  }
  .marks li {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .swatch {
    position: relative;
    flex: none;
    width: 28px;
    height: 28px;
    border-radius: 3px;
    color: var(--tile-text);
  }
  .swatch.correct {
    background: var(--correct);
  }
  .swatch.present {
    background: var(--present);
  }
  .swatch.absent {
    background: var(--absent);
  }
  .dot,
  .ring {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 7px;
    height: 7px;
    box-sizing: border-box;
    border-radius: 50%;
  }
  .dot {
    background: currentColor;
  }
  .ring {
    border: 1.5px solid currentColor;
  }
  .spacer {
    flex: 1;
  }
  .btn {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
    font-weight: 600;
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
