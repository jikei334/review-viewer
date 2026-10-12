# PLAN: ステージ1「閲覧(読み取り専用)」

作成日: 2026-10-11
担当: Planner
対象 SPEC: §4(ステージ1)、§3(共通基準)

---

## §10 未確定事項の調査結果

SPEC §10 の全項目を公式ドキュメントと型定義で調査した。結果をここに記録する。

### MCP TypeScript SDK のバージョンと Hono との組み合わせ方

**確定バージョン**: `@modelcontextprotocol/server` v2.3.1(最新安定版)

**必要パッケージ**:
```
@modelcontextprotocol/server   # MCP サーバー本体
@modelcontextprotocol/hono     # Hono アダプタ
```

**Hono との組み合わせ方**(公式サンプルより):
```typescript
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Context } from 'hono';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'review-viewer', version: '1.0.0' });
    // ツール登録
    return server;
});

const app = createMcpHonoApp();
// createMcpHonoApp() はローカルホストの Host/Origin 検証を自動で行う
app.all('/mcp', (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
```

**Bearer 認証の実装方法**(`requireBearerAuth` を使う):
```typescript
import { requireBearerAuth } from '@modelcontextprotocol/hono';
// または手動で Authorization ヘッダを検証する薄いミドルウェアを書く
// 今回は REVIEW_VIEWER_TOKEN との単純な文字列比較のため、手動実装を選ぶ
```

ステージ3で実装する。ステージ1では `/mcp` は不要。

### Claude Code からの Bearer トークンつき HTTP MCP サーバーへの接続設定

プロジェクトルートの `.mcp.json`(またはユーザーの `~/.claude/mcp.json`)に以下を書く:

```json
{
  "mcpServers": {
    "review-viewer": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${REVIEW_VIEWER_TOKEN}"
      }
    }
  }
}
```

`REVIEW_VIEWER_TOKEN` は環境変数として設定する。README に手順を記載する(ステージ3)。

### Markdown 変換・Mermaid・シンタックスハイライトのライブラリ選定

| ライブラリ | バージョン(最新安定) | ライセンス | 用途 | 選定理由 |
|---|---|---|---|---|
| `react-markdown` | v9.x | MIT | Markdown→React 変換 | XSS 安全(dangerouslySetInnerHTML 不使用)、remark エコシステムと統合 |
| `remark-gfm` | v4.x | MIT | GFM 拡張(表・タスクリスト・取り消し線) | react-markdown の公式推奨プラグイン |
| `rehype-sanitize` | v6.x | MIT | HTML の無害化 (S1-7) | rehype エコシステムの公式サニタイザ |
| `mermaid` | v11.x | MIT | Mermaid 図の描画 | 公式ライブラリ、`securityLevel: 'strict'` でスクリプト実行を禁止できる |
| `shiki` | v3.x | MIT | シンタックスハイライト | TextMate grammar ベース、VSCode と同品質、ゼロランタイム |

**Mermaid のセキュリティ設定**:
```typescript
mermaid.initialize({
  securityLevel: 'strict',  // HTML タグをエンコードし、クリックイベントを無効化
  startOnLoad: false,
});
```
不正な記法でも `mermaid.render()` が reject するだけで画面全体は壊れない(S1-3)。

### `/repo` を読み取り専用でマウントしたとき git コマンドが動くか

ステージ4(差分ビュー)で必要になる。ステージ1では git コマンドを使わないため調査を保留する。ステージ4の PLAN 作成時に `safe.directory` 設定を含めて調査する。

### podman でのマウントの指定

```
-v /path/to/repo:/repo:ro,z   # 読み取り専用 + SELinux ラベル付け
-v /path/to/data:/data:z       # 書き込み可能 + SELinux ラベル付け
--userns=keep-id               # ホストの UID とコンテナ UID を揃える
```

ステージ4(podman 仕上げ)で Containerfile と compose を整備する。ステージ1ではローカルの Node.js で動かす。

### `.gitignore` の判定ライブラリ

**選定**: `ignore`(npm パッケージ名: `ignore`)v6.x、MIT ライセンス
純粋な JavaScript 実装で外部依存なし。git の `.gitignore` 仕様に準拠。

```typescript
import ignore from 'ignore';
const ig = ignore().add(gitignoreContent);
ig.ignores('src/secret.key') // true
```

### 画面のシステムテストに使うブラウザ自動化ツール

S1-3(Mermaid の描画確認)、S1-8(path:line リンクのクリック操作)などは、ブラウザの実行が必要なため、現時点では「未カバー」とし、手動確認の対象とする。

**理由**: ブラウザ自動化ツール(Playwright 等)の導入はコンテナのサイズと CI の複雑さを大幅に増やす。ステージ2以降の必要性を見て、人間が導入可否を判断する。

---

## タスク一覧

