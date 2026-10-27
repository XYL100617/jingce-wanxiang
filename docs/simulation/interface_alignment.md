# B 任务三：A/B/C 接口对齐（当前实现与未来契约）

状态：设计草案，未修改接口或业务代码。最终职责：A 负责权威图/状态/预测和集成；B 负责仿真与合成数据；C 负责 planner、legal actions、路线成本及重规划。现有文件命名中的 `b-planner` 和 `/api/b/...` 是既有代码命名，不改变此职责划分。

## 1. A → B：权威快照输入

| 对象 | 当前代码与函数 | 已有字段 | 缺口/约束 |
| --- | --- | --- | --- |
| ScenicGraph | `server/data/scenic_graph.json`；`server/state/stateProvider.js#getScenicGraph` | `schema_version=0.1`；45 个 `nodes`（`node_id/id/type/poi_id/access_roles/algorithm_x/y/capacity/shade/tags/area_id/location_source`）；68 个 `edges`（端点、`distance_m/base_travel_time_min/direction` 等） | raw graph 没有 `scenario_id`、独立 `pois/events/facilities/exits` 表，也没有图文件内的 `graph_version`；从 `docs/data-sources/governance.json` 读取治理版 `1.0`。距离和通行均非真实已核验值；`capacity` 不具运营证据 |
| Current State | `server/data/current_state.json`；`stateProvider#getState(timestamp?,visitorId?)` | `timestamp/state_version/scenario_id`；一个 `visitor`；`weather`；41 个 `poi_states` 的 `open/queue_min/crowd_ratio/crowd_level`；68 个 `road_states` 的 `available/travel_time_min`；`event_states` | 无 `park_population`、人数队列、到发流量、传感器质量、多游客真值；`getState` 仅返回当前单共享游客，非历史查询；当前文件是 DEMO 初值，不能当现场观测 |
| EnvironmentForecast | `server/state/forecastSimulator.js#predictEnvironment(state,horizonMin=60,stepMin=10)`；`forecastQuery.js` | 每 POI 队列分钟/拥挤比/开放状态，每 edge 耗时/可用性；时间戳和版本 | 规则外推，并非未来真值；没有人群守恒、观测噪声/缺失、置信区间、模型 seed；可在规划视图中使用，但不可作仿真转移或训练真值 |

`server/state/stateProvider.js` 在模块全局保存可变 `current` 与 revision；`setState`/`setLegacyState` 写回服务内存。`server/index.js` 的 `/api/v1/scenario-event` 调用 `applyScenarioEvent(getState(), event)` 后 `setState`，故 B 批量仿真绝不能调用该写路径。`getScenicGraph`、`getState` 返回克隆，可只读取一次并冻结/复制到独立 episode。A 后续宜给 B 稳定的 `{graph, graph_version, state, snapshot_at, provenance}` 只读快照契约，以及受控的 forecast 输入/输出契约，明确 schema 与 graph 版本、时间区和单位。当前 `schema_version=0.1` 是结构契约版本，不等于治理 `graph_version=1.0`。

raw graph 拥有节点、边、嵌入 POI ID 和演示容量/距离；raw `event_states` 有 `show-1` 与 `market-peak`，后者为 forecast 状态。`server/planner/live-adapter.js#buildLivePlannerScenario` 才从 raw 生成独立 `pois/events/facilities/exits`：普通 POI 38、可参加 event 1、rest facility 2、出口 4；生成营业 09:00–22:00、停留时长、效用、休息门槛和缺省演出时长。这些默认值都是 T4/DEMO，不能反向写入 A 权威图，也不能用作真实营业和服务率。四园门在 `docs/data-sources/governance.json` 中均为 DEMO 可进可出；POI `node_id` 是到达代理，非已核实入口。`public_entity_mapping.csv` 的候选映射不得自动升级为实体等价。

**预测选择**：选 C 型数据流：B 独立推进 latent truth；观察生成器产生 observation；A 的预测器以后可用截至当前时刻的 observation 预测未来，供 C 规划。可借用 `forecastSimulator` 的字段外壳、时间边界测试和查询逻辑，但不能把其线性 drift 或事件注入结果当工厂真值。保留 A 的预测与 B 真值分离才能评估预测误差并防泄漏。

## 2. C → B：合法动作与规划

