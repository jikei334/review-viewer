# 使用 OSS 一覧

このプロジェクトが直接依存している OSS の一覧。`package.json` に書いたものだけを載せる(間接的な依存は `package-lock.json` を参照)。

- バージョンは、`package.json` で固定している値
- ライセンスは、インストールした実物(`node_modules/<パッケージ>/package.json` の `license`)で確認した値
- 依存を追加・更新したら、この表も更新する

## 開発時の依存(devDependencies)

| OSS 名 | バージョン | ライセンス | 用途 |
|---|---|---|---|
| typescript | 6.0.3 | Apache-2.0 | TypeScript コンパイラ(型検査、サーバーのビルド) |
| vite | 8.3.4 | MIT | 画面のビルドと開発サーバー |
| vitest | 4.1.11 | MIT | 単体テスト(`npm run test`)とシステムテスト(`npm run e2e`)の実行 |
| eslint | 10.12.0 | MIT | Linter |
| @eslint/js | 10.0.1 | MIT | ESLint の JavaScript 用の推奨ルール |
| typescript-eslint | 8.71.1 | MIT | ESLint の TypeScript 対応(パーサーと推奨ルール) |
| @types/node | 22.20.5 | MIT | Node.js の型定義(対象の下限である Node.js 22 系に合わせている) |
| @vitejs/plugin-react | 6.1.2 | MIT | Vite で React(JSX)をビルドするプラグイン(vite 8 に対応する版) |
| @types/react | 19.3.0 | MIT | React の型定義 |
| @types/react-dom | 19.3.0 | MIT | React DOM の型定義 |
| playwright | 1.64.0 | Apache-2.0 | 画面のシステムテスト(`npm run e2e`)で、Chromium を自動操作するライブラリ。既存の Vitest の e2e から呼ぶ。テストランナーつきの `@playwright/test` は使わない |

## 実行時の依存(dependencies)

| OSS 名 | バージョン | ライセンス | 用途 |
|---|---|---|---|
| hono | 4.13.13 | MIT | Web サーバーのフレームワーク(ルーティング、ミドルウェア) |
| @hono/node-server | 2.1.4 | MIT | Node.js の HTTP サーバーで Hono を動かすアダプタ |
| ignore | 7.0.12 | MIT | `.gitignore` のパターンの判定(S1-5。除外されたファイルを一覧に出さず、取得も拒否するため。自前で実装しない) |
| react | 19.3.1 | MIT | 画面の UI フレームワーク(T1-3) |
| react-dom | 19.3.1 | MIT | React を DOM に描画する(T1-3) |
| react-markdown | 10.1.0 | MIT | Markdown を React の要素に変換する。HTML の文字列を作って挿入しないので、XSS に強い(S1-2、S1-7) |
| remark-gfm | 4.0.1 | MIT | GFM(表・タスクリスト・取り消し線・自動リンク)の拡張(S1-2) |
| rehype-sanitize | 6.0.0 | MIT | 変換後の HTML を無害化する(S1-7) |
| unified | 11.0.5 | MIT | Markdown の構文木を作るための土台。コードブロックの言語を、描画の前に調べるために直接使う(react-markdown の依存でもある) |
| remark-parse | 11.0.0 | MIT | Markdown を構文木にする(上と同じ用途。react-markdown の依存でもある) |
| mermaid | 12.2.0 | MIT | Mermaid の図の描画。`securityLevel: 'strict'` で使い、生成した SVG は Mermaid 自身が DOMPurify で無害化する(S1-3) |
| shiki | 4.5.0 | MIT | コードブロックのシンタックスハイライト。トークンに分けて React が `span` で描画する(JavaScript 版の正規表現エンジンを使い、WASM は配信しない)(S1-2) |

画面のライブラリは、ビルド時に `dist/client` へ取り込まれる(実行時にサーバーが `node_modules` から読むことはない)。ただし、まとめて `dependencies` に置いている。コンテナで `--omit=dev` にするときは、画面のライブラリを `devDependencies` へ移してよいかを検討する。

## npm パッケージ以外で入手するもの(システムテスト用のブラウザ)

`playwright` を `npm ci` で入れても、ブラウザ本体は入らない(`playwright` と `playwright-core` の `package.json` に、インストール時に動く `scripts` は無い)。ブラウザは、`playwright` のコマンド(`npx playwright install ...`)で別にダウンロードする。保存先は、既定でリポジトリの外(Linux では `~/.cache/ms-playwright/`)。リポジトリには含めない。開発時とテスト時にだけ使う。

版は、`playwright` の版で決まる(`node_modules/playwright-core/browsers.json`)。`playwright` の版を上げたら、ブラウザも入れ直す。

| 名前 | 版(playwright 1.64.0 が指定するもの) | ライセンス | 入手元 | 用途 |
|---|---|---|---|---|
| Chrome Headless Shell(Chrome for Testing のビルド) | 156.0.8078.4(playwright の revision 1248) | 下の注記を参照(1つのライセンスではない) | `https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-headless-shell-linux64.zip` | ヘッドレスの Chromium。画面のシステムテストで使う |
| FFmpeg(playwright が配布するビルド) | playwright の revision 1013(FFmpeg 自体の版は未確認) | LGPL-2.1(同梱の `COPYING.LGPLv2.1` による。下の注記を参照) | `https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-linux.zip` | `npx playwright install chromium` が、ブラウザと一緒に入れる(`--only-shell` を付けても入る)。playwright が何に使うかは、実物では未確認。このプロジェクトのテストから直接は使わない |