### T1-0: プロジェクト初期セットアップ
**担当**: Coder
**完了条件**: `npm run check` が通る(lint・typecheck・test すべて空で通る状態)
**紐づくシステムテスト**: なし(セットアップのみ)

作業内容:
- `package.json`(npm scripts: dev / build / test / typecheck / lint / check / start / e2e)
- `tsconfig.json`(strict モード)
- ESLint 設定(TypeScript 対応)
- Vitest 設定
- Vite 設定(フロントエンドビルド)
- ディレクトリ構造(`src/server/`, `src/client/`, `e2e/`, `reports/`, `doc/`)
- `doc/oss.md`(使用ライブラリ一覧、上記選定結果を記載)
- `.gitignore`(`node_modules/`, `dist/`, `.env*`, `data/`)

---

### T1-1: サーバー基盤(Host/Origin 検証、/healthz、シグナルハンドラ)
**担当**: Coder
**完了条件**: 以下の単体テストが通り、`npm run check` が通る
**紐づくシステムテスト**: C-1、C-2、C-3、C-6(Tester が e2e/ に書く)

作業内容:
- Hono サーバー起動(`src/server/index.ts`)
- 環境変数の読み込み(`REPO_DIR`, `DATA_DIR`, `HOST`, `PORT`, `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`)
- Host ヘッダ検証ミドルウェア: 許可リスト外は 403(C-1)
- Origin/Content-Type 検証ミドルウェア: POST/PATCH/DELETE で許可リスト外 Origin または Origin なし+JSON でない場合は 403(C-2)
- `GET /healthz` → 200(Host 検証あり)
- SIGTERM / SIGINT ハンドラ(C-6)
- `npm start` で起動し `GET /healthz` が 200 を返すこと

**単体テストの対象**:
- Host 検証: 許可リスト内/外/未設定の各パターン
- Origin 検証: GET/POST それぞれの許可/拒否パターン

---

### T1-2: RepoReader(ファイル一覧・ファイル取得 API)
**担当**: Coder
**完了条件**: 以下の単体テストが通り、`npm run check` が通る
**紐づくシステムテスト**: S1-1、S1-4、S1-5、S1-6(Tester が e2e/ に書く)

作業内容:
- `src/server/RepoReader.ts`: ファイルを読む唯一の入口
  - パス検証: `../`・絶対パス・シンボリックリンク(リポジトリ外)を拒否(S1-4)
  - 秘密ファイル除外パターン: `.env*`, `.git/`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `.claude.json`(S1-5)
  - `.gitignore` 判定: `ignore` パッケージを使用(S1-5)
  - 巨大ファイル(既定 1MB 超)・バイナリの本文は返さない(S1-6)
- `GET /api/reports` → `reports/*.md` を更新日時の新しい順で返す(S1-1)
- `GET /api/tree?path=` → ディレクトリ一覧(拒否対象を除く)
- `GET /api/file?path=` → ファイル内容(拒否対象・巨大・バイナリは本文なし)

**フィクスチャ**(単体テスト用、`src/__fixtures__/`):
- 通常のソースファイル
- `../` を含む不正パス
- シンボリックリンク(リポジトリ外を指す)
- `.env`, `id_rsa`, `.claude.json` などの秘密ファイル
- 1MB 超のダミーファイル
- バイナリファイル
- `.gitignore` で除外されたファイル

**単体テストの対象**:
- 各拒否パターンの正/誤判定
- 1MB 境界値
- バイナリ判定

---

### T1-3: フロントエンド基盤 + Markdown 表示
**担当**: Coder
**完了条件**: 以下の単体テストが通り、`npm run check` が通る
**紐づくシステムテスト**: S1-2、S1-3、S1-7(Tester が e2e/ に書く。S1-3 と S1-7 は手動確認で代替可)

作業内容:
- React + Vite セットアップ(フロントエンド)
- レポート一覧 UI(`GET /api/reports` を呼ぶ)
- Markdown 表示コンポーネント:
  - `react-markdown` + `remark-gfm`(GFM 対応: 表・タスクリスト・コードブロック)(S1-2)
  - `rehype-sanitize` で HTML を無害化(S1-7)
  - `shiki` でシンタックスハイライト
  - Mermaid ブロックの検出と描画: `securityLevel: 'strict'`(S1-3)
  - Mermaid のエラーは該当ブロックのみにエラー表示し、画面全体を壊さない(S1-3)

**単体テストの対象**:
- `rehype-sanitize` で `<script>`, `<iframe>`, `onerror=` 属性などが除去されること(S1-7)
- XSS テストケース: `<script>alert(1)</script>`, `<img onerror="...">`, `javascript:` URI など

---

### T1-4: ソースツリーとファイル表示
**担当**: Coder
**完了条件**: `npm run check` が通る
**紐づくシステムテスト**: なし(S1-4、S1-5 は T1-2 でカバー済み)

