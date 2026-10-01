<script lang="ts">
  // The board: <div data-board> with rows [data-row="i"] of tiles [data-tile].
  // The Game → Tree transition measures these elements, so the markup inside
  // data-board holds only rows and tiles; annotations sit in a sibling column.
  import { app } from '../../app/store.svelte';
  import { CELL_NAMES, decodePattern, tileLabel, type Cell } from './logic';
  import { FLIP_MS, FLIP_STAGGER_MS, boardRows, inReplay, inputRow, maxGuesses, view, wordLength } from './state.svelte';
  import Annotations from './Annotations.svelte';

  type TileState = 'empty' | 'typed' | 'absent' | 'present' | 'correct';
  interface TileView {
    letter: string;
    cell: Cell | null;
    state: TileState;
  }
  interface RowView {
    key: string;
    tiles: TileView[];
    dim: boolean;
    label: string;
    kind: 'played' | 'input' | 'empty';
  }

  const len = $derived(wordLength());
  const rows = $derived(boardRows());
  const inRow = $derived(inputRow());
  const replay = $derived(inReplay());
  const cursor = $derived(replay ? app.replay.cursor : Number.POSITIVE_INFINITY);
  const nRows = $derived(Math.max(maxGuesses(), rows.length, inRow + 1));
  const marks = $derived(app.display.colourBlindMarks);
  const annotated = $derived(replay && app.display.replayAnnotations && rows.length > 0);

  const rowViews = $derived.by((): RowView[] => {
    const out: RowView[] = [];
    const input = app.game.input;
    for (let i = 0; i < nRows; i++) {
      let tiles: TileView[];
      let kind: RowView['kind'];
      if (i === inRow && (input.length > 0 || i >= rows.length)) {
        kind = 'input';
        tiles = Array.from({ length: len }, (_, j) => {
          const letter = input[j] ?? '';
          return { letter, cell: null, state: letter ? 'typed' : 'empty' };
        });
      } else if (i < rows.length) {
        kind = 'played';
        const r = rows[i];
        const cells = decodePattern(r.pattern, len);
        tiles = Array.from({ length: len }, (_, j) => ({ letter: r.word[j] ?? '', cell: cells[j], state: CELL_NAMES[cells[j]] }));
      } else {
        kind = 'empty';
        tiles = Array.from({ length: len }, () => ({ letter: '', cell: null, state: 'empty' as const }));
      }
      const dim = replay && i >= cursor && kind === 'played';
      const word = tiles.map((t) => t.letter).join('').toUpperCase();
      const label =
        kind === 'played'
          ? `Guess ${i + 1}${dim ? ' (after the replay cursor)' : ''}: ${tiles.map((t) => tileLabel(t.letter, t.cell)).join('; ')}`
          : kind === 'input'
            ? `Guess ${i + 1}, typing: ${word || 'empty'}`
            : `Guess ${i + 1}, empty`;
      // Changing a row's key re-creates it, which restarts its flip or shake animation.
      const key = `${i}|${i === view.revealRow ? view.revealKey : ''}|${i === view.shakeRow ? view.shakeKey : ''}`;
      out.push({ key, tiles, dim, label, kind });
    }
    return out;
  });
</script>

<div
  class="wrap"
  class:annotated
  style="--cols: {len}; --rows: {nRows}; --stagger: {FLIP_STAGGER_MS}ms; --flip: {FLIP_MS}ms"
