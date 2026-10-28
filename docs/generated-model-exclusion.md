# 排除 Magpie 生成分组模型

老板要求：分组不再接纳 group/ 或 auto/ 开头的模型；发现、自动加入、Jev 判断评分都排除，现有分组成员执行一次清理。

- 按完整模型 ID 的路径段识别 group 或 auto，包括 remote-magpie/group/... 和 remote-magpie/auto/...、更深远端包装及思考等级后缀；普通 autoencoder、grouped-model 名称不误伤。
- 候选发现、自动分档、已有托管成员合并、AA 映射候选、Jev 直接入口、排序 facts 和模型绩效证据使用相同判定。旧裁决与执行台账保留，生成分组不再进入待裁决列表、模型质量评分或榜单。
- 发布后从 main release 执行 scripts/cleanup-generated-group-members.ts --execute，先备份，再用 Magpie SaveGroup API 清理公司四档位组。仅移除生成分组成员，保留有效模型顺序及分组其他配置；这次显式清理包括手动 Opus 组，但不接管其自动维护。其他个人分组不触碰。
- 若清理后为空，不借其他组或模型填充；保存为空组，由现有 Magpie 空组错误行为处理。脚本缺省只预览，执行后读回成员验证；失败如实报告，不手写 providers.json。
- 回归覆盖路径识别、自动分档、零 Jev 调用、混合请求重编号、历史库存/模型评分过滤与清理保序。合并 main 后做本机发布门禁、上线健康与四组剩余成员核对。
