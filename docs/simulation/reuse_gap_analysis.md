# B 任务三：代码复用与缺口审计

状态：设计草案，未实现仿真器。依据当前 `b/data-governance` 的 `server/data/`、`server/state/`、`server/planner/`、`server/index.js`、Schema、样例、测试与来源治理文件；此矩阵说明 **未来** 用法，`是否需修改` 不是本轮改动记录。B 不自建第二张地图或第二套合法动作规则。A/C 最终职责按任务三分工；旧文件名里的 B 不表示未来仍由 B 拥有 planner。

## 1. 现有模块复用矩阵

| 当前模块 | 当前作用 | 是否可复用 | 未来 simulator 用法 | 是否需修改 |
| --- | --- | --- | --- | --- |
| `server/data/scenic_graph.json` | 45 节点/68 边 DEMO 图、嵌入式 POI、示意容量和道路成本 | `REUSE_WITH_WRAPPER` | 只读锁定 A 图及治理 `graph_version=1.0`，验证 ID/来源；禁止当真实路网 | 文件本轮不改；未来需 A 提供版本快照 |
| `server/data/current_state.json` | 一个共享游客与演示环境初值 | `REUSE_WITH_WRAPPER` | 克隆为某场景初值并标 T4，不当多游客或真实观测 | 文件本轮不改；未来增加独立仿真状态 |
| `server/data/scenarios.json` | NORMAL 漂移及 3 类注入事件默认数值 | `REUSE_LOGIC_ONLY` | 作为异常类型参考；参数须转入带来源/版本的 registry | 本轮不改；未来不用它充当真实参数 |
| `server/state/scenarioEngine.js#applyScenarioEvent` | 注入排队突增、道路关闭/减速，返回克隆和事件记录 | `REUSE_LOGIC_ONLY` | 借事件类型、区间与验证思路；工厂需守恒事件流水 | 本轮不改；未来独立事件队列 |
| `server/state/forecastSimulator.js#predictEnvironment` | 单初值的规则预测，线性漂移、事件时点插值、版本哈希 | `REUSE_LOGIC_ONLY` | 借预测字段与时间边界测试；不能当 latent 转移 | 本轮不改；未来独立真值引擎 |
| `server/state/forecastQuery.js` | 按时刻查询预测排队/路耗与离散可用性 | `REUSE_WITH_WRAPPER` | 对规划侧可见预测查询；禁止让未来预测充当真值 | 本轮不改；未来明确定义过期/缺测 |
| `server/state/stateProvider.js` | A 图和当前状态的克隆读取、模块全局状态写入 | `REUSE_WITH_WRAPPER` | **仅调用只读** `getScenicGraph/getState` 获取快照；工厂自持状态 | 本轮不改；未来需要只读版本契约 |
| `server/planner/live-adapter.js` | raw A 数据→C 规划 graph/state/forecast，补 DEMO 默认 | `REUSE_WITH_WRAPPER` | 将仿真观察转换成规划视图，显式记录 T4 默认 | 本轮不改；未来需稳定适配器/缺测约定 |
| `server/planner/rules.js#getLegalActions/isActionLegal` | 统一合法动作与拒绝原因 | `REUSE_WITH_WRAPPER` | B 经只读版本接口调用 C 的唯一合法性判断 | 本轮不改；未来需固定规则版本、候选完整性 |
| `server/planner/rules.js#stepByRules` | 单游客动作账本/疲劳/时间推进 | `REUSE_LOGIC_ONLY` | 核对个体行动代价；不用作全园物理转移 | 本轮不改；未来 B 建环境流水 |
| `server/planner/astar.js#findPath` | 动态入边时刻路径/关闭边绕行 | `REUSE_WITH_WRAPPER` | 经 C legal/planner 间接复用；不复制路线算法 | 本轮不改；未来确认封闭边和 UNKNOWN 语义 |
| `server/planner/planner.js#planItinerary`（Beam Search） | 用合法动作扩展与评分生成主备路线 | `REUSE_WITH_WRAPPER` | 可给游客政策一个计划建议/基线，不决定真实转移 | 本轮不改；未来固定输入版本 |
| `server/planner/planner.js#replan/applyReplanEvent` | `UserEvent` 引发滚动规划，克隆规划状态和预测 | `REUSE_WITH_WRAPPER` | 在观测到变化后生成新建议；不当事件发生器 | 本轮不改；未来明确事件交付时刻 |
| `docs/contracts/b-planner.schema.json` + examples | `Action/UserEvent/PlanResult` 等 planner 0.2 契约样例 | `REUSE_WITH_WRAPPER` | 校验 C 对接对象；episode 需另定草案/契约 | 本轮不改；未来对齐 A raw 与 C adapted 版本 |
| `server/examples/` | 当前状态/预测、道路关闭/排队等交付样例 | `REUSE_LOGIC_ONLY` | 固定场景回归基线，不能用作训练轨迹 | 本轮不改 |
| `server/tests/` 与 `test/` | HTTP/合同/路径/偏好/地图回归 | `REUSE_AS_IS` | 现有行为不回退的测试基线 | 本轮不改；未来另添守恒和可复现测试 |
| `docs/data-audit/`、`docs/data-sources/` | 字段/ID/来源/治理与 DEMO 边界 | `REUSE_AS_IS` | 参数 provenance 和图适用范围依据 | 本轮不改 |
| `server/planner/mock-scenario.js` | 独立小图的规划测试场景 | `DO_NOT_REUSE` | 不拿独立 mock ID 冒充 1.0 图或仿真真值 | 本轮不改 |
| `scripts/expand-scenic-network.js` | 改写业务图/状态的网络扩展迁移脚本 | `DO_NOT_REUSE` | 工厂运行不得调用，避免改权威数据 | 本轮不改 |

