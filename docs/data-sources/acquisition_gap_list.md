# 第二阶段获取缺口清单

下列原始缺口清单基于仓库和 [第一阶段审计](../data-audit/data_audit_report.md)；本轮新增的 T2 公开证据及仍未解决的部分列在文末。 当前 P0/P1 仍是真实导航和模型校准缺口；优选的 T1/T3 来源是未来获取路线，A 当前无仓库外 T1，T3 目前不安排。P0/P1/P2 表示未来获取与核验优先级，不表示现有业务代码必须在本轮修改。`preferred_source` 和 `fallback_method` 是后续路线，不代表已获得。需先核对许可、安全和现场进入权限。

| gap_id | data_needed | related_entity | current_status | current_evidence | preferred_source | fallback_method | responsible_party | why_needed | blocking_level |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0-01 | POI/演出/设施实际游客入口 | 41 poi_id；重点theater/rest/chaguan | UNKNOWN | node_id仅代码绑定；无独立entrance_node_id | T1运营方入口图 | T3逐点走查并双人复核 | A+B（A定图；B验外键） | 动作终点和到达时间正确性 | BLOCKS_REAL_NAV |
| P0-02 | 68条道路真实可步行性与障碍 | edge_001–edge_068；桥边12条优先 | REFERENCE_ONLY | hand_map_reference；verified_walkable=UNKNOWN | T1道路清单/封路规则 | T3重复走查及照片/轨迹 | A+B（A拓扑；B可达性） | 避免推荐不存在或不可走的路 | BLOCKS_REAL_NAV |
| P0-03 | 道路方向与服务/游客通行限制 | 68 edge | UNKNOWN | 代码均BIDIRECTIONAL，未现场确认 | T1通行规则 | T3双向走查与人员确认 | A+B | A*可用边和紧急返程 | BLOCKS_REAL_NAV |
| P0-04 | 4个园门开放时段、进出方向及临时状态 | gate/southgate/westgate/eastgate | UNKNOWN | 4节点含PARK_EXIT；无独立出口开放状态 | T1运营规则和当天公告 | T3现场确认并记录时段 | A+B | 返程出口可用性 | BLOCKS_REAL_NAV |
| P0-05 | 关键演出正式排期、最晚入场、结束与取消 | show-1/theater及其余show节点 | DEMO / ASSUMPTION；T2_EVIDENCE_AVAILABLE；ID_MAPPING_REVIEW_REQUIRED | 11:20为演示；结束时刻默认+30分钟 | T1运营排期 | T2带日期的官方公告+T3现场核验 | A+B | ATTEND_EVENT时窗正确性 | BLOCKS_REAL_PLAN |
| P0-06 | 休息设施与演出场地开放状态 | rest/chaguan/theater | UNKNOWN | B适配未完整继承poi.open；设施默认rest | T1设施运营清单 | T3当天现场确认 | A+B | 防止关闭场地仍被推荐 | BLOCKS_REAL_PLAN |
| P0-07 | 未来真实图证据与演示/真实模式隔离 | 45 node/68 edge及图副本 | DEMO_FROZEN / REAL_PENDING | 当前 DEMO 图版本 1.0、operation_mode=DEMO；真实图证据仍无 | 未来取得授权 T1 图/运营规则 | 未来具条件时再讨论 T3；当前不开展 | A+B | 防止将演示拓扑误称真实导航 | BLOCKS_REAL_NAV |
| P1-01 | 道路分时段重复步行时间 | 68 edge；桥边和入口边先测 | RULE_GENERATED | distance按折线估算；速度75米/分钟 | T1聚合通行时长 | T3同方向多次计时并记录误差 | A+B | 校准A*成本与余量 | CALIBRATION |
| P1-02 | 分时段真实排队与缺测 | 41 POI状态；重点theater/market | DEMO / RULE_GENERATED | 初值0–25分钟；未来为规则漂移 | T1聚合排队日志 | T3固定时点观察并记录方法 | A+B | 校准预测和排队阈值 | CALIBRATION |
| P1-03 | 演出散场后的客流波峰 | theater/market及相邻道路 | UNKNOWN | 有market-peak演示事件，无观测证据 | T1匿名聚合流量 | T3散场前后重复观察 | A+B | 预测人流对道路/队列的影响 | CALIBRATION |
| P1-04 | 四入口分时段匿名流量 | 4个园门 | UNKNOWN | 只有静态示例和模拟游客 | T1闸机匿名聚合 | T3人工分时段计数且不记录身份 | A+B | 校准入园初态和峰值 | CALIBRATION |
| P1-05 | 天气及其影响的可复核历史 | 天气/道路/排队 | UNKNOWN | weather.rain等单位和含义未定义 | T1运营观测+有许可天气源 | T2许可的天气历史；T3现场状态 | A+B | 区分天气相关性与规则假设 | CALIBRATION |
| P1-06 | 封路/减速历史与恢复时刻 | 68 edge | RULE_CONFIG | 当前只见仿真场景；无历史台账 | T1运营封路记录 | T2正式公告+T3现场记录 | A+B | 校准动态通行和恢复 | CALIBRATION |
| P1-07 | 工作日/周末及节假日差异 | 排队/客流/演出 | UNKNOWN | 无跨日真实采样 | T1按日匿名聚合 | T3分日重复观察 | A+B | 避免单日模拟外推 | CALIBRATION |
| P2-01 | 完整 GIS/CAD、投影/精度和权限 | 全园图及真实入口 | UNKNOWN | 仅手绘参考坐标 | T1授权GIS/CAD | T3局部测绘或走查（不得冒充完整GIS） | A主导；B对齐图ID | 长期图精度与版本治理 | LONG_TERM |
| P2-02 | 游客行为、轨迹及授权 | 游客状态/反馈 | DEMO / UNKNOWN | visitor_001共享模拟状态；无真实授权轨迹 | T1匿名且获授权聚合数据 | T3明示同意的有限观察方案 | A+B | 长期行为模型与偏好校准 | LONG_TERM |
| P2-03 | 长周期运营数据与缺失报告 | 排队/客流/设施/事件 | UNKNOWN | 无跨日持久运营记录 | T1授权长期台账 | 经许可的T2公告留档 | A+B | 季节性/漂移和置信边界 | LONG_TERM |
| P2-04 | 来源许可证及可训练/可再分发范围 | 地图/知识/天气/运营资料 | UNKNOWN | 未找到许可清单或授权原件 | 权利人书面许可/T2明确条款 | 隔离资料，仅内部待核验 | A+B | 防止无权使用和不可追溯 | LONG_TERM |
| P2-05 | 完整知识条目原文与审核链 | 4条companionFacts及后续条目 | UNVERIFIED_CONTENT | 当前只有硬编码文案 | T1正式介绍或T2可核验文本 | 人工标注未核验并暂停事实声称 | A+B按模块接口协作 | 可追溯知识和时效 | LONG_TERM |

