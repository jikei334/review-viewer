/**
 * 画面の本体: レポート一覧と、レポートの表示
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchReports, type ReportSummary } from './api.js';
import { buildRoute, parseRoute, type ViewRoute } from './route.js';
import { SourceTree } from './SourceTree.js';
import { SourceView } from './SourceView.js';
import { ReportView } from './ReportView.js';

/** 一覧の取得状態 */
type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly reports: readonly ReportSummary[] };

/**
 * URL のハッシュを監視して、画面の状態(開くレポートとソース)を返す
 *
 * @returns 画面の状態
 */
function useRoute(): ViewRoute {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = (): void => {
      setHash(window.location.hash);
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return useMemo(() => parseRoute(hash), [hash]);
}

/**
 * 画面全体
 *
 * @returns 左にレポート一覧、右にレポート本文
 */
export function App() {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const route = useRoute();
  const selected = route.report;

  useEffect(() => {
    let cancelled = false;
    fetchReports().then(
      (reports) => {
        if (!cancelled) setList({ status: 'ready', reports });
      },
      (err: unknown) => {
        console.error('Review Viewer: レポート一覧を取得できませんでした', err);
        if (!cancelled) setList({ status: 'error' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="レポート一覧">
        <h1>Review Viewer</h1>
        <div data-testid="report-list">
          {list.status === 'loading' && <p className="status">読み込み中…</p>}
          {list.status === 'error' && (
            <p className="status error" role="alert">
              レポート一覧を取得できませんでした
            </p>
          )}
          {list.status === 'ready' && list.reports.length === 0 && (
            <p className="status">レポートがありません</p>
          )}
          {list.status === 'ready' && list.reports.length > 0 && (
            <ul>
              {list.reports.map((report) => (
                <li key={report.path}>
                  {/* 名前はテキストとして出す(ファイル名に HTML があっても、タグにならない) */}
                  <a
                    href={buildRoute({ report: report.path, source: route.source })}
                    aria-current={report.path === selected ? 'page' : undefined}
                  >
                    {report.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <h2 className="sidebar-heading">ソース</h2>
        <SourceTree
          selectedPath={route.source?.path ?? null}
          onSelectFile={(path) => {
            window.location.hash = buildRoute({ report: route.report, source: { path, line: null } });
          }}
        />
      </nav>
      <main className={route.source === null ? 'content' : 'content split'}>
        <div className="pane report-pane">
          {selected === null ? (
            <p className="status">左の一覧からレポートを選んでください</p>
          ) : (
            <ReportView path={selected} />
          )}
        </div>
        {route.source !== null && (
          <div className="pane source-pane">
            <SourceView path={route.source.path} line={route.source.line} />
          </div>
        )}
      </main>
    </div>
  );
}