`scenarioEngine` 是 DEMO 事件注入器，不是多日仿真器：支持 `QUEUE_SPIKE/ROAD_CLOSE/ROAD_SLOWDOWN`，配置有 `NORMAL` 漂移；代码虽出现 `POI_CLOSE` 验证分支，但 `scenarios.json` 无该配置，故当前不可调用。即时事件改返回的克隆；未来事件仅登记，预测器按时间解释；它本身不写 provider，`server/index.js` 的场景 API 才调用 `setState`。道路事件到期后，`forecastSimulator` 推导预测可用性；服务器的 `updateEnvironment()` 每模拟分钟读取该预测并写回 provider，所以 DEMO runtime 可在时间推进后恢复道路。这个恢复仍是规则回放，没有全园人数、天气、演出、访客行为、seed、批量多日或 episode。

`forecastSimulator` 允许 `horizon=0..1440` 分钟、`step=1..1440` 分钟，默认 60/10；按事件开始/结束插入额外预测点，使用每小时常数漂移和 spike/road factor。没有园区人数、队列人数/服务率守恒、真实负载动态、随机性、观测误差/缺失、latent truth 或 next state；相同输入可确定复算，但 `forecast_version` 的哈希不是 RNG seed。`stateProvider` 只维护单个共享 DEMO runtime 状态；其写接口不能被 B 工厂批量生成调用。

## 2. 必须新增的能力与缺口矩阵

| 缺口 | 当前证据 | 最小未来能力 | 优先级 |
| --- | --- | --- | --- |
| 独立 simulation state | provider 模块全局 `current`，单 visitor | 每 episode 独立环境/多游客克隆，绝不写回 A runtime | P0 |
| 参数 registry 与场景 catalog | `scenarios.json` 只有 DEMO 固定规则，缺来源与范围 | 宽参数范围、T4/ASSUMPTION、版本/哈希、组合校验 | P0 |
| seeded RNG | state/scenario/forecast/planner 无 seed API | 固定算法和分子流、全流程 seed 日志与重放 | P0 |
| 人群到达/离开 | A state 无 park_population/arrival/departure | 入离园过程、位置分布与人数守恒 | P0 |
| POI 队列与服务 | 仅 `queue_min` 演示数值及线性漂移 | 等候人数、服务率、弃排流水、容量/开放约束 | P0 |
| C legal-actions 只读对接 | `getLegalActions` 已有，但输入是适配后的 C 三件套 | 观察→C 状态转换、规则版本、候选截断/UNKNOWN 语义 | P0 |
| 时间与事件队列 | forecast 能插入事件时点，非状态推进调度 | 5 分钟网格 + 精确事件 + `[start,end)` 同时刻顺序 | P0 |
| latent/observation 分层 | 当前 state 直接供预测/规划，缺传感器通道 | 分离真值、观测、available_at、质量和 missing mask | P0 |
| 游客群体行为 | planner 仅单游客假设 | 多游客偏好/速度/计划接受/偏离/提前离园 | P1 |
| 道路密度/天气/演出 | 预测仅线性 road delay；无散场客流守恒 | 简单速度函数、关闭/恢复、演出入场与散场转移 | P1 |
| 奖励与终止 | planner score 不等于仿真 reward | 多维奖励、正常/异常终止及权重版本 | P1 |
| episode writer/Schema | 只有 planner schema，无训练轨迹 | 合成标识、步骤、真值目标、观测、动作与质量元数据 | P1 |
| 切分 manifest/防泄漏 | 无仿真数据集 | 按场景/日期/seed/拓扑扰动分组并隔离目标字段 | P2 |
| 仿真验证 | 当前测试覆盖 DEMO/planner，未测守恒/重放 | property/invariant tests、回放哈希、质量报告 | P0 起建，P2 扩展 |

## 3. 最小后续实现建议（本轮未创建）

P0 可在未来建立 `server/simulator/` 下的快照加载/隔离状态、参数与场景 registry、seeded RNG、事件时钟、人口/队列守恒核心、C 只读合法动作适配、最小不变量测试。P1 再加多游客政策、路况/天气/演出动力学、观测噪声/缺失/延迟、reward、episode 写入与 Schema。P2 加分组切分、质量报告、参数敏感性与 A 的预测接口评估。每阶段由 A 确认图/状态/预测版本，由 C 确认合法动作和安全约束；B 只实现环境与数据生产。不要复制 `findPath/getLegalActions/planItinerary`，也不要调用 `expand-scenic-network` 生成新图。现有 `scenic_graph.json` 不变、REAL 不启用、任何生成样本均标 `synthetic=true/T4`。
