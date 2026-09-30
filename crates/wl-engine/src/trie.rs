//! Target trees: the prefix trie of every game against one target.
//!
//! Node ids are assigned in insertion order: games are inserted one after
//! another, and each game creates the nodes it lacks from the root down. The
//! root is node 0 (depth 0, no guess). Player games add flagged nodes that
//! carry no mass.

use wl_core::{AnswerIdx, WordId};

use crate::game::Game;

#[derive(Clone, Debug, PartialEq)]
pub struct TrieNode {
    pub id: u32,
    pub parent: Option<u32>,
    /// Guess number of this node's guess; the root is 0.
    pub depth: u8,
    /// This node's guess (`None` for the root).
    pub guess: Option<WordId>,
    /// Feedback code of the guess against the target.
    pub pattern: u16,
    /// Strategy games passing through.
    pub mass: u32,
    /// Strategy games ending here solved / unsolved.
    pub end_solved: u32,
    pub end_failed: u32,
    /// Whether any game (strategy or player) ends here.
    pub terminal: bool,
    /// Whether a player path passes through.
    pub player: bool,
    pub children: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct TargetTrie {
    pub target: AnswerIdx,
    pub nodes: Vec<TrieNode>,
}

impl TargetTrie {
    pub fn new(target: AnswerIdx) -> TargetTrie {
        let root = TrieNode {
            id: 0,
            parent: None,
            depth: 0,
            guess: None,
            pattern: 0,
            mass: 0,
            end_solved: 0,
            end_failed: 0,
            terminal: false,
            player: false,
            children: Vec::new(),
        };
        TargetTrie { target, nodes: vec![root] }
    }

    /// Build from games (those for other targets are skipped), in the given order.
    pub fn from_games<'a>(target: AnswerIdx, games: impl IntoIterator<Item = &'a Game>) -> TargetTrie {
        let mut t = TargetTrie::new(target);
        for g in games {
            if g.target == target {
                t.insert(g);
            }
        }
        t
    }

    /// Strategy games in the tree.
    pub fn total_mass(&self) -> u32 {
        self.nodes[0].mass
    }

    /// Insert one game; returns its leaf node id.
    pub fn insert(&mut self, game: &Game) -> u32 {
        debug_assert_eq!(game.target, self.target);
        let strategy = !game.is_player;
        let mut cur = 0u32;
        self.mark(cur, strategy);
        for (i, turn) in game.turns.iter().enumerate() {
            let found = self.nodes[cur as usize]
                .children
                .iter()
                .copied()
                .find(|&c| self.nodes[c as usize].guess == Some(turn.guess));
            cur = match found {
                Some(c) => c,
                None => {
                    let id = self.nodes.len() as u32;
                    self.nodes.push(TrieNode {
                        id,
                        parent: Some(cur),
                        depth: (i + 1) as u8,
                        guess: Some(turn.guess),
                        pattern: turn.pattern,
                        mass: 0,
                        end_solved: 0,
                        end_failed: 0,
                        terminal: false,
                        player: false,
                        children: Vec::new(),
                    });
                    self.nodes[cur as usize].children.push(id);
                    id
                }
            };
            self.mark(cur, strategy);
        }
        let leaf = &mut self.nodes[cur as usize];
        leaf.terminal = true;
        if strategy {
            if game.solved {
                leaf.end_solved += 1;
            } else {
                leaf.end_failed += 1;
            }
        }
        cur
    }

    fn mark(&mut self, node: u32, strategy: bool) {
        let n = &mut self.nodes[node as usize];
        if strategy {
            n.mass += 1;
        } else {
            n.player = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Turn;

    fn game(guesses: &[u16], solved: bool, is_player: bool) -> Game {
        let turns = guesses
            .iter()
            .map(|&g| Turn {
                guess: g,
                pattern: 0,
                cands_before: 1,
                cands_after: 1,
                p_chosen: 1.0,
                bits_expected: 0.0,
                phase: 0,
                is_candidate: true,
            })
            .collect();
        Game { target: 7, replicate: 0, turns, solved, is_player }
    }

    #[test]
    fn ids_follow_insertion() {
        let games = [game(&[1, 2, 7], true, false), game(&[1, 3, 7], true, false), game(&[1, 2, 7], true, false), game(&[4, 7], true, true)];
        let t = TargetTrie::from_games(7, &games);
        let guesses: Vec<Option<u16>> = t.nodes.iter().map(|n| n.guess).collect();
        assert_eq!(guesses, vec![None, Some(1), Some(2), Some(7), Some(3), Some(7), Some(4), Some(7)]);
        assert_eq!(t.total_mass(), 3);
        assert_eq!(t.nodes[1].mass, 3);
        assert_eq!(t.nodes[3].mass, 2);
        assert_eq!(t.nodes[3].end_solved, 2);
        assert!(t.nodes[7].player && t.nodes[7].terminal && t.nodes[7].mass == 0);
        assert_eq!(t.nodes[5].parent, Some(4));
        assert_eq!(t.nodes[5].depth, 3);
    }
}
