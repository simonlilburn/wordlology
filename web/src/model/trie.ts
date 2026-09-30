// Target trie: the prefix trie of every game against one target. Owned by the platform agent.
import type { Game } from '../backend/types';
import type { TargetTree, TrieNode } from './types';

export class TargetTrie implements TargetTree {
  root!: TrieNode;
  nodes: TrieNode[] = [];
  games: Game[] = [];
  totalMass = 0;
  version = 0;
  constructor(public target: number, public maxGuesses: number) {}
  ingest(games: Game[]): void {}
  addPlayer(game: Game): TrieNode {
    throw new Error('not implemented');
  }
  pathTo(node: TrieNode): TrieNode[] {
    return [];
  }
  sortedChildren(node: TrieNode): TrieNode[] {
    return node.children;
  }
}
