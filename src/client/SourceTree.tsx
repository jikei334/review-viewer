/**
 * ソースツリー(リポジトリのファイルとディレクトリ)
 *
 * ディレクトリを開いたときに、はじめて `GET /api/tree` で中身を取得する。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchTree, type TreeEntry } from './api.js';
import { toggleExpanded } from './tree-state.js';

/** ディレクトリ1つ分の取得状態 */
type Listing =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly entries: readonly TreeEntry[] };

/** SourceTree の引数 */
export interface SourceTreeProps {
  /** いま開いているソースのパス(強調表示に使う) */
  readonly selectedPath: string | null;
  /** ファイルが選ばれたときに呼ぶ。引数はそのパス */
  readonly onSelectFile: (path: string) => void;
}

/** ルートのパス */
const ROOT = '';

/**
 * ソースツリーを描画する
 *
 * @param props 選択中のパスと、選択時のコールバック
 * @returns ツリーの要素
 */
export function SourceTree({ selectedPath, onSelectFile }: SourceTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([ROOT]));
  const [listings, setListings] = useState<Readonly<Record<string, Listing>>>({});

  /**
   * ディレクトリの中身を(未取得なら)取得する
   *
   * @param path ディレクトリのパス
   */
  const load = useCallback((path: string): void => {
    setListings((prev) => ({ ...prev, [path]: { status: 'loading' } }));
    fetchTree(path).then(
      (entries) => {
        setListings((prev) => ({ ...prev, [path]: { status: 'ready', entries } }));
      },
      (err: unknown) => {
        console.error('Review Viewer: ディレクトリ一覧を取得できませんでした', err);
        setListings((prev) => ({ ...prev, [path]: { status: 'error' } }));
      }
    );
  }, []);

  // ルートは、画面を開いたときに一度だけ取得する
  useEffect(() => {
    load(ROOT);
  }, [load]);

  /**
   * ディレクトリを開閉する。初めて開くときは、中身を取得する
   *
   * @param path ディレクトリのパス
   */
  const toggle = (path: string): void => {
    if (!expanded.has(path) && (listings[path] === undefined || listings[path].status === 'error')) {
      load(path);
    }
    setExpanded((prev) => toggleExpanded(prev, path));
  };

  /**
   * ディレクトリの中身を描画する
   *
   * @param path ディレクトリのパス
   * @returns 一覧、または読み込み中・エラーの表示
   */
  const renderListing = (path: string): ReactNode => {
    const listing = listings[path];
    if (listing === undefined || listing.status === 'loading') return <p className="status">読み込み中…</p>;
    if (listing.status === 'error') {
      return (
        <p className="status error" role="alert">
          一覧を取得できませんでした
        </p>
      );
    }
    if (listing.entries.length === 0) return <p className="status">空のディレクトリ</p>;
    return (
      <ul>
        {listing.entries.map((entry) => (
          <li key={entry.path}>
            {entry.type === 'directory' ? (
              <>
                <button
                  type="button"
                  className="tree-directory"
                  aria-expanded={expanded.has(entry.path)}
                  onClick={() => {
                    toggle(entry.path);
                  }}
                >
                  {expanded.has(entry.path) ? '▾ ' : '▸ '}
                  {entry.name}
                </button>
                {expanded.has(entry.path) && renderListing(entry.path)}
              </>
            ) : (
              <button
                type="button"
                className="tree-file"
                aria-current={entry.path === selectedPath ? 'true' : undefined}
                onClick={() => {
                  onSelectFile(entry.path);
                }}
              >
                {entry.name}
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div data-testid="source-tree" className="source-tree">
      {renderListing(ROOT)}
    </div>
  );
}