作業内容:
- ソースツリー UI(`GET /api/tree` を呼ぶ、ディレクトリ展開)
- ファイル表示 UI(行番号つき、`shiki` でシンタックスハイライト)
- 左右並び表示レイアウト(左: レポート、右: ソース)
- 巨大ファイル・バイナリは「表示できません」メッセージを表示

---

### T1-5: `path:line` リンク
**担当**: Coder
**完了条件**: 以下の単体テストが通り、`npm run check` が通る
**紐づくシステムテスト**: S1-8(Tester が e2e/ に書く。クリック操作はブラウザが必要なため手動確認で代替可)

作業内容:
- Markdown 表示中の `src/foo.ts:42` パターンをリンクに変換するプラグイン/カスタムコンポーネント
- クリック時に右ペインでファイルを開き、該当行へスクロール・強調表示(S1-8)
- パターン: `[任意のパス]:[数字]` 形式(例: `src/server/index.ts:15`)

**単体テストの対象**:
- `src/foo.ts:42` → リンク変換される
- `foo.ts:0` → 変換しない(0行目は無効)
- リンクのないテキストは変換しない

---

### T1-6: セキュリティ静的チェック(C-4)
**担当**: Coder
**完了条件**: `npm run check` が通り、C-4 のテストが通る
**紐づくシステムテスト**: なし(静的チェック)

作業内容:
- Vitest のテストとして、`@anthropic-ai/*` への依存と `claude` コマンドの起動が `package.json` とソースコードに存在しないことを確認(C-4)

---

## タスク依存関係

```
T1-0 → T1-1 → T1-2 → T1-3 → T1-4 → T1-5
                                       ↓
              T1-6(C-4) は T1-0 完了後いつでも可)
```

## Tester が書く e2e/ の対象

| システムテスト ID | 内容 | 前提タスク |
|---|---|---|
| C-1 | Host ヘッダ検証 | T1-1 |
| C-2 | Origin/CSRF 検証 | T1-1 |
| C-3 | bind アドレスが 127.0.0.1 | T1-1 |
| C-6 | SIGTERM 正常終了 | T1-1 |
| S1-1 | `GET /api/reports` が新しい順で返る | T1-2 |
| S1-4 | `/api/file`・`/api/tree` がリポジトリ外パスを拒否 | T1-2 |
| S1-5 | 秘密ファイルが一覧・取得から除外される | T1-2 |
| S1-6 | 巨大ファイル・バイナリは本文なし | T1-2 |
| S1-2 | GFM(表・タスクリスト・コードブロック)が正しく HTML になる | T1-3 |
| S1-7 | XSS が無害化される | T1-3 |

## 手動確認(システムテスト未カバー)

| 基準 ID | 内容 | 理由 |
|---|---|---|
| S1-3 | Mermaid の描画とエラー表示 | ブラウザ自動化ツール未導入のため |
| S1-8 | `path:line` リンクのクリック操作 | ブラウザ自動化ツール未導入のため |
| S1-9 | 実際のプロジェクトで並び表示を確認 | SPEC で手動確認と明記 |

---

## 使用ライブラリ一覧(ステージ1)

| OSS 名 | バージョン | ライセンス | 用途 |
|---|---|---|---|
| hono | v4.x | MIT | Web サーバーフレームワーク |
| @hono/node-server | v1.x | MIT | Node.js 上で Hono を動かすアダプタ |
| react | v19.x | MIT | UI フレームワーク |
| react-dom | v19.x | MIT | React DOM レンダラ |
| vite | v6.x | MIT | フロントエンドビルドツール |
| @vitejs/plugin-react | v4.x | MIT | Vite の React プラグイン |
| react-markdown | v9.x | MIT | Markdown→React 変換 |
| remark-gfm | v4.x | MIT | GFM 拡張プラグイン |
| rehype-sanitize | v6.x | MIT | HTML 無害化 |
| mermaid | v11.x | MIT | Mermaid 図の描画 |
| shiki | v3.x | MIT | シンタックスハイライト |
| ignore | v6.x | MIT | .gitignore パターン判定 |
| typescript | v5.x | Apache-2.0 | TypeScript コンパイラ |
| vitest | v3.x | MIT | 単体テストフレームワーク |
| eslint | v9.x | MIT | Linter |
| @typescript-eslint/eslint-plugin | v8.x | MIT | TypeScript 用 ESLint プラグイン |

---

## ステージ1 完了の定義

- `npm run check`(typecheck + lint + 単体テスト)がすべて通る
- T1-1〜T1-5 に紐づく e2e/ のシステムテストが通る
- S1-3、S1-8、S1-9 の手動確認が未カバーとして報告資料に記載される
- Reviewer が各タスクで `APPROVE` を出している