## 当前 T2 证据与 ID 绑定状态

- P0-05 的三打祝家庄、打铁花、王婆说媒已有节目名称、预约或动态公告的 `T2_EVIDENCE_AVAILABLE`；正式场次、当天时间和内部 `event_id` 仍为 `ID_MAPPING_REVIEW_REQUIRED`，不得映射到演示 `show-1`。
- 打铁花场地名称“城寨沙场”已有 `T2_EVIDENCE_AVAILABLE`；内部 `fortress` 为同名候选，物理身份、入口与演出绑定仍为 `ID_MAPPING_REVIEW_REQUIRED`。
- 七页没有四个园门的可靠公开名称、位置与方向对照，P0-04 仍为 `UNKNOWN`，不能由内部 `westgate` 等名称推断真实园门。
- 表中所有 T3 现场走查、重复计时和观察均为未来备用路线；当前统一状态 `CURRENT_STAGE_NOT_PLANNED`，不删除 P0/P1 缺口。

## 道路现场核验顺序

先核验 4 个园门相连的道路、通行方向和当天开放时段，再核验桥边及其支路出口可达性。两组有重叠，不能把它们的列表长度相加称为独立道路数。

园门连接道路（当前代码声明的邻接，不代表现场入口路）：

| edge_id | 当前端点 | 理由 |
| --- | --- | --- |
| edge_001 | gate → southgate | 入口连接道路 |
| edge_002 | gate → market | 入口连接道路 |
| edge_003 | southgate → temple | 入口连接道路 |
| edge_021 | westgate → fortress | 入口连接道路 |
| edge_026 | gate → feiyunpu | 入口连接道路 |
| edge_029 | shenboat → gate | 入口连接道路 |
| edge_043 | children_park → eastgate | 入口连接道路 |
| edge_044 | summit → eastgate | 入口连接道路 |
| edge_045 | westgate → gate | 入口连接道路 |
| edge_046 | westgate → circus | 桥边；两类优先级重叠 |
| edge_058 | westgate → bailemen | 桥边；两类优先级重叠 |
| edge_064 | gate → shuihu_li | 桥边；两类优先级重叠 |

第一阶段按当前双向图逐边删除计算的 12 条桥边：

| edge_id | 关闭后无出口的小分量 |
| --- | --- |
| edge_046 | circus,tiger_hall |
| edge_047 | tiger_hall |
| edge_052 | puyi_wharf,retro_block |
| edge_053 | puyi_wharf |
| edge_058 | bailemen |
| edge_059 | shili_yangchang |
| edge_060 | kuaipolin |
| edge_061 | chaguan |
| edge_062 | zhu_family_fort |
| edge_063 | magic_square |
| edge_064 | shuihu_li |
| edge_065 | flower_camp |

这些结论只是当前图拓扑的条件结果，不说明现实中该路必然是唯一道路，也不构成新增道路的理由。现场若发现偏差，保留原记录与核验证据，交 A/B 确认新图版本后再改业务图。

