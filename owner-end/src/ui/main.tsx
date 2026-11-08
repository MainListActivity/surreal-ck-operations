import { render } from 'preact';
import { App } from './App.tsx';

const root = document.getElementById('app');
if (!root) throw new Error('缺少挂载点 #app');
// index.html 的「加载中…」占位只在脚本加载前显示；Preact 的 render 是追加而不是替换，不先清掉会一直留在页面顶部。
root.replaceChildren();
render(<App />, root);
