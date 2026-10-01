<script lang="ts">
  // The Tree view minimap: when the tree overflows the screen, its silhouette
  // in the lower right with a draggable viewport rectangle. The silhouette is
  // redrawn only when the tree layer bumps its version; the rectangle is a DOM
  // element, so panning costs no canvas work.
  import { treeControls } from '../../scene/tree/controls';
  import { silhouette, treeUi } from '../../scene/tree/ui.svelte';

  const MAX_W = 168;
  const MAX_H = 112;

  const m = $derived(treeUi.minimap);
  const shown = $derived(m.show && treeUi.active && treeUi.alpha > 0.02);

  // Map world → minimap px (y up in the world, down on screen).
  const geo = $derived.by(() => {
    const ww = Math.max(1, m.maxX - m.minX);
    const wh = Math.max(1, m.top - m.bottom);
    const k = Math.min(MAX_W / ww, MAX_H / wh);
    return { k, w: Math.max(24, Math.round(ww * k)), h: Math.max(24, Math.round(wh * k)) };
  });

  const rect = $derived.by(() => {
    const { k, w, h } = geo;
    let x0 = (m.vx0 - m.minX) * k;
    let x1 = (m.vx1 - m.minX) * k;
    let y0 = (m.top - m.vy1) * k;
    let y1 = (m.top - m.vy0) * k;
    x0 = Math.max(0, Math.min(w, x0));
    x1 = Math.max(0, Math.min(w, x1));
    y0 = Math.max(0, Math.min(h, y0));
    y1 = Math.max(0, Math.min(h, y1));
    return { x: x0, y: y0, w: Math.max(4, x1 - x0), h: Math.max(4, y1 - y0) };
  });

  // Centre of the view as a share of the tree (for assistive technology).
  const pos = $derived.by(() => {
    const cx = (m.vx0 + m.vx1) / 2;
    const cy = (m.vy0 + m.vy1) / 2;
    const fx = (cx - m.minX) / Math.max(1, m.maxX - m.minX);
    const fy = (m.top - cy) / Math.max(1, m.top - m.bottom);
    return { x: Math.round(Math.max(0, Math.min(1, fx)) * 100), y: Math.round(Math.max(0, Math.min(1, fy)) * 100) };
  });

  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    void m.version;
    const c = canvas;
    const { k, w, h } = geo;
    if (!c || !shown) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(c);
    g.strokeStyle = css.getPropertyValue('--muted').trim() || '#888';
    g.lineCap = 'round';
    const s = silhouette.segs;
    for (let i = 0; i < silhouette.n; i++) {
      const x0 = (s[i * 5] - m.minX) * k;
      const y0 = (m.top - s[i * 5 + 1]) * k;
      const x1 = (s[i * 5 + 2] - m.minX) * k;
      const y1 = (m.top - s[i * 5 + 3]) * k;
      g.lineWidth = Math.max(0.6, Math.min(6, s[i * 5 + 4] * k));
      g.globalAlpha = 0.55;
      g.beginPath();
      g.moveTo(x0, y0);
      g.bezierCurveTo(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2, x1, y1);
      g.stroke();
    }
  });

  let dragging = $state(false);
  let grab = { dx: 0, dy: 0 };

  function worldAt(e: PointerEvent, el: HTMLElement): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    const { k } = geo;
    return { x: m.minX + (e.clientX - r.left) / k, y: m.top - (e.clientY - r.top) / k };
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const w = worldAt(e, el);
    const cx = (m.vx0 + m.vx1) / 2;
    const cy = (m.vy0 + m.vy1) / 2;
    const inside = w.x >= m.vx0 && w.x <= m.vx1 && w.y >= m.vy0 && w.y <= m.vy1;
    // Grabbing the rectangle keeps the grab point under the pointer; elsewhere it jumps there.
    grab = inside ? { dx: cx - w.x, dy: cy - w.y } : { dx: 0, dy: 0 };
    dragging = true;
    treeControls.panTo(w.x + grab.dx, w.y + grab.dy, !inside);
    e.preventDefault();
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return;
    const w = worldAt(e, e.currentTarget as HTMLElement);
    treeControls.panTo(w.x + grab.dx, w.y + grab.dy, false);
  }
  function onUp() {
    dragging = false;
  }

  function onKey(e: KeyboardEvent) {
    const cx = (m.vx0 + m.vx1) / 2;
    const cy = (m.vy0 + m.vy1) / 2;
    const sx = (m.vx1 - m.vx0) * 0.25;
    const sy = (m.vy1 - m.vy0) * 0.25;
    let x = cx;
    let y = cy;
    if (e.key === 'ArrowLeft') x -= sx;
    else if (e.key === 'ArrowRight') x += sx;
    else if (e.key === 'ArrowUp') y += sy;
    else if (e.key === 'ArrowDown') y -= sy;
    else return;
    e.preventDefault();
    e.stopPropagation();
    treeControls.panTo(x, y, true);
  }
</script>

{#if shown}
  <div
    class="minimap"
    class:dragging
    style:right="{m.right}px"
    style:bottom="{m.bottom_px}px"
    style:width="{geo.w}px"
    style:height="{geo.h}px"
    style:opacity={treeUi.alpha}
    role="slider"
    tabindex="0"
    aria-label="Tree overview: drag or use the arrow keys to pan"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={pos.x}
    aria-valuetext="Viewing {pos.x}% across and {pos.y}% down the tree"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
    onkeydown={onKey}
  >
    <canvas bind:this={canvas} style:width="{geo.w}px" style:height="{geo.h}px" aria-hidden="true"></canvas>
    <div class="view" style:left="{rect.x}px" style:top="{rect.y}px" style:width="{rect.w}px" style:height="{rect.h}px"></div>
  </div>
{/if}

<style>
  .minimap {
    position: absolute;
    z-index: 8;
    box-sizing: content-box;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--bg) 90%, transparent);
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.08);
    cursor: pointer;
    touch-action: none;
    user-select: none;
  }
  .minimap:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  canvas {
    display: block;
  }
  .view {
    position: absolute;
    margin: 6px;
    box-sizing: border-box;
    border: 2px solid var(--accent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    cursor: grab;
  }
  .dragging .view {
    cursor: grabbing;
  }
</style>
