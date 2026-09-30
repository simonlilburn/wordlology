// The level zoom value z (0 Game, 1 Tree, 2 Card, 3 Atlas). Owned by the platform agent.
// Input handlers call zoomBy during a gesture and endZoomGesture on release;
// z then snaps to the nearest level with ±0.15 hysteresis.

/** Move z continuously by dz (positive = zoom out) during a pinch/scroll gesture. */
export function zoomBy(dz: number): void {}
/** Gesture ended: snap to a level. */
export function endZoomGesture(): void {}
/** Animate z to a level. */
export function animateTo(level: number): void {}
