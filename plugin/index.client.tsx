// 公司页面统一使用云端老板端；保留空客户端入口以兼容既有插件安装。
// Paseo 只提供执行宿主能力，不注册公司页面、侧边栏或工作区面板。
export default function contribute() { return () => {}; }
