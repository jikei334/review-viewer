/**
 * T1-2: ReviewService の単体テスト(S1-1、および S1-4 / S1-5 が業務ロジック越しにも守られること)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTempRepo, type TempRepo } from './__fixtures__/temp-repo.js';
import { RepoAccessError } from './path-policy.js';
import { RepoReader, type RepoEntry } from './RepoReader.js';
import {
  compareReportsNewestFirst,
  compareTreeEntries,
  isReportFile,
  REPORTS_DIR,
  ReviewService,
} from './ReviewService.js';

/** コメントを使わないテスト用の、ReviewStore の代わり(呼ばれたら失敗する) */
const unusedStore = {
  list: vi.fn(() => {
    throw new Error('store.list は呼ばれない想定');
  }),
  add: vi.fn(() => Promise.reject(new Error('store.add は呼ばれない想定'))),
  updateStatus: vi.fn(() => Promise.reject(new Error('store.updateStatus は呼ばれない想定'))),
  addReply: vi.fn(() => Promise.reject(new Error('store.addReply は呼ばれない想定'))),
};

/**
 * 一覧の1件を作る
 *
 * @param name 名前
 * @param mtime 更新日時(ISO 8601)
 * @param type 種類
 * @returns 一覧の1件
 */
function entry(name: string, mtime: string, type: RepoEntry['type'] = 'file'): RepoEntry {
  return { name, path: `${REPORTS_DIR}/${name}`, type, size: 1, mtimeMs: Date.parse(mtime) };
}

describe('S1-1: compareReportsNewestFirst(新しい順)', () => {
  it('S1-1: 更新日時の降順に並ぶ(ファイル名の順ではない)', () => {
    const sorted = [
      entry('b-oldest.md', '2026-08-01T00:00:00Z'),
      entry('a-newest.md', '2026-10-12T00:00:00Z'),
      entry('c-middle.md', '2026-09-01T00:00:00Z'),
    ].sort(compareReportsNewestFirst);
    expect(sorted.map((e) => e.name)).toEqual(['a-newest.md', 'c-middle.md', 'b-oldest.md']);
  });

  it('S1-1: 更新日時が同じなら、ファイル名の降順', () => {
    const same = '2026-10-12T00:00:00Z';
    const sorted = [
      entry('2026-10-11-a.md', same),
      entry('2026-10-12-b.md', same),
      entry('2026-10-12-a.md', same),
    ].sort(compareReportsNewestFirst);
    expect(sorted.map((e) => e.name)).toEqual(['2026-10-12-b.md', '2026-10-12-a.md', '2026-10-11-a.md']);
  });

  it('S1-1: 同じものを比べると 0', () => {
    const one = entry('a.md', '2026-10-12T00:00:00Z');
    expect(compareReportsNewestFirst(one, { ...one })).toBe(0);
  });
});

describe('S1-1: isReportFile(reports/*.md)', () => {
  it.each(['a.md', '2026-10-12-feature.md', '.md'])('S1-1: %j はレポート', (name) => {
    expect(isReportFile({ name, type: 'file' })).toBe(true);
  });

  it.each(['a.txt', 'a.md.bak', 'a.markdown', 'md', 'A.MD'])('S1-1: %j はレポートではない', (name) => {
    expect(isReportFile({ name, type: 'file' })).toBe(false);
  });

  it('S1-1: 名前が .md で終わるディレクトリは、レポートではない', () => {
    expect(isReportFile({ name: 'archive.md', type: 'directory' })).toBe(false);
  });
});

describe('T1-2: compareTreeEntries', () => {
  it('T1-2: ディレクトリが先、その中は名前の昇順', () => {
    const sorted = [
      entry('b.ts', '2026-01-01T00:00:00Z'),
      entry('z-dir', '2026-01-01T00:00:00Z', 'directory'),
      entry('a.ts', '2026-01-01T00:00:00Z'),
      entry('a-dir', '2026-01-01T00:00:00Z', 'directory'),
    ].sort(compareTreeEntries);
    expect(sorted.map((e) => e.name)).toEqual(['a-dir', 'z-dir', 'a.ts', 'b.ts']);
  });
});

describe('T1-2: ReviewService(RepoReader を差し替えて確かめる)', () => {
  it('S1-1: listReports は、reports/ の一覧だけを RepoReader に求める', async () => {
    const listDirectory = vi.fn(() =>
      Promise.resolve({ path: REPORTS_DIR, entries: [entry('a.md', '2026-10-12T00:00:00.000Z')] })
    );
    const service = new ReviewService({ store: unusedStore, repoReader: { listDirectory, readFile: vi.fn() } });
    expect(await service.listReports()).toEqual([
      { name: 'a.md', path: 'reports/a.md', modifiedAt: '2026-10-12T00:00:00.000Z' },
    ]);
    expect(listDirectory.mock.calls).toEqual([['reports']]);
  });

  it('S1-1: reports/ が無い(または拒否対象)なら、空の一覧を返す', async () => {
    const service = new ReviewService({
      store: unusedStore,
      repoReader: {
        listDirectory: () => Promise.reject(new RepoAccessError('not_found', 'missing')),
        readFile: vi.fn(),
      },
    });
    expect(await service.listReports()).toEqual([]);
  });

  it('S1-1: それ以外のエラーは、握りつぶさずに伝える', async () => {
    const service = new ReviewService({
      store: unusedStore,
      repoReader: { listDirectory: () => Promise.reject(new Error('disk failure')), readFile: vi.fn() },
    });
    await expect(service.listReports()).rejects.toThrow('disk failure');
  });
});

