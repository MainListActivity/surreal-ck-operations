# 首批启动任务

已建立实际 GitHub Issues。当前均等待人员与授权安排；启动任务进入分诊，其余为阻塞。MainListActivity 是临时解除阻塞的收件人，不是虚构员工。

任务 01 确认安排，02 完成入职演练；后续任务才可以进入执行队列。3—6、11—15 为客户试点线；7—10 为法律内容线；16 是经营周期。客户试点不依赖法律内容上线。

| 任务 | 原执行岗位 | 验收岗位 | 前置依赖 |
|---|---|---|---|
| [#1 确认人员、授权、预算与工作时间](https://github.com/MainListActivity/surreal-ck-operations/issues/1) | gm | owner | 无；需确认公司决策者与授权 |
| [#2 完成岗位配员与一次完整交接演练](https://github.com/MainListActivity/surreal-ck-operations/issues/2) | gm | owner | #1 |
| [#3 核验现有产品从导入到真人复核的基线](https://github.com/MainListActivity/surreal-ck-operations/issues/3) | qa | product | #2 |
| [#4 制定首批律师团队试点方案与成功标准](https://github.com/MainListActivity/surreal-ck-operations/issues/4) | product | gm | #3 |
| [#5 建立获准联系名单并验证三家试点意向](https://github.com/MainListActivity/surreal-ck-operations/issues/5) | cs | product | #4 |
| [#6 为首家合格客户批准试点交付范围](https://github.com/MainListActivity/surreal-ck-operations/issues/6) | product | gm | #5 |
| [#7 核对法律内容读取的依赖并交付最小授权阅读链](https://github.com/MainListActivity/surreal-ck-operations/issues/7) | ai-content | qa | #3 |
| [#8 独立验收法律内容阅读候选版本](https://github.com/MainListActivity/surreal-ck-operations/issues/8) | qa | product | #7 |
| [#9 决定法律内容阅读能力是否灰度发布](https://github.com/MainListActivity/surreal-ck-operations/issues/9) | gm | owner | #8 |
| [#10 执行获批发布并提交生产核验](https://github.com/MainListActivity/surreal-ck-operations/issues/10) | engineering | qa | #9 |
| [#11 带首家客户完成启用和首批数据导入](https://github.com/MainListActivity/surreal-ck-operations/issues/11) | cs | product | #6 |
| [#12 完成首家客户问题处理与真人复核](https://github.com/MainListActivity/surreal-ck-operations/issues/12) | product | qa | #11 |
| [#13 提交首家客户商业转化方案](https://github.com/MainListActivity/surreal-ck-operations/issues/13) | cs | gm | #12 |
| [#14 完成合同与收款决定及交接](https://github.com/MainListActivity/surreal-ck-operations/issues/14) | owner | gm | #13 |
| [#15 验证首家客户次周持续使用并安排下一周期](https://github.com/MainListActivity/surreal-ck-operations/issues/15) | cs | product | #11 |
| [#16 主持首周经营复盘并生成下周任务](https://github.com/MainListActivity/surreal-ck-operations/issues/16) | gm | owner | #2 |

这些是启动阶段任务，不是虚构客户、实际招聘或已完成销售。每个实际客户和每个具体研发变更要按模板建立自己的阶段任务。执行期限在配员、授权、输入齐备后确定，未填期限不能 ready。
