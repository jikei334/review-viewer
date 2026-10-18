/**
 * ソースツリー(リポジトリのファイルとディレクトリ)
 *
 * ディレクトリを開いたときに、はじめて `GET /api/tree` で中身を取得する。
 */
import { useCallback, useEffect, useState } from 'react';
import type { TreeEntry } from './api.js';
import { loadListing, needsLoad, toggleExpanded, type Listing } from './tree-state.js';

/** SourceTree の引数 */
export interface SourceTreeProps {
  /** いま開いているソースのパス(強調表示に使う) */
  readonly selectedPath: string | null;
  /** ファイルが選ばれたときに呼ぶ。引数はそのパス */
  readonly onSelectFile: (path: string) => void;
}

/** ルートのパス */
const ROOT = '';

/** TreeNodes の引数 */
export interface TreeNodesProps {
  /** 描画するディレクトリのパス */
  readonly path: string;
  /** ディレクトリごとの取得状態 */
  readonly listings: Readonly<Record<string, Listing>>;
  /** 展開しているディレクトリのパスの集合 */
  readonly expanded: ReadonlySet<string>;
  /** いま開いているソースのパス */
  readonly selectedPath: string | null;
  /** ディレクトリの開閉ボタンが押されたときに呼ぶ */
  readonly onToggle: (path: string) => void;
  /** ファイルが選ばれたときに呼ぶ */
  readonly onSelectFile: (path: string) => void;
}

/**
 * ディレクトリの中身を再帰的に描画する(状態を持たない)
 *
 * @param props 描画するディレクトリ、取得状態、展開状態、コールバック
 * @returns 一覧、または読み込み中・エラーの表示
 */
export function TreeNodes(props: TreeNodesProps) {
  const { path, listings, expanded, selectedPath, onToggle, onSelectFile } = props;
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
      {listing.entries.map((entry: TreeEntry) => (
        <li key={entry.path}>
          {entry.type === 'directory' ? (
            <>
              <button
                type="button"
                className="tree-directory"
                aria-expanded={expanded.has(entry.path)}
                onClick={() => {
                  onToggle(entry.path);
                }}
              >
                {expanded.has(entry.path) ? '▾ ' : '▸ '}
                {entry.name}
              </button>
              {expanded.has(entry.path) && <TreeNodes {...props} path={entry.path} />}
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
}

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
   * ディレクトリの中身を取得して、取得状態に入れる
   *
   * @param path ディレクトリのパス
   */
  const load = useCallback((path: string): void => {
    setListings((prev) => ({ ...prev, [path]: { status: 'loading' } }));
    void loadListing(path).then((next) => {
      setListings((prev) => ({ ...prev, [path]: next }));
    });
  }, []);

  // ルートは、画面を開いたときに一度だけ取得する
  useEffect(() => {
    load(ROOT);
  }, [load]);

  /**
   * ディレクトリを開閉する。初めて開くとき(または前回失敗したとき)は、中身を取得する
   *
   * @param path ディレクトリのパス
   */
  const toggle = (path: string): void => {
    if (!expanded.has(path) && needsLoad(listings[path])) load(path);
    setExpanded((prev) => toggleExpanded(prev, path));
  };

  return (
    <div data-testid="source-tree" className="source-tree">
      <TreeNodes
        path={ROOT}
        listings={listings}
        expanded={expanded}
        selectedPath={selectedPath}
        onToggle={toggle}
        onSelectFile={onSelectFile}
      />
    </div>
  );
}
