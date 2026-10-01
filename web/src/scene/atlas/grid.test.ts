import { describe, expect, it } from 'vitest';
import { gridWithFocus } from './grid';

const A = { id: 'a' }, B = { id: 'b' }, C = { id: 'c' };

describe('gridWithFocus', () => {
  it('leaves a grid that already holds the focus alone', () => {
    const g = gridWithFocus([A, B], ['crane', 'stare'], B, 'stare');
    expect(g.changed).toBe(false);
    expect(g.columns).toEqual([A, B]);
    expect(g.rows).toEqual(['crane', 'stare']);
  });

  it('seeds an empty grid from the focus', () => {
    const g = gridWithFocus([], [], A, null);
    expect(g).toEqual({ columns: [A], rows: [null], changed: true });
  });

  it('a lone card follows the focus instead of growing into a grid', () => {
    const g = gridWithFocus([A], ['crane'], B, 'stare');
    expect(g.columns).toEqual([B]);
    expect(g.rows).toEqual(['stare']);
    expect(g.changed).toBe(true);
  });

  it('an axis with several entries gains the new one', () => {
    const g = gridWithFocus([A, B], ['crane'], C, 'crane');
    expect(g.columns).toEqual([A, B, C]);
    expect(g.rows).toEqual(['crane']);
    const h = gridWithFocus([A], ['crane', 'slate'], A, null);
    expect(h.columns).toEqual([A]);
    expect(h.rows).toEqual(['crane', 'slate', null]);
  });

  it('does not mutate its inputs', () => {
    const cols = [A];
    const rows = ['crane'];
    gridWithFocus(cols, rows, B, 'stare');
    expect(cols).toEqual([A]);
    expect(rows).toEqual(['crane']);
  });
});
