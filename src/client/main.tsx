/**
 * 画面の入口
 *
 * #root に React のアプリを描画する。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('表示先の要素 #root が見つかりません');
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
