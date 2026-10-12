# Review Viewer

レビュー資料(Markdown)とソースコードをブラウザで並べて読み、コメントを付け、MCP 経由で AI に指示を渡せる、自分専用のローカルツール。

仕様の正本は [`SPEC.md`](./SPEC.md)。

## 開発環境のセットアップ

### 前提

- Node.js `^22.13.0 || >=24`(Playwright の公式の動作要件は 22 系の最新)
- npm 10 以上

### 1. 依存のインストール

```bash
npm ci
```

### 2. ブラウザの入手(システムテスト用)

`npm ci` だけではブラウザ本体は入らない。`playwright` パッケージが指定するブラウザを、別途ダウンロードする。

```bash
npx playwright install --with-deps chromium
```

- `--with-deps` は、ブラウザの実行に必要な OS のパッケージも合わせて入れる(Linux でのみ意味を持つ)
- ヘッドレスの起動だけ必要な場合は `--only-shell` を付けると、フルの Chromium よりダウンロードサイズが小さい
- ブラウザの保存先は、既定でリポジトリの外(`~/.cache/ms-playwright/`)
- **`playwright` の版を上げたら、ブラウザも入れ直す。** 版がずれると、ブラウザの実行ファイルが見つからずテストが失敗する

ライセンスや詳細は [`doc/oss.md`](./doc/oss.md) の「npm パッケージ以外で入手するもの」を参照。

## よく使うコマンド

```bash
npm run dev         # 開発サーバー
npm run build       # 本番ビルド
npm run check       # 型検査・Lint・単体テストを順に実行
npm run e2e         # システムテスト(ブラウザが入っていること)
npm start           # ビルド済みのアプリを起動
```

システムテストを基準 ID で絞る例:

```bash
npm run e2e -- -t S1-4
```

## 使用 OSS

[`doc/oss.md`](./doc/oss.md) を参照。