>
  <div class="board" data-board role="group" aria-label="Board: {nRows} rows of {len} letters">
    {#each rowViews as row, i (row.key)}
      <div
        class="row"
        class:dim={row.dim}
        class:shake={i === view.shakeRow}
        class:cursor-row={replay && i === cursor}
        data-row={i}
        role="group"
        aria-label={row.label}
      >
        {#each row.tiles as t, j (j)}
          <div
            class="tile {t.state}"
            class:reveal={i === view.revealRow && t.cell !== null}
            class:marks
            data-tile
            data-letter={t.letter}
            data-state={t.state}
            style="--i: {j}"
            role="img"
            aria-label={tileLabel(t.letter, t.cell)}
          >
            <span class="letter" aria-hidden="true">{t.letter}</span>
            {#if marks && t.cell !== null && t.cell > 0}<span class="mark" aria-hidden="true"></span>{/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
  {#if annotated}
    <Annotations rows={nRows} />
  {/if}
</div>

<style>
  .wrap {
    --gap: 5px;
    --annot: 0px;
    /* Tile size: fits the board area's width (with the annotation column) and height;
       --area-w / --area-h are the measured area, with viewport fallbacks. */
    --tile: max(
      24px,
      min(
        62px,
        calc((min(var(--area-w, 100vw), 600px) - 26px - var(--annot)) / var(--cols) - var(--gap)),
        calc((var(--area-h, 55dvh) - 16px + var(--gap)) / var(--rows) - var(--gap))
      )
    );
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: 10px;
  }
  .wrap.annotated {
    --annot: 8.6rem;
  }
  .board {
    display: grid;
    grid-template-rows: repeat(var(--rows), var(--tile));
    gap: var(--gap);
    perspective: 600px;
  }
  .row {
    display: grid;
    grid-template-columns: repeat(var(--cols), var(--tile));
    gap: var(--gap);
    transition: opacity 180ms ease;
  }
  .row.dim {
    opacity: 0.32;
  }
  .row.shake {
    animation: shake 600ms ease;
  }

  .tile {
    --c: transparent;
    position: relative;
    box-sizing: border-box;
    width: var(--tile);
    height: var(--tile);
    display: grid;
    place-items: center;
    border: 2px solid var(--line);
    background: transparent;
    border-radius: 4px;
    color: var(--fg);
    font-family: var(--font-display);
    font-stretch: 90%;
    font-weight: 800;
    font-size: calc(var(--tile) * 0.54);
    line-height: 1;
    text-transform: uppercase;
    user-select: none;
  }
  .tile.typed {
    border-color: var(--muted);
    animation: pop 100ms ease-out;
  }
  .tile.absent {
    --c: var(--absent);
  }
  .tile.present {
    --c: var(--present);
  }
  .tile.correct {
    --c: var(--correct);
  }
  .tile.absent,
  .tile.present,
  .tile.correct {
    background: var(--c);
    border-color: var(--c);
    color: var(--tile-text);
    /* A stamped tile: slightly darker lower edge. */
    box-shadow: inset 0 -3px 0 rgb(0 0 0 / 0.16);
  }
  .letter {
    text-shadow: 0 1px 1px rgb(0 0 0 / 0.12);
  }
  .tile.typed .letter {
    text-shadow: none;
  }

  /* Colour-blind marks: a filled dot for correct, a hollow ring for present. */
  .mark {
    position: absolute;
    top: 9%;
    right: 9%;
    width: max(6px, 17%);
    aspect-ratio: 1;
    box-sizing: border-box;
    border-radius: 50%;
  }
  .correct .mark {
    background: currentColor;
  }
  .present .mark {
    border: max(1.5px, calc(var(--tile) * 0.035)) solid currentColor;
  }

  /* Flip: the tile turns edge-on, takes its colour, and turns back. */
  .tile.reveal {
    animation: flip var(--flip) ease-in-out both;
    animation-delay: calc(var(--i) * var(--stagger));
  }
  .tile.reveal .mark {
    animation: mark-in 0s linear both;
    animation-delay: calc(var(--i) * var(--stagger) + var(--flip) / 2);
  }
  @keyframes flip {
    0% {
      transform: rotateX(0deg);
      background: transparent;
      border-color: var(--muted);
      color: var(--fg);
    }
    50% {
      transform: rotateX(-90deg);
      background: transparent;
      border-color: var(--muted);
      color: var(--fg);
    }
    50.01% {
      background: var(--c);
      border-color: var(--c);
      color: var(--tile-text);
    }
    100% {
      transform: rotateX(0deg);
      background: var(--c);
      border-color: var(--c);
      color: var(--tile-text);
    }
  }
  @keyframes mark-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes pop {
    50% {
      transform: scale(1.08);
    }
  }
  @keyframes shake {
    10%,
    90% {
      transform: translateX(-2px);
    }
    20%,
    80% {
      transform: translateX(4px);
    }
    30%,
    50%,
    70% {
      transform: translateX(-6px);
    }
    40%,
    60% {
      transform: translateX(6px);
    }
  }
  :global(.reduced-motion) .tile,
  :global(.reduced-motion) .row,
  :global(.reduced-motion) .mark {
    animation: none !important;
    transition: none !important;
  }
  :global(.reduced-motion) .row.shake .tile {
    border-color: var(--accent);
  }
</style>
