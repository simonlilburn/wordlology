// Card layer: owned by the card/atlas agent.
import type { SceneLayer } from '../types';

export function createCardLayer(): SceneLayer {
  return { name: 'card', update: () => false, dispose() {} };
}