describe('T1-2: ReviewService(フィクスチャのリポジトリで確かめる)', () => {
  let repo: TempRepo;
  let service: ReviewService;

  beforeAll(async () => {
    repo = await createTempRepo();
    service = new ReviewService({ store: unusedStore, repoReader: new RepoReader({ repoDir: repo.repoDir }) });

    // 更新日時を、ファイル名の順とは逆にしておく(どちらで並べているかを区別できるようにする)
    const reports: Array<[name: string, mtime: string]> = [
      ['reports/2026-01-01-named-oldest.md', '2026-10-12T00:00:00Z'],
      ['reports/2026-06-01-named-middle.md', '2026-09-01T00:00:00Z'],
      ['reports/2026-12-01-named-newest.md', '2026-08-01T00:00:00Z'],
      ['reports/same-time-a.md', '2026-07-01T00:00:00Z'],
      ['reports/same-time-b.md', '2026-07-01T00:00:00Z'],
    ];
    for (const [path, mtime] of reports) {
      await repo.write(path, `# ${path}\n`);
      await repo.setMtime(path, new Date(mtime));
    }
    // reports/*.md に当てはまらないもの
    await repo.write('reports/notes.txt', 'Markdown ではない\n');
    await repo.write('reports/archive/2025-old.md', '# サブディレクトリの中\n');
    await repo.write('outside-reports.md', '# reports/ の外\n');
    await repo.write('reports/dir-named.md/inner.txt', 'ディレクトリ\n');
    // 拒否対象
    await repo.write('.gitignore', 'reports/ignored-report.md\n*.log\n');
    await repo.write('reports/ignored-report.md', '# .gitignore の対象\n');
    await repo.write('reports/credentials.md', '# 秘密ファイルに見える名前(ダミー)\n');
    const outside = await repo.writeOutside('outside.md', '# リポジトリの外\n');
    await repo.link(outside, 'reports/link-outside.md');
    // リポジトリの中のファイルを指すリンクは、レポートとして載る
    await repo.write('docs/real.md', '# 実体\n');
    await repo.setMtime('docs/real.md', new Date('2026-06-01T00:00:00Z'));
    await repo.link('../docs/real.md', 'reports/link-inside.md');

    await repo.write('src/example.ts', 'export const a = 1;\n');
    await repo.write('zeta.txt', 'z\n');
    await repo.write('.env', 'DUMMY=UNIT_DUMMY_SECRET_NOT_A_REAL_SECRET\n');
    await repo.write('debug.log', 'ignored\n');
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it('S1-1: listReports は、reports/ の直下の .md を、更新日時の新しい順に返す(拒否対象は出さない)', async () => {
    expect(await service.listReports()).toEqual([
      { name: '2026-01-01-named-oldest.md', path: 'reports/2026-01-01-named-oldest.md', modifiedAt: '2026-10-12T00:00:00.000Z' },
      { name: '2026-06-01-named-middle.md', path: 'reports/2026-06-01-named-middle.md', modifiedAt: '2026-09-01T00:00:00.000Z' },
      { name: '2026-12-01-named-newest.md', path: 'reports/2026-12-01-named-newest.md', modifiedAt: '2026-08-01T00:00:00.000Z' },
      { name: 'same-time-b.md', path: 'reports/same-time-b.md', modifiedAt: '2026-07-01T00:00:00.000Z' },
      { name: 'same-time-a.md', path: 'reports/same-time-a.md', modifiedAt: '2026-07-01T00:00:00.000Z' },
      { name: 'link-inside.md', path: 'reports/link-inside.md', modifiedAt: '2026-06-01T00:00:00.000Z' },
    ]);
  });

  it('S1-1: reports/ が無いリポジトリでは、空の一覧を返す', async () => {
    const empty = await createTempRepo();
    try {
      const emptyService = new ReviewService({ store: unusedStore, repoReader: new RepoReader({ repoDir: empty.repoDir }) });
      expect(await emptyService.listReports()).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  });

  it('S1-1: reports/ がリポジトリの外を指すリンクなら、空の一覧を返す(外の .md を出さない)', async () => {
    const other = await createTempRepo();
    try {
      await other.writeOutside('reports/outside-report.md', '# 外\n');
      await other.link('../outside/reports', 'reports');
      const otherService = new ReviewService({ store: unusedStore, repoReader: new RepoReader({ repoDir: other.repoDir }) });
      expect(await otherService.listReports()).toEqual([]);
    } finally {
      await other.cleanup();
    }
  });

  it('T1-2: listTree は、path が空ならルートの一覧を返す(ディレクトリが先。拒否対象は出さない)', async () => {
    expect(await service.listTree('')).toEqual({
      path: '',
      entries: [
        { name: 'docs', path: 'docs', type: 'directory' },
        { name: 'reports', path: 'reports', type: 'directory' },
        { name: 'src', path: 'src', type: 'directory' },
        { name: '.gitignore', path: '.gitignore', type: 'file' },
        { name: 'outside-reports.md', path: 'outside-reports.md', type: 'file' },
        { name: 'zeta.txt', path: 'zeta.txt', type: 'file' },
      ],
    });
  });

  it('T1-2: listTree は、サブディレクトリの一覧を返す(1階層だけ)', async () => {
    expect(await service.listTree('src')).toEqual({
      path: 'src',
      entries: [{ name: 'example.ts', path: 'src/example.ts', type: 'file' }],
    });
  });

  it('S1-4 / S1-5: listTree と getFile は、RepoReader と同じ規則で拒否する', async () => {
    await expect(service.listTree('..')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(service.getFile('../outside/outside.md')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(service.getFile('.env')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.getFile('debug.log')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.getFile('reports/link-outside.md')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('T1-2: getFile は、ファイルの内容を返す', async () => {
    expect(await service.getFile('src/example.ts')).toEqual({
      path: 'src/example.ts',
      size: 20,
      kind: 'text',
      content: 'export const a = 1;\n',
    });
  });
});
