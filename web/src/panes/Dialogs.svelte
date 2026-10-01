<script lang="ts">
  // The app's modal dialogs. Settings, help and about are owned here (game
  // agent); target search and the opener picker belong to the panes agent and
  // the export dialog to the platform agent: this file only mounts them while
  // their flag in app.ui is set.
  import { app } from '../app/store.svelte';
  import SettingsDialog from './dialogs/SettingsDialog.svelte';
  import HelpDialog from './dialogs/HelpDialog.svelte';
  import AboutDialog from './dialogs/AboutDialog.svelte';
  import TargetSearch from './TargetSearch.svelte';
  import OpenerPicker from './OpenerPicker.svelte';
  import ExportDialog from '../export/ExportDialog.svelte';
</script>

<SettingsDialog />
<HelpDialog />
<AboutDialog />

{#if app.ui.search}<TargetSearch />{/if}
{#if app.ui.openerPicker}<OpenerPicker />{/if}
{#if app.ui.exportDialog}<ExportDialog />{/if}
