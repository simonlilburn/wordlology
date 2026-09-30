<script lang="ts">
  // Layout shell. Each area owns its component; this file only places them.
  import SceneCanvas from './scene/SceneCanvas.svelte';
  import GameView from './views/game/GameView.svelte';
  import SidePane from './panes/SidePane.svelte';
  import TargetBrowser from './panes/TargetBrowser.svelte';
  import TreeOutline from './views/tree/TreeOutline.svelte';
  import CardOverlay from './views/card/CardOverlay.svelte';
  import AtlasOverlay from './views/atlas/AtlasOverlay.svelte';
  import StrategyLab from './lab/StrategyLab.svelte';
  import Dialogs from './panes/Dialogs.svelte';
  import Toasts from './app/Toasts.svelte';
  import { app } from './app/store.svelte';
</script>

<div class="shell" class:high-contrast={app.display.palette === 'high-contrast'} class:reduced-motion={app.reducedMotion}>
  <SceneCanvas />
  <GameView />
  <TargetBrowser />
  <TreeOutline />
  <CardOverlay />
  <AtlasOverlay />
  <SidePane />
  <StrategyLab />
  <Dialogs />
  <Toasts />
</div>

<style>
  .shell {
    position: fixed;
    inset: 0;
    overflow: hidden;
  }
</style>