ライセンスについて、確認できたことと、できていないこと(T1-P1、2026-10-12。ダウンロードした実物で確認):

- **Chrome Headless Shell**: 同梱の `ABOUT` は「Google Chrome / Copyright 2026 Google LLC. All rights reserved.」とし、Chromium と他の OSS で作られていること、利用規約は `chrome://terms` を見ることを書いている。同梱の `LICENSE.headless_shell`(約 2.4 MB)は、Chromium プロジェクトの BSD 3 条項の文面から始まり、含まれている第三者のソフトウェアのライセンスを並べたもの。**全体に適用される利用条件(Chrome for Testing としての利用規約の中身)と、`LICENSE.headless_shell` に並ぶ個々のライセンスの一覧は、未確認**
- **FFmpeg**: 同梱されているライセンスの文書は `COPYING.LGPLv2.1`(GNU LGPL 2.1)だけ。**ビルドの構成(有効にしたコーデックなど)と、対応するソースコードの入手先は、未確認**
- どちらも、このリポジトリから再配布はしない(各自の環境で、配布元からダウンロードする)。コンテナイメージに含める場合(後のステージ)は、そのときに再配布の条件を確認する
- フルの Chromium(Chrome for Testing 156.0.8078.4。`--only-shell` を付けない `npx playwright install chromium` で入る)は、T1-P1 の時点ではダウンロードしておらず、同梱のライセンス文書は未確認
- ブラウザの実行に必要な OS のパッケージ(`npx playwright install-deps chromium` が入れるもの)は、OS の配布物であり、この表の対象外

## npm パッケージ以外で入手するもの(push 前のシークレット検出)

push 前にシークレットを検出するために使う(`.githooks/pre-push`)。リポジトリには含めない。各自の環境に入れる(PATH が通っていないと、フックは push を止める)。

| OSS 名 | バージョン | ライセンス | 入手元 | 用途 |
|---|---|---|---|---|
| gitleaks | 8.30.1 | MIT(リリースの tar.gz に同梱の `LICENSE` で確認) | `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz`(同じリリースの `gitleaks_8.30.1_checksums.txt` で SHA-256 を検証する) | `git push` の前に、送るコミットのシークレットを検出する。初回の push では、リモートにないコミット、つまり履歴全体を検査する |

## 最新版を使っていないもの

| OSS 名 | 最新版(2026-10-12 時点) | 採用した版 | 理由 |
|---|---|---|---|
| typescript | 7.0.2 | 6.0.3 | typescript-eslint 8.71.1 が対応する TypeScript は `>=4.8.4 <6.1.0`。7 系には未対応 |
| vitest | 5.0.3 | 4.1.11 | T1-N1 で 5.0.3 を試した結果、上げる条件を満たさなかった(下の「vitest 5 を見送った理由」を参照)。Node.js の版は理由ではなくなった |
| @types/node | 26.6.5 | 22.20.5 | 対象の下限は Node.js 22 系。22 に無い API を、型検査で誤って通さないため(22 系の中では最新) |

### vitest 5 を見送った理由(T1-N1、2026-10-12)

対象の Node.js を 22 以上に上げたので(`engines.node` は `^22.13.0 || >=24`)、vitest 5.0.3 を実際に入れて確かめた。`npm run check` は通り(583 件)、`npm run e2e` の件数と成否も変わらなかった(166 passed / 15 todo / 失敗 0)。それでも、次の点が残るので 4.1.11 に留めた。

- **システムテストの名前が 38 件変わる。** vitest 5 は、`it.each` のタイトルの `$` 変数に入る文字列から引用符を外す(リリースノートの破壊的変更 #10170)。`e2e/api.test.ts` の S1-5 の 38 件が該当する(例: `GET /api/file は '.env' を拒否する('.env*')` が `GET /api/file は .env を拒否する(.env*)` になる)。名前を元に戻すには `e2e/` の変更が要るが、`e2e/` は Tester の担当
- **`-t` の照合の仕方が変わる。** `describe` とテストの名前を、空白ではなく ` > ` でつないだ文字列に照合する(#10686)。基準 ID だけの指定(`-t S1-4`、`-t S1-5`、`-t C-1`)は、4 系と同じ件数になることを確かめた。`describe` とテストの名前にまたがる指定は、結果が変わる
- **対応する Node.js の範囲が違う。** vitest 5.0.3 の `engines.node` は `^22.12.0 || ^24.0.0 || >=26.0.0` で、25 系が入らない。上げるなら、`engines.node` を `^22.13.0 || ^24.0.0 || >=26.0.0` に狭める必要がある
- 既定値の変更(`clearMocks` が既定で有効: #10613)は、`vi.fn` を使う単体テストに関係する。現在のテストは、そのままで通ることを確かめた

出典: vitest の移行ガイド(https://vitest.dev/guide/migration.html)、v5.0.0 のリリースノート(https://github.com/vitest-dev/vitest/releases/tag/v5.0.0)、レジストリの `vitest@5.0.3` の `engines` と `peerDependencies`。上げるかどうかは、Tester と人間の判断に委ねる。
