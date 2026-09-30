// Run manager: shared runs keyed by config ID and scope. Owned by the platform agent.
import type { RunManager } from './types';

export const runs: RunManager = {
  request() {
    throw new Error('not implemented');
  },
  get() {
    return undefined;
  },
  async configId() {
    throw new Error('not implemented');
  },
};
