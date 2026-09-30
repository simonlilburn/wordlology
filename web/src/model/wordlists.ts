// Loading word lists on the main thread. Owned by the platform agent.
import type { AnswerSelection } from '../backend/types';
import type { WordData } from './types';

export async function loadWordData(id: string, selection: AnswerSelection = { kind: 'default' }): Promise<WordData> {
  throw new Error('not implemented');
}
