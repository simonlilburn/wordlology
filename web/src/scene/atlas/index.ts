// Atlas layer: owned by the card/atlas agent.
import type { SceneLayer } from '../types';

export function createAtlasLayer(): SceneLayer {
  return { name: 'atlas', update: () => false, dispose() {} };
}
