// Lane-note fixtures for the consolidation tests: three restatements of one lesson (pairwise similarity 0.68 to 0.97),
// one note that shares none of their wording, a rewrite that passes the note rules, and 24 notes that are pairwise unrelated.

export const A = '截图证据的时间必须晚于最后一次 UI 源提交，并与提交的 HEAD 对应。';
export const B = '截图证据要晚于最后一次 UI 源提交，并对照提交的 HEAD 核对时间顺序。';
export const C = '截图证据要晚于最后一次 UI 源提交，并对照提交的 HEAD 核对时间。';
export const UNRELATED = '数据库迁移必须能回滚到上一版本';
export const MERGED = '截图证据必须晚于最后一次 UI 源提交，并与提交的 HEAD 核对。';
export const DISTINCT = [
  '数据库迁移必须能回滚到上一版本', '发布前核对安装包的校验和', '控制台按钮文案统一使用中文', '并发写入先确认共享状态的生命周期',
  '日志里不要打印任何令牌或密码', '接口改动前先搜索全部调用方', '图片素材要保留原始分辨率的副本', '依赖升级后重新生成锁文件',
  '跨时区的截止时间统一用 UTC 存储', '测试数据库只用临时目录里的实例', '合并分支前先变基到最新主干', '删除文件前确认它不在任何引用里',
  '性能回归先看慢查询日志再改索引', '错误信息要说明下一步怎么做', '字体文件随产物一起打包进安装包', '异步任务失败时保留现场并告警',
  '权限判断放在服务端而不是页面', '配置项变更要写进发布说明', '第三方回调必须验证签名后再处理', '缓存失效策略写在模块注释里',
  '夜间备份前先暂停写入以保证一致', '表格导出的列顺序与模板保持一致', '一次提交只做一件事并写清原因', '回退方案必须在发布单里写明',
];
