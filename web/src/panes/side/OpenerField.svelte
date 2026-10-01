<script lang="ts">
  // Opener: a text field validated against the guess list, "strategy's choice", and recent openers.
  import { setOpener } from '../../app/actions';
  import { app } from '../../app/store.svelte';
  import { openerProblem } from '../opener';
  import { openOpenerPicker } from '../state.svelte';

  let { inputEl = $bindable(null) }: { inputEl?: HTMLInputElement | null } = $props();

  let text = $state('');
  const len = $derived(app.words?.wordLength ?? 5);
  const word = $derived(text.trim().toLowerCase());

  /** Validation message, or '' when the word is playable (or nothing is typed). */
  const problem = $derived.by(() => {
    const index = app.words?.index;
    return openerProblem(text, len, index ? (w) => index.has(w) : null);
  });
  const valid = $derived(!!word && !problem);

  function apply(w: string | null) {
    try {
      setOpener(w);
    } catch {
      // Platform not ready.
    }
    text = '';
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (valid) apply(word);
  }
</script>

<div class="opener">
  <p class="current">
    Current: <strong>{app.focus.opener ? app.focus.opener.toUpperCase() : "strategy's choice"}</strong>
  </p>
  <form onsubmit={submit} class="row">
    <label class="visually-hidden" for="opener-input">Opener word</label>
    <input
      id="opener-input"
      bind:this={inputEl}
      bind:value={text}
      class:bad={!!problem && word.length >= len}
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      maxlength={len + 2}
      placeholder={'e.g. ' + 'crane'.slice(0, len).toUpperCase()}
      aria-invalid={!!problem && word.length >= len}
      aria-describedby="opener-msg"
    />
    <button type="submit" disabled={!valid}>Set</button>
  </form>
  <p id="opener-msg" class="msg" aria-live="polite">{problem}</p>
  <div class="chips" role="group" aria-label="Recent openers">
    <button type="button" class="chip" class:on={app.focus.opener === null} aria-pressed={app.focus.opener === null} onclick={() => apply(null)}>
      Strategy's choice
    </button>
    {#each app.focus.recentOpeners.slice(0, 6) as w (w)}
      <button type="button" class="chip mono" class:on={app.focus.opener === w} aria-pressed={app.focus.opener === w} onclick={() => apply(w)}>
        {w.toUpperCase()}
      </button>
    {/each}
    <button type="button" class="chip more" onclick={() => openOpenerPicker('focus')}>More…</button>
  </div>
</div>

<style>
  .current {
    margin: 0 0 6px;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .current strong {
    color: var(--fg);
    font-family: var(--font-mono);
  }
  .row {
    display: flex;
    gap: 6px;
  }
  input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: 600 1rem var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  input.bad {
    border-color: #d64545;
  }
  input:focus-visible,
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 1px;
  }
  button {
    min-height: 44px;
    min-width: 44px;
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
  .msg {
    min-height: 1.2em;
    margin: 4px 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    border-radius: 999px;
    font-size: 0.85rem;
  }
  .chip.mono {
    font-family: var(--font-mono);
  }
  .chip.on {
    border-color: var(--fg);
    font-weight: 600;
  }
  .chip.more {
    color: var(--accent);
  }
</style>
