/**
 * T1-3: URL のハッシュとレポートのパスの対応の単体テスト
 */
import { describe, expect, it } from 'vitest';
import { buildRoute, parseReportHash, parseRoute, reportHash } from './route.js';

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

describe('parseRoute / buildRoute', () => {
  it('S1-8: レポートとソース(行つき)が往復で元に戻る', () => {
    const route = { report: 'reports/a b.md', source: { path: 'src/x&y?.ts', line: 42 } };
    expect(parseRoute(buildRoute(route))).toEqual(route);
  });
  it('S1-8: ソースだけ、レポートだけでも往復できる', () => {
    expect(parseRoute(buildRoute({ report: null, source: { path: 'a.ts', line: null } }))).toEqual({
      report: null,
      source: { path: 'a.ts', line: null },
    });
    expect(parseRoute(buildRoute({ report: 'r.md', source: null }))).toEqual({ report: 'r.md', source: null });
  });
  it('S1-8: 不正な行番号(0、負、数字以外)は null、空のハッシュは何も開かない', () => {
    for (const line of ['0', '-1', 'x', '1.5', '']) {
      expect(parseRoute(`#/?src=a.ts&line=${line}`).source).toEqual({ path: 'a.ts', line: null });
    }
    expect(parseRoute('')).toEqual({ report: null, source: null });
  });
});
