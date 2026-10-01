// Wake the scene when store fields it reads change. The scene still reads the
// store itself on each animation frame; these effects only schedule a frame
// (render on demand), so Svelte updates never do scene work.

import { untrack } from 'svelte';
import { app } from '../../app/store.svelte';
import { paneState } from '../../panes/state.svelte';

export function watchStore(wake: () => void): () => void {
  return $effect.root(() => {
    // Hot fields (every animation frame of a zoom) get their own cheap effect.
    $effect(() => {
      void app.z;
      void app.zTarget;
      void app.zDragging;
      untrack(wake);
    });
    $effect(() => {
      void app.focus.target;
      void app.focus.node;
      void app.focus.hoverNode;
      void app.focus.opener;
      void app.focus.strategy?.id;
      void JSON.stringify(app.focus.strategy?.spec ?? null);
      void app.reducedMotion;
      void app.words;
      void app.arrived;
      void app.solverReady;
      untrack(wake);
    });
    $effect(() => {
      void JSON.stringify(app.display);
      void JSON.stringify(app.result);
      void JSON.stringify(app.filter);
      untrack(wake);
    });
    $effect(() => {
      void app.game.history.length;
      void app.game.board?.status;
      void app.game.board?.guesses.length;
      void app.replay.active;
      void app.replay.guesses.length;
      void app.replay.cursor;
      untrack(wake);
    });
    $effect(() => {
      void JSON.stringify(app.atlas);
      void app.ui.compare;
      void app.ui.paneOpen;
      untrack(wake);
    });
    $effect(() => {
      void paneState.occluded.top;
      void paneState.occluded.right;
      void paneState.occluded.bottom;
      void paneState.revealRequest;
      void paneState.phone;
      untrack(wake);
    });
  });
}
