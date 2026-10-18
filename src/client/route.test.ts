/**
 * T1-3: URL のハッシュとレポートのパスの対応の単体テスト
 */
import { describe, expect, it } from 'vitest';
import { parseReportHash, reportHash } from './route.js';

describe('route', () => {
  it('S1-2: reportHash と parseReportHash は往復で元に戻る', () => {
    for (const path of ['reports/a.md', 'reports/日本語 の.md', 'reports/a&b=c#d.md', 'a/../b']) {
      expect(parseReportHash(reportHash(path))).toBe(path);
    }
  });

  it('S1-2: ハッシュには、ファイル名がそのまま含まれる(リンクを識別できる)', () => {
    expect(reportHash('reports/2026-08-03-gfm.md')).toContain('2026-08-03-gfm.md');
  });

  it('S1-2: 形が合わないハッシュ、空、不正なエスケープは null(画面を壊さない)', () => {
    expect(parseReportHash('')).toBeNull();
    expect(parseReportHash('#')).toBeNull();
    expect(parseReportHash('#/other/x')).toBeNull();
    expect(parseReportHash('#/report/')).toBeNull();
    expect(parseReportHash('#/report/%E3')).toBeNull();
  });
});