## 已冻结的 DEMO 规则与剩余数据签收

负责人现已确定当前 DEMO 图 `graph_version=1.0`、`operation_mode=DEMO`、四门均可进出、POI `node_id` 暂作演示到达代理。以上不再列为待讨论问题，也不是现场真实规则。T1 当前不可用；本阶段不开展 T3。

仍需 A/B 在未来取得证据时签收：真实 POI/演出/设施入口，68 条道路可步行性与方向，四门当天开放与通行，演出当日排期、取消和场地，已估算距离/耗时的实测替代，以及运营时间时区与有效期。当前不得假设 A 手里另有 GIS/CAD、排队、客流或运营数据库。

## B 的下一步准备

本阶段先维护 T2 复核日期、网页证据快照状态、冲突和版本外键；保留 P0/P1 未来真值缺口。若以后取得授权运营资料或具备现场核验条件，再新增来源和有效期并由 A/B 签收；不要直接覆盖业务图或预测器。

## 本轮 T2 公开核验增补（2026-10-26）

README.md 与 source_tiers.md 已同步现行治理状态。来源登记为 276 行：T1=0、T2=24、T3=0、T4=20、UNKNOWN_SOURCE=232；其中 T2 对应 7 个独立公开页面。登记行不等于独立资料份数。

- 景区顶层名称和 2023 年名录等级：政府页面有“万岁山大宋武侠城／4A”；攻略和携程使用“万岁山武侠城”。已获 T2 名称/等级证据，但没有景区顶层 canonical ID 与内部 POI 的签收映射。来源行 SRC_0253–SRC_0254，页面：https://www.shunhequ.gov.cn/kfsshhzqwz/c00314/pc/content/content_1876895005729964032.html。
- 常规景区开放 08:00–23:00、一般 21:00 停止入园：本地宝与携程主景区页均列出；携程另列每年 5 月 1–5 日 21:30 停止入园及节假日/周末现场调整。已有 T2 条件口径，仍缺具体日期的运营确认；当前 T1 不可用且不开展 T3。不能复制给 41 个 POI、四园门或真实导航。未核实的“整园 08:00–21:00 特定活动”说法不录入事实表。
- P0-05 演出：本地宝页面支持节目单每日更新、天气等原因临时变更并以当天广播为准；王婆说媒具体时间看当日公告。三打祝家庄和打铁花有 T2 预约规则，但具体日场次、入场截止、结束和取消仍缺当日资料。
- 打铁花地点：公开页面称“城寨沙场”。这是 T2 场地**名称**证据；内部 event_id、node_id、实际入口和路网绑定仍为 `REVIEW_REQUIRED`。不得仅按同名绑定到图节点。
- 许可：上述 7 个页面均未得到可供批量训练/再分发的明确授权；`license=UNKNOWN`、`rights_restriction=REVIEW_REQUIRED`。

### 保留的冲突与条件

1. 08:00–23:00 是两家第三方页面的常规整园口径；用户提到的特定节假日/活动 08:00–21:00 尚未由本轮七页证实。不要视作可覆盖的永久矛盾或写入业务时间。
2. 21:00 与携程所列 5 月 1–5 日 21:30 有日期条件差异；两条来源行同时保留，不用“更新较晚”自动覆盖。
3. 仓库的 `gate/southgate/westgate/eastgate` 及历史 `northgate` 迁移属于内部 ID；七页未提供四门同一版的名称、开放、方向和物理入口证据，P0-04 仍未解决。
4. 公开页面证明节目单动态机制，而非某个节目每天固定场次；旧的 `show-1` 仍是演示事件，不能绑定三打祝家庄/打铁花/王婆说媒。
5. 政府名录对 2023 名称/等级的证据强于本地生活网站和旅游平台；后两者主要供交叉参考，不能替代运营方当天公告。

### 本批之后 A/B 仍须签收

- A 确认景区顶层名称别名与内部实体命名空间；明确公开“城寨沙场”与内部节点/演出场地的对应及实际入口，未签收前保持空绑定。
- 当前 A 没有仓库外运营数据库；未来如获得授权的当天开放、演出排期、预约容量或取消资料，再由 A/B 共同签收。B 继续区分整园时间、停止入园、单 POI 营业时间和演出最晚入场。
- A/B 先确认 T2 页面原件/截图的合法留档方案、许可与复核日期。T1 当前不可用，T3 当前不开展；真实导航仍须等待未来证据和安全审核。

## 当前阶段采集边界

P0 的真实入口、道路可通行与四门运营状态，以及 P1 的重复步行时间、真实排队和客流，均未因 DEMO 版本冻结而变为实测。当前以 T2 公开证据和 T4 仿真完成演示治理；T1=`CURRENTLY_UNAVAILABLE`，T3=`CURRENT_STAGE_NOT_PLANNED`。今后条件具备时才重新安排真实数据采集，P0/P1 项目保留。
