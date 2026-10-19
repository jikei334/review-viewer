# XSS の確認(閉じない HTML ブロック)

e2e 用フィクスチャ。S1-7 のための資料。

CommonMark では、`<SCRIPT >`(開きタグの後ろに空白)は HTML ブロックを始めるが、
閉じタグが `</SCRIPT >`(空白つき)だと HTML ブロックを閉じず、文書の終わりまで続く。
このとき後ろの見出しやリンクは、Markdown として解釈されないまま HTML として扱われうる。
どう扱われても、スクリプトは実行されないこと。実行されると `window.__rvXss` に名前が入る。

この文は表示される: XSS-EDGE-VISIBLE-BEFORE

<SCRIPT >window.__rvXss=(window.__rvXss||[]).concat('script-upper-unclosed')</SCRIPT >

## 閉じていないブロックの後ろ

<img src=x onerror="window.__rvXss=(window.__rvXss||[]).concat('edge-img')">

[XSS-EDGE-LINK-JS](javascript:window.__rvXss=(window.__rvXss||[]).concat('edge-link-js'))

<a href="javascript:window.__rvXss=(window.__rvXss||[]).concat('edge-a-href')">XSS-EDGE-LINK-HTML</a>
