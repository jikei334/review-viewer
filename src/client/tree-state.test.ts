/**
 * T1-4: ツリーの展開状態の単体テスト
 */
import { describe, expect, it } from 'vitest';
import { toggleExpanded } from './tree-state.js';

describe('toggleExpanded', () => {
  it('S1-8: 閉じているディレクトリを開く。元の集合は変えない', () => {
    const before = new Set(['a']);
    const after = toggleExpanded(before, 'b');
    expect([...after].sort()).toEqual(['a', 'b']);
    expect([...before]).toEqual(['a']);
  });
  it('S1-8: 開いているディレクトリを閉じる', () => {
    expect([...toggleExpanded(new Set(['a', 'b']), 'a')]).toEqual(['b']);
  });
});