| 入口 | 当前实现 | B 的使用方式 |
| --- | --- | --- |
| `buildLivePlannerScenario(rawGraph,rawState,runtimeUser,sourceForecast)` | `server/planner/live-adapter.js` 把 raw A 数据转成规划 `graph/state/forecast` 三件套，填入大量 T4 默认值 | 当前可复用适配逻辑；未来由 A/C 固定输入版本和默认值来源，B 用 isolated observation 构造，不触碰 runtime user 全局状态 |
| `getCandidateActions(graph,state,options)` | `server/planner/rules.js` 生成未访问目标、需休息设施、WAIT 与出口候选；`candidate_limit` 可截断普通 POI | 候选生成；要记录截断配置，否则“合法集”不一定覆盖所有理论动作 |
| `isActionLegal({graph,state,forecast,action,visitor,rules})` | 同文件；返回 `{legal,action,reason,route,...}` | 检查单个动作，使用当前 C 约束 |
| `getLegalActions({graph,state,forecast,visitor,rules,excluded_target_ids,candidate_limit})` | 同文件，由 `server/planner/index.js` 导出；返回 `{legal:[evaluation],rejected:[evaluation]}`；有可立即执行目标时抑制 WAIT | **推荐方案 B**：B 调用现有 C 统一函数，通过未来的只读、版本化薄适配器固定参数与返回结构；不重写动作合法性 |
| `findPath(...)` | `server/planner/astar.js`，按预计入边时刻查询可用性/耗时并绕行 | C 内部路径约束，B 不另写第二套 A*；基于 DEMO 道路时不得宣传实测可达 |
| `stepByRules(...)` | 同 `rules.js`，生成单游客状态副本、行程项，累加行走/排队/疲劳 | 可作候选账本/对照；不能作为全园仿真真实转移，因为不更新人群/队列守恒 |
| `planItinerary(...)` / `replan(...)` | `server/planner/planner.js`，Beam Search；`validateInputs`；`applyReplanEvent` 克隆并修改 state/forecast 后滚动规划 | 为仿真游客提供可选计划建议；B 记录接受/偏离，遇事件重规划，不把规划输出当观察真值 |

当前 Action **仅** `VISIT_POI`、`ATTEND_EVENT`、`REST`、`WAIT`、`EXIT`，见 `docs/contracts/b-planner.schema.json#$defs/Action`；没有独立 `WALK`，路线包含在动作评估的 `route` 中。`PlanResult` 包含 `plan_id/based_on_state_version/based_on_forecast_version/next_action/itinerary/current_route/score/alternative_plans/reason/feasible`。`UserEvent` 允许 `SKIP_TARGET/REQUEST_REPLAN/POSITION_UPDATE/PROGRESS_UPDATE/POI_CLOSED/QUEUE_UPDATE/ROAD_CLOSED/ROAD_OPENED/EVENT_CANCELLED/EVENT_MISSED`。`server/planner/planner.js#applyReplanEvent` 当前处理这些事件并返回克隆后的规划 state/forecast；不是环境守恒仿真器。现有 Schema 是 planner 0.2 契约，raw A 图/状态不能直接按其验证。

`isActionLegal` 实际检查：目标存在/未访问、休息优先约束、指定出口、A* 可达、POI 开放和开放/关闭时间、演出取消/最晚入场/结束窗、预测排队上限、单段步行上限、剩余游览时间、到出口返程与缓冲。道路封闭由 `findPath` + `queryRoad` 排除。疲劳目前主要通过是否生成 REST 候选及 `stepByRules` 的疲劳变化起作用，**没有全局疲劳硬上限**。`getLegalActions` 对 WAIT 的抑制是策略规则，不是物理安全约束。`latest_entry_time` 检查到达时刻，未实现真实检票/容量守恒。C 的 forecast 查询还会在缺数据时回退到 state/默认值，仿真缺失观测时要明示降级语义。

### 推荐的只读接口契约（未来，不在本轮实现）

```text
evaluateLegalActions({
  graph_version, schema_version, scenario_id, decision_time,
  planner_graph, observed_planner_state, available_forecast,
  visitor_observation, rules_version, candidate_limit
}) → { legal: [ActionEvaluation], rejected: [ActionEvaluation],
       based_on_state_version, based_on_forecast_version, rules_version }
```

薄层只做版本/ID/时间/来源校验、固定候选截断与缺测策略，内部调用 C 的 `getLegalActions`，不复制 `rules.js`。对安全关键的封路，若观测陈旧或 UNKNOWN，默认禁止新进入并记录拒绝原因；异常分支待 C/A 联合确认。B 必须传的是**决策时可见**的状态，不能传 latent 全知状态。现有函数已存在，故选方案 B；“薄层稳定化”是 B 对接 C 的后续需求，不等于当前不存在统一合法动作函数。

## 3. B → C 与 B → A

**B → C**：按 C schema 提供版本一致的规划图、观察状态、可用预测、游客当前节点/时间/剩余时长/疲劳/已游览 ID、异常事件、规则版本；记录完整 legal/rejected evaluation、路径、`PlanResult` 及重规划原因。B 的人数队列应转换为带质量标记的 `queue_min` 估计，真实 latent 人数不得透给 C。封路应用后重取动作，不得缓存旧合法集。

**B → A**：未来仅提交 `synthetic=true`、`source_tier=T4` 的合成 episode/聚合轨迹、场景与参数版本、seed、校验报告、切分清单和许可/来源元数据，供世界模型训练与评估。若要将轨迹映射到 A 的 `ScenicState`/`EnvironmentForecast`，另建明确的转换与时间/单位契约；不得写回 `stateProvider` 当前游客、`current_state.json` 或启用 REAL。A 应确认 graph 版本锁定和预测可见字段，C 应确认 legal action 规则版本、候选完整性及关闭/缺失的安全语义。现有 `test/live-adapter.test.js`、`test/planner.test.js`、`test/preference.test.js` 和 `server/tests/contract.test.js` 可作接口回归基线；尚无仿真 episode 契约和多游客接口测试。
