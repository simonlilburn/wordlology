<script lang="ts">
  // About: what wordlology is, and the credits and licences of the word list
  // (from its manifest and NOTICE, which must ship beside the files).
  import { app } from '../../app/store.svelte';
  import { DEFAULT_LIST_ID, fetchNotice } from '../../model/wordlists';
  import Dialog from './Dialog.svelte';

  const manifest = $derived(app.words?.manifest ?? null);
  const listId = $derived(manifest?.id ?? DEFAULT_LIST_ID);
  const nf = new Intl.NumberFormat('en');

  let notice = $state<string | null>(null);
  let noticeState = $state<'idle' | 'loading' | 'error'>('idle');
  let noticeFor = '';

  $effect(() => {
    if (!app.ui.about) return;
    const id = listId;
    if (noticeFor === id && notice) return;
    noticeFor = id;
    noticeState = 'loading';
    let live = true;
    fetchNotice(id)
      .then((text) => {
        if (!live) return;
        notice = text;
        noticeState = text ? 'idle' : 'error';
      })
      .catch(() => {
        if (live) noticeState = 'error';
      });
    return () => {
      live = false;
    };
  });

  function close() {
    app.ui.about = false;
  }
</script>

<Dialog open={app.ui.about} title="About wordlology" onclose={close} initialFocus="close">
  <section class="what">
    <p class="lead">
      <strong>wordlology</strong> opens as a five-letter word-guessing game and zooms out, one aggregation at a time, into the statistics of
      guessing strategies.
    </p>
    <p>
      A single game becomes a <em>tree</em> of every game a strategy plays against the same word, then a <em>card</em> of how many guesses it
      needs across every word, then an <em>atlas</em> comparing strategies and openers. Every aggregate can be clicked back down to a single
      playable game.
    </p>
    <p>
      Everything is computed in your browser by a solver written in Rust and compiled to WebAssembly; nothing is sent to a server. Every table
      can be exported as tidy CSV for R or any other tool.
    </p>
    {#if app.catalogue.solverVersion}<p class="muted small">Solver version {app.catalogue.solverVersion}</p>{/if}
  </section>

  <section aria-labelledby="about-words">
    <h3 id="about-words">Word list</h3>
    {#if manifest}
      <p>
        <strong>{manifest.name}</strong>, version {manifest.version}{#if manifest.counts?.guesses}: {nf.format(manifest.counts.guesses)} allowed
          guesses{/if}{#if app.words}, {nf.format(app.words.answers.length)} possible answers{/if}.
      </p>
      {#if manifest.credits?.length}
        <ul class="credits">
          {#each manifest.credits as c, i (i)}<li>{c}</li>{/each}
        </ul>
      {/if}
      {#if manifest.licence}<p class="muted small">{manifest.licence}</p>{/if}
    {:else}
      <p class="muted">The word list is still loading.</p>
    {/if}
  </section>

  <section aria-labelledby="about-credits">
    <h3 id="about-credits">Credits and licences</h3>
    <ul class="credits">
      <li>
        <strong>ENABLE</strong> (Enhanced North American Benchmark LExicon), the source of the allowed guesses, is in the public domain. It was
        compiled by Alan Beale and M. Cooper, with contributions from many word-game players.
      </li>
      <li>
        <strong>wordfreq</strong> 3.1.1 by Robyn Speer, the source of the word frequencies and answer lists, is licensed under
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>; the derived
        files are shared under the same licence. wordfreq's data is a snapshot through about 2021 and will not be updated.
      </li>
      <li>
        wordfreq's English data includes <strong>SUBTLEX</strong> word frequencies by Marc Brysbaert, Emmanuel Keuleers, Boris New and
        colleagues, and data from the other sources credited in
        <a href="https://github.com/rspeer/wordfreq#citations" target="_blank" rel="noopener noreferrer">wordfreq's README</a>.
      </li>
      <li>Built with Svelte, three.js and fflate (MIT licences).</li>
    </ul>
  </section>

  <section aria-labelledby="about-notice">
    <h3 id="about-notice">NOTICE</h3>
    {#if notice}
      <!-- A scrollable region must be reachable by keyboard. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre class="notice" tabindex="0" aria-label="NOTICE file of the word list">{notice}</pre>
    {:else if noticeState === 'loading'}
      <p class="muted">Loading the word list's NOTICE…</p>
    {:else}
      <p class="muted">
        The NOTICE file could not be loaded here. It ships beside the word list at
        <a href="wordlists/{listId}/NOTICE" target="_blank" rel="noopener noreferrer">wordlists/{listId}/NOTICE</a>.
      </p>
    {/if}
  </section>

  {#snippet footer()}
    <span class="spacer"></span>
    <button type="button" class="btn primary" onclick={close}>Done</button>
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
  p {
    margin: 0 0 8px;
    line-height: 1.5;
    font-size: 0.92rem;
  }
  .lead {
    font-size: 1rem;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.8rem;
  }
  .credits {
    margin: 0 0 8px;
    padding-left: 1.2em;
    display: grid;
    gap: 6px;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  a {
    color: var(--accent);
  }
  .notice {
    margin: 0;
    max-height: 16rem;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    line-height: 1.45;
    white-space: pre-wrap;
  }
  .notice:focus-visible,
  a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .spacer {
    flex: 1;
  }
  .btn {
    min-height: 44px;
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    cursor: pointer;
    font-weight: 600;
  }
  .btn.primary {
    background: var(--fg);
    border-color: var(--fg);
    color: var(--bg);
  }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
