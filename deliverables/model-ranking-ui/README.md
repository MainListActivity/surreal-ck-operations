# 模型排序 UI 独立原型

此目录只用于 UI 审核，不读取 SurrealDB、Magpie、Jev 或生产 API，也不修改 `plugin/` 与 `src/`。

## 预览

直接打开 `index.html`，或用任意静态文件服务器托管本目录。

- `index.html?embedded=1`：Paseo 宿主内嵌模式，移除重复品牌导航并压缩纵向空间。
- `index.html?embedded=0`：老板独立审核页面，保留完整页头与页面背景。
- 未指定参数时，通过 `window.self !== window.top` 自动判断。

原型内置 Haiku / Sonnet 各 40 条静态模拟数据；模型行默认紧凑显示，点击后展开完整指标。

## 后续接入位置

审核通过后再分别移植到：

- Paseo 插件：`plugin/client/company.tsx`
- 独立审核页：`plugin/server/ranking-page.ts`

本目录不是生产入口，不应连接真实数据。