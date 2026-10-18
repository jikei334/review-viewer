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
- 開発コンテナ(`/workspace/vibe_coding/docker/Dockerfile`)では、OS のパッケージをイメージに入れてある(手順 3.6)。その場合は `npx playwright install chromium`(`--with-deps` なし、sudo 不要)でよい。`playwright` の版を上げたら、Dockerfile の `PLAYWRIGHT_VERSION` も揃える
- ヘッドレスの起動だけ必要な場合は `--only-shell` を付けると、フルの Chromium よりダウンロードサイズが小さい
- ブラウザの保存先は、既定でリポジトリの外(`~/.cache/ms-playwright/`)
- **`playwright` の版を上げたら、ブラウザも入れ直す。** 版がずれると、ブラウザの実行ファイルが見つからずテストが失敗する

ライセンスや詳細は [`doc/oss.md`](./doc/oss.md) の「npm パッケージ以外で入手するもの」を参照。

### 3. push 前のシークレット検出(gitleaks)

`npm ci` の `prepare` スクリプトが、`git config core.hooksPath .githooks` を設定する。これで、`git push` の前に `.githooks/pre-push` が gitleaks を実行する。シークレットらしきものが見つかったときと、gitleaks が入っていないときは、push を中止する。

```bash
# gitleaks のインストール例(Linux x64。版は doc/oss.md を参照)
curl -sSLO https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
curl -sSLO https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
grep linux_x64.tar.gz gitleaks_8.30.1_checksums.txt | sha256sum -c
tar xzf gitleaks_8.30.1_linux_x64.tar.gz gitleaks && install -m 755 gitleaks ~/.local/bin/
```

- 誤検出のときは、`.gitleaksignore` に fingerprint を追加する
- 履歴全体を手動で検査するときは `gitleaks git --redact .`

## よく使うコマンド

```bash
npm run dev         # 開発サーバー(画面と API。下の「起動」を参照)
npm run build       # 本番ビルド
npm run check       # 型検査・Lint・単体テストを順に実行
npm run e2e         # システムテスト(ブラウザが入っていること)
npm start           # ビルド済みのアプリを起動
```

システムテストを基準 ID で絞る例:

```bash
npm run e2e -- -t S1-4
```

## 起動

### 対象リポジトリの決め方

次の順に、最初に決まったものを使う(SPEC §2.5)。

1. 起動時の引数: `npm start -- <パス>`
2. 環境変数 `REPO_DIR`
3. `/repo`(存在する場合。コンテナ内の既定)
4. 1〜3 で決まらず、標準入力が端末のとき: パスの入力を求める(存在するディレクトリでなければ理由を示して聞き直す。Ctrl-C で中断)
5. 1〜3 で決まらず、標準入力が端末でないとき(CI、パイプ、`< /dev/null` など): 理由を示して終了コード 0 以外で終了する

- 引数・`REPO_DIR` のパスが存在するディレクトリでないときは、入力には進まず、待ち受けを始めずに終了コード 0 以外で終了する
- 相対パスは、**コマンドを実行したディレクトリ**が基準(npm 経由では npm が設定する `INIT_CWD`、なければカレントディレクトリ)

```bash
npm run build
npm start -- ../my-project          # 引数で指定
REPO_DIR=$HOME/my-project npm start # 環境変数で指定
npm start                           # 端末ならパスを聞かれる
```

### 開発サーバー

```bash
npm run dev -- <パス>               # 対象リポジトリの決め方は上と同じ
```

- サーバー側をビルドしてから、画面(Vite)と API(Hono)を **1つのプロセス・1つのポート**で起動する。既定は `http://127.0.0.1:5173`(`PORT` で変更。`HOST` の既定も `127.0.0.1`)
- `/api` と `/healthz` は、同じプロセス内で API に渡す(中継しないので `Host` は書き換わらず、Host / Origin の検証がそのまま働く)。許可リストの既定は `127.0.0.1:<PORT>` と `localhost:<PORT>`
- サーバー側のコードを変えたときは、`npm run dev` を起動し直す(画面は HMR で反映される)
- ポートが使用中のときは別のポートへ逃げず、失敗する

## 使用 OSS

[`doc/oss.md`](./doc/oss.md) を参照。
