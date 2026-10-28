# B 任务三：仿真数据工厂设计（仅设计，未实现）

状态：设计草案；2026-10-27；`graph_version=1.0`，`operation_mode=DEMO`。本文所有未取得现场或运营证据的动力学、参数和访客特征均为 `T4 / synthetic / ASSUMPTION`。本轮不生成 episode，不训练模型。A 维护权威图、状态和预测接口；C 维护合法动作、路径和规划约束；B 只维护隔离的仿真状态、环境动力学、游客行为与合成数据质量。T1 暂无，T2 为 7 个独立网页的 24 条字段证据，T3 当前不开展；不能用 T2/T4 推断真实排队和真实步行安全。

## 1. 目标、边界和第一版结构

数据工厂应对同一 `scenario + seed + graph_version + parameter_version` 生成可复核的合成轨迹，保留每一步的环境真值、游客真值、可观测数据、C 的合法动作和转移结果。输出只用于 DEMO、测试、算法研究和后续训练，不能解释为景区实测准确率。

```text
A graph/state 快照（只读） + B scenario/parameter registry + seed
  → B isolated simulation state / event priority queue
  → B population + POI queue + road + show + visitor transitions
  → B observation generator（噪声、缺失、延迟）
  → C read-only legal-actions adapter（基于可观测状态及合法预测）
  → B visitor policy / C planner proposal → chosen action
  → B reward + invariant checks + episode writer（未来模块）
  → B→A 合成轨迹、质量报告、可选训练样本
```

仿真副本不得调用 `stateProvider.setState`、`setLegacyState` 或 `/api/v1/scenario-event` 写回服务运行状态。A 的 `getScenicGraph()`、`getState()` 可作为只读起点，但原始图是 45 node / 68 edge 的 DEMO 图；68 条道路为 `visual_only / REFERENCE_ONLY` 且 `verified_walkable=UNKNOWN`。POI `node_id` 仅为 DEMO 到达代理点；四园门可进出仅是 DEMO 规则。节点 `capacity`、道路距离与耗时不可当作实测量。

## 2. 时间与状态模型

内部网格 `internal_step=5 min`，统一记录带时区的绝对时间与对应本地营业日；现有接口的 `YYYY-MM-DD HH:mm:ss` 由现有 `parseTime` 按 UTC 解释，未来适配必须显式转换，禁止无说明地混用北京时间。事件队列按 `(timestamp, priority, event_id)` 稳定排序；每步推进到 `min(下一个5分钟边界, 下一个事件时间, 结束时间)`，先结算上一段的流量，再应用该时刻事件，再生成观测与决策。例：10:10→10:12 演出开始→10:15。边界约定 `[start,end)`；同一时刻的封闭与入边冲突优先执行封闭，已在边上的访客按单列的安全处理规则处理。对外可聚合为 10 分钟，但不能丢掉精确事件及守恒流水。

`EnvironmentLatentState`（完整真值，仅工厂内部和监督目标可见）：

| 字段 | 含义与约束 | 当前依据 |
| --- | --- | --- |
| `simulation_time`, `graph_version`, `scenario_id` | 时间、图和场景身份；快照版本不可在单步暗变 | A 快照 + 设计 |
| `weather` | 天气类别及模拟影响因子；`current_state.weather` 是演示初值，`rain` 单位未核实 | T4 |
| `park_population`, `arrival_count`, `departure_count` | 在园人数及本区间入离园人数，非负整数 | T4，现有状态没有 |
| `poi_state[poi_id]` | 开放、服务率、容量、停留人数、到达/完成计数 | ID 来自 A，数值 T4 |
| `queue_state[poi_id]` | 等候人数及守恒流水；`queue_min` 由人数/服务能力派生 | T4；A 当前只有演示等待分钟 |
| `road_state[edge_id]` | 封闭、恢复、边上人数、基速和有效速度 | ID/演示基时来自 A，其余 T4 |
| `event_state[event_id]` | 预到场、入场、运行、结束、散场及容量 | A 有部分演示事件；过程 T4 |
| `visitors[visitor_id]` | 多访客状态与位置、行为 | T4；A 当前仅一个共享访客 |

`VisitorLatentState` 至少含 `visitor_id`、`current_node_id`、`edge_progress`（在途时）、`walking_speed`、`preference`、`remaining_time`、`fatigue`、`rest_state`、`plan_acceptance`、`deviation_probability`、`early_exit_probability`、`visited_poi_ids`、`attended_event_ids`、`current_action`、`entry_time` 与 `exit_time`。除 ID 命名空间和 A 的演示初值外，这些人群属性均标为 T4；不把账号 UUID 当成仿真 `visitor_id`。多游客同时在园，决策可按个体推进，环境流量统一结算。

## 3. 环境转移设计

**园区守恒**：令 `N_t` 为在园人数，`A_t` 为有效入园人数，`D_t` 为有效离园人数：`N_(t+Δ)=N_t+A_t-D_t`，其中 `0≤D_t≤N_t+A_t`。内部位置分布之和须等于 `N`，在边上的人计入一次；演出入场和散场只是园内位置迁移，不改变 `N`。出入口 DEMO 允许进出，真实门禁容量未知。

**POI 排队守恒**：`Q_(i,t+Δ)=Q_(i,t)+A_(i,t)-S_(i,t)-L_(i,t)≥0`；`L` 是明示的弃排/转移人数，不得隐式丢失。`S≤Q+A`，`S≤floor(service_rate_i × Δ)`，同时受 `open_i`、`capacity_i - occupancy_i`、演出入场窗限制；关闭时新到达者被拒绝或改道，`S=0`（若需清场，另记离开流水）。提供给 A/C 的 `queue_min` 是 `Q/service_rate` 的有界估计，服务率为 0 时返回 UNKNOWN/不可服务，不能返回伪造的 0。

**路网与速度**：P1-G 已采用下文第 15 节的路段人数、线性拥堵系数和天气系数，在进入路段时锁定该群组的通行时间。当前没有逐游客速度积分或真实道路容量；图中 `distance_m/base_travel_time_min` 是示意估计，不可用于现实安全结论。封闭边禁止新进入；已进入当前路段的群组完成该路段后，在下一节点按现有 P1-B/P1-C 规则重新规划。

**演出**：`UPCOMING → ENTRY_OPEN → RUNNING → ENDED → RELEASING`；预到场按游客行为流进入候场区，入场数受窗口及容量约束。取消与改时作为精确时间事件。结束时把参与者按出口/后续目标分配到相邻节点和道路，造成短时散场波峰；人数从演出占用转移，不能凭空增加。`show-1` 是演示事件 ID，不等同任何未经证据绑定的公开演出名称。

**游客转移**：每次决策先以可观测状态构造 C 输入，取得 `legal` / `rejected`；游客策略只从 `legal` 中选择，记录计划建议、接受/偏离、行动耗时、在途进度与结果。C 的 `stepByRules` 可作单游客约束与账本参考，但它仅推进一个游客副本、使用预测排队且不会守恒全园流量；环境真实转移须由 B 的统一流水结算。突发事件后重取合法动作并触发 C `replan`，不能继续执行已失效动作。`WAIT` 和 `EXIT` 也是动作；当前无独立 `WALK` 动作，步行包含在到目标动作的 route 中。

## 4. 参数注册、场景与随机性

未来 registry 以 `parameter_version` 锁定，字段含 `name/unit/value_or_range/source_tier/parameter_basis/evidence_id/applicability/validity/owner`。没有证据时用 **宽范围** 而非貌似精确的单值，例如人流强度、每 POI 服务率、到达分布、速度和天气影响统一由配置范围采样，`source_tier=T4`、`parameter_basis=ASSUMPTION`。图节点 `capacity` 仅可作为带假设标签的 DEMO 初值，不声称现场容量。

场景维度：客流 `LOW/MEDIUM/HIGH/PEAK`；日期 `WEEKDAY/WEEKEND/HOLIDAY`；天气 `CLEAR/RAIN/HOT`；游客速度 `SLOW/NORMAL/FAST`；游览时长 `SHORT/MEDIUM/LONG`；异常 `ROAD_CLOSURE/ROAD_SLOWDOWN/POI_CLOSURE/SHOW_CHANGE/QUEUE_SPIKE/SENSOR_MISSING/POSITION_NOISE`。组合必须先过容量、时间窗和可达性校验。`QUEUE_SPIKE` 在未来应由到达/服务流产生或明确记录外生流量，不得只在 `queue_min` 上凭空加分钟。

每次运行至少记录 `scenario_id, seed, graph_version, simulator_version, parameter_version, start_time, end_time`，再记录图/参数内容哈希、代码修订、RNG 算法版本、子流分配。用有种子的伪随机数及固定抽样顺序；按 `population/weather/visitor/observation` 分离子流，避免新增一个传感器改变客流轨迹。相同输入版本应生成相同结果，输出可用哈希回归验证。当前 `scenarioEngine`、`forecastSimulator`、`stateProvider`、`planner` 均无 seed API；`forecastSimulator` 对同样输入是确定性规则预测，但不是种子仿真。

## 5. 观测与预测分离

`Observation_t` 只由在 `t` 已可获取的真值生成，包含 `observed_queue`、`observed_crowd`、`observed_road_state`、`observed_weather`、`observed_position`，每字段带 `observed_at`、`available_at`、`source_tier`、`quality`、`missing_mask`。噪声、缺失、延迟各用独立随机子流；缺失保持 `null/UNKNOWN`，不可填入 latent 真值。延迟值按 `available_at≤decision_time` 的队列交付。C 收到的 `ScenicState`/`EnvironmentForecast` 是从当前及历史观测映射的规划视图；A 的未来预测也只可基于决策时已知信息。为离线监督保留 `latent_state_t` 与 `next_latent_state` 在隔离的目标通道，不进入策略或预测输入。

## 6. Episode 草案、奖励与终止

以下只是未来输出草案，不是现有 `b-planner.schema.json` 的正式契约：

```json
{
  "episode_id": "synthetic:<scenario>:<seed>:<visitor>",
  "scenario_id": "...", "graph_version": "1.0",
  "simulator_version": "...", "parameter_version": "...", "seed": 0,
  "timestamp": "ISO-8601 with timezone", "source_tier": "T4", "synthetic": true,
  "latent_state": {}, "observation": {}, "missing_mask": {},
  "visitor_state": {}, "legal_actions": [], "chosen_action": {},
  "next_latent_state": {}, "next_observation": {},
  "reward": {"efficiency": 0, "experience": 0, "safety": 0,
    "completion": 0, "queue_penalty": 0, "fatigue_penalty": 0,
    "deviation_penalty": 0, "total": 0},
  "done": false, "termination_reason": null
}
```

建议另存 `graph_hash`、`parameter_hash`、`observation_available_at`、动作候选及拒绝原因、`plan_id`、状态质量、事件流水和生成器修订，便于审计。`total` 由版本化权重组合各维，当前不定权重。奖励用于仿真评估、规划/世界模型后续学习与解释，安全维应作为硬约束优先；不把“预测排队短”自动等于真实体验好。

终止原因：`VISITOR_EXITED`（正常）、`DAY_ENDED`（按是否已妥善离园另标）、`TIME_EXHAUSTED`、`FORCED_EVACUATION`、`INVALID_STATE`。异常结束必须单列，不能混作正常成功；每次终止仍输出最终观测和守恒审计。

## 7. 质量验证与防泄漏

校验：ID/图版本一致；人口、队列、演出容量与占用守恒；非负流量及有界疲劳；封闭边无新进入；动作属于当时合法集；事件时间顺序与 `[start,end)`；同 seed/版本重放同结果；观察延迟/缺失按配置；episode 元数据完整；输出始终 `synthetic=true/T4`。现有测试覆盖 DEMO 预测、事件、路径、重规划等，但未覆盖上述工厂不变量。

训练输入只允许当前及历史已交付 `observation` 和由此生成的预测；禁止未来真实队列、事件结果、下一 latent 状态、未来 chosen action、全日场景隐藏日程直接进入输入。`latent_state` 可作监督目标、不可作模型输入。划分训练/验证/测试时按场景族、日期、seed 和拓扑扰动分组，先隔离测试组再采样，不能逐行随机切同一 episode；图版本与参数版本也记录在切分清单。对相同脚本仅换 seed 的近重复轨迹进行去重或同组隔离。仿真内部随机转移可读取完整场景日程，但暴露给 planner/observation 的事件仅限当时已公开或已发生者。

## 8. P0 已实现的具体约定（2026-10-27）

P0 提交 `6fecaac` 提供独立状态、当时的 `p0.1` 参数注册、`P0_BASELINE/P0_LOW/P0_HIGH`、种子 RNG、5 分钟步长与精确时间事件。每步内部可分割为多个事件前后区间，事件按时间、固定优先级和 ID 排序；同一时刻先 OPEN/REOPEN 后 CLOSE，因此关闭最终生效。事件类型仅为 `ROAD_CLOSE/ROAD_REOPEN/POI_CLOSE/POI_OPEN`。P0 的容量曾暂作每区间服务数上限代理；以下 P1-A 规则取代该代理语义。

P0 关闭 POI 的规则是：**从关闭时刻起新排队到达数为 0、服务数为 0、既有队列人数原样保留**；开放后再按参数恢复到达与服务。`Q_next=Q_before+arrivals-served` 每步强制校验。道路关闭只切换 `is_open`，不做拥堵速度模型或在途游客清退。环境人数由 `N_next=N_before+arrivals-departures` 计算，离园数截断到 `N_before+arrivals`。当前只有一个决策游客与聚合人数，没有为每个入园者建 agent；POI 到达流未与具体游客位置逐个绑定，因此 P0 保证各自账本守恒，完整空间人数守恒留待 P1。

合法动作适配从当前仿真状态投影出无噪声的可见队列分钟、开放状态、道路可用性及单游客信息，调用 `buildLivePlannerScenario` 后直接调用 C 的 `getLegalActions`。不传未来事件、RNG 状态、园区人数或队列人数真值；适配器的营业时间、停留时长等仍是原有 DEMO/T4 默认。P0 不使用 A 的 `forecastSimulator` 作为环境转移，也不输出 episode、reward、缺测或训练数据。新增测试直接检查 C 的拒绝与路线，不以 B 的重复规则替代。

## 9. P1-A 聚合游客流量账本（2026-10-27）

P1-A 保留一个 planner-facing 决策游客，另以 `population_ledger` 记录聚合群体：`outside`（本阶段不建有限外部人群池，步末为 0）、`walking`（园内移动及未进入其他设施的人数）、`queueing`、`inside_poi`、`resting=0`、`attending_event=0`、`exited_total`（累计离园，不算在园）。`park_population = walking + queueing + inside_poi + resting + attending_event`；累计守恒为 `initial_population + arrivals_total - departures_total = park_population`。A 的演示 `queue_min` 不是人数；初始化按 T4 服务率换算后，按 `initial_queue_fraction` 限定队列总预算、按 `initial_inside_fraction` 分配在内人数，剩余人数给 walking，避免初值中各 POI 队列总数超过在园人数。这是合成初值校准，不是实测反推。

每个 POI 同时记录 `queue_count` 与 `inside_count`；旧 `queue` 字段只是与 `queue_count` 同步的 P0 读取兼容别名。`capacity` 现在表示 **同时在 POI 内的最大人数**，`admission_rate` 限制排队者进入 POI 的速度，`service_rate` 限制已经在内的游客完成游览并离开的速度，三者均为 T4 假设。各区间按如下次序转移：外部抽样入园→walking；仅从 walking 抽样离园→`exited_total`；仅从 walking 向开放 POI 分配到达者→`queue_count`；`admitted=min(queue_count, capacity-inside_count, floor(admission_rate×Δt))`；`completed=min(inside_count+admitted, floor(service_rate×Δt))`；完成者回到 walking。每个变化都同时更新 ledger 与 POI 分账，任何阶段都不能凭空增减在园人数。为避免同区间重复使用刚腾出的空间，入场人数在完成结算前按原有可用容量确定。

关闭 POI 后，新的 walking→queue 为 0、queue→inside 为 0，原队列保留；已经在内的游客可按 `service_rate` 完成并回到 walking。重新开放后恢复到达与入场。道路开闭仍由 P0 事件控制，P1-A 不引入边上人数、拥堵速度或真实道路容量。`resting` 和 `attending_event` 只预留结构字段。随机分配使用同一有种子 RNG；参数版本升为 `p1a.1`，新增初始队列/在内比例、POI 到达比例和入场率，全部标 `T4 / ASSUMPTION`。仍不输出 reward、episode 或训练数据，不修改 C 的合法动作接口。

## 10. P1-B 节点和道路上的聚合人群（2026-10-27）

`mobility_ledger.node_walkers[node_id]` 记录在节点上、尚未排队的人数；`transit_groups` 是聚合 cohort，含人数、起点、目标 `poi_id/node_id`、节点与边序列、当前边或节点、路径索引及剩余边耗时。强制保持 `population_ledger.walking = sum(node_walkers) + sum(transit_groups.count)`，并继续保持 P1-A 的园区、POI 队列与在内人数守恒。原单个决策游客仍只供 C 规划，不代表群体位置。

图、边、POI 映射只读来自 A 的 `scenic_graph.json`：节点内嵌 `poi_id` 给出 DEMO 到达代理点；带 `PARK_ENTRANCE/PARK_EXIT` 角色的四个园门用于入园与离园。初始 walking 统一放在当前演示游客所在的合法入口；若该节点不是入口，使用 A 图内第一个入口。新入园者先进入该入口的 node bucket。离园只从带 `PARK_EXIT` 角色的 node bucket 扣除，处于 transit 的 cohort 不会直接离园。这些都是 DEMO 群体流动规则，不证明实际园门和 POI 游客入口已核验。

出发时从 node bucket 转入 transit，walking 总数不变，queueing 不增加。路径调用现有 C `findPath`，以当前道路开放状态排除关闭边；无路可走便留在起点。每条边的模拟耗时使用图中示意 `base_travel_time_min`，乘 T4 `travel_time_multiplier`，按内部 5 分钟网格向上取整并受 `minimum_edge_travel_min=5` 限制。**图上的距离和基础耗时也是示意估算；上述路程时间均为 T4/DEMO 假设，不代表真实景区测量值。** 新 cohort 在创建的区间不移动，下一时间区间才进入第一条边；多边路径逐段扣除剩余耗时。完全到达开放 POI 节点后才从 walking 转入 queueing。

道路在出发前关闭时，C 的 A* 选择开放边绕行；无可达路线便不创建 cohort。已进入当前边的 cohort 允许完成该边；到下一节点后检查下一边，若关闭则从当前节点调用 C 寻路重新规划，仍无路则回到该节点 bucket，且当步不再次派发。不得进入关闭边。若目标 POI 在途中关闭，cohort 可以走到其节点，但不进入 queue，转回该节点 walking bucket；之后可重新分配。POI 完成游览后进入对应 POI node bucket。`resting` 和 `attending_event` 仍为 0，不建立逐游客 agent、边容量或拥堵模型。空间群组选择完全使用 SeededRNG；参数版本为 `p1b.2`。

### P1-B 驻留语义修正

P1-A 的 `advanceQueues` 是历史单元测试使用的即时服务辅助函数；当前仿真步使用 `advancePoiService`，按 `walking → queue → inside → dwell → walking` 转移。每个 POI 的 `inside_groups` 记录聚合人数、POI ID、进入时间和最早离开时间。初始在内人数按 T4 假设视为刚在仿真起点进入。新入场群组在本区间结束时进入，至少等待自己的 `visit_duration_min`；到期后仍受 `service_rate × 区间分钟数` 的离开吞吐限制，不会在入场区间立即回到 walking。

`visit_duration_min` 借用 C live adapter 的 DEMO 分类默认语义：`view=15 min`、`show=30 min`、其他 `=22 min`；这些数值在 B 参数注册中集中定义，`unit=min`、`source_tier=T4`、`parameter_basis=ASSUMPTION`，不是现场实测游览时长。`capacity` 是同时在内的人数上限；`admission_rate` 控制 queue 入内吞吐；`service_rate` 控制已达到最早离开时间的在内群组离开吞吐；驻留时长单独由 `visit_duration_min` 决定。入场受区间开始时的空余容量、队列人数和入场吞吐共同限制，本区间完成者腾出的空间不立即重复使用。

POI 关闭后不接收新的 walking→queue，原队列保留并暂停入场；关闭前已在内的群组继续计时，到期可正常离开并回到对应 POI 的 DEMO 节点。重新开放后，队列才恢复入场。每步校验 `inside_poi=sum(POI.inside_count)=sum(inside_groups.count)`、`queueing=sum(POI.queue_count)`，以及 `park_population=node_walkers+transit+queueing+inside_poi+resting+attending_event`。`resting` 与 `attending_event` 当前仍为 0。

## 11. P1-C 主动返程闭环（2026-10-27）

只允许 `node_walkers` 中尚无离园意图的人按有种子 RNG 与 `exit_intent_rate` 产生聚合意图；该参数为 `T4 / ASSUMPTION`，单位是每 5 分钟合格节点人数比例，参数版本为 `p1c.1`。`pending_exit_intent[node_id]` 是节点行走人数的子集，不能重复计算在园人口；queue、inside 和 transit 群组不会瞬间离园。正在 POI 内的游客须到期离开并回到节点后，才有机会产生离园意图。P1-C 仿真调度将原本从园门人数桶按外生 `departure_rate` 扣人的步骤设为 0，所有离园统一由意图驱动。

每个有意图的节点群组对 A 图中带 `PARK_EXIT` 角色的园门逐一调用 C `findPath`，排除不可达者，选择 C 返回的 `travel_time_min` 最低者；同成本按 A 图中的园门顺序稳定选择。四个园门在当前 DEMO 图中为 `gate / southgate / westgate / eastgate`，均可进出，但不代表现场规则。若身处出口节点，产生意图后直接离园；若在非出口节点，则进入 `purpose=EXIT_TRAVEL` 的聚合在途群组，沿实际 C 路径逐段移动，进入与移动都不改变在园人口。只有真正到达出口节点时，才增加 `departures_total/exited_total` 并减少 `park_population/walking`。

已进入的道路关闭后仍可走完该段；在下一节点遇到后续封路时，先向原出口重新调用 C 寻路，原出口不可达则重评所有出口并可改选。全部出口不可达时，群组留在当前节点并转为 `pending_exit_intent`；初次选路失败亦如此，下个仿真步重试，不允许瞬移或强制离园。

主动离园意图为持久状态，本版不取消。每步从真实节点待离园人数和 `EXIT_TRAVEL` 在途群组派生互斥账本：`exit_intent_created = exit_completed + exit_in_transit + exit_pending_at_node`。`exit_completed` 同时包含园门节点直接离园与返程群组抵达园门后的离园；`exit_arrivals_completed_total` 仅统计后者，因此不能单独用它解释全部已完成意图。`blocked_exit_intent[node_id]` 是当前不可达出口的待离园人数，逐节点不超过 `pending_exit_intent[node_id]`，故 `exit_blocked ≤ exit_pending_at_node`，不得重复加进闭合等式。`exit_blocked_attempts_total` 另累计受阻尝试次数，可能对同一群组重复计数。节点待离园人数本身是 `node_walkers` 子集，不在园区人口中重复加和。`mobility_flow.exit_ledger` 给出每步闭合快照；仍使用示意道路时间与 DEMO POI 节点，不增加逐人 agent、拥堵、疲劳离园或天气离园。

## 12. P1-D 可见观测层（2026-10-27）

`getState()` 返回 B 内部 `latent_state`，仅供仿真、审计和测试；`getObservation()` 返回当前已可用的 `observation`。`step()` 为内部审计仍返回真实人口和移动流水，同时把已可用观测单独放在 `observation` 字段；未来模型输入只能取该观测字段，不能把整个 `step()` 结果或 `getState()` 传进去。当前尚无外部模型访问控制，集成时必须守住这一 API 边界。新增的 `observation.js` 只从当前 latent 快照读取白名单字段，生成独立副本，不修改真实队列、道路、游客或人口账本。每次捕获记录 `synthetic=true`、`source_tier=T4`、`observation_version=obs-p1d.1`、`parameter_version=obs-p1d.1`、`observed_at` 和普通字段的 `available_at`。环境参数继续保持 `p1c.1`；观测参数单独注册，避免观测抽样改变动力学参数或随机序列。观测使用由同一 seed 派生的独立 `SeededRNG` 子流。

可见负载仅包含天气、POI 的估计排队人数/分钟与拥挤比例及开放状态、道路的估计耗时及开闭状态、当前游客的系统已知位置/剩余时间与历史、已公布的演出日程和状态。后者是初始状态中已公布的时刻表，不是 Event Clock 中尚未发生的道路/POI 临时事件。未来排队、下一 latent 状态、未来出入园、在途群组、内部人口流水、RNG 状态和未来行动均不进入 observation。

第一版支持 `P1D_CLEAN`、`P1D_NOISY`、`P1D_MISSING`、`P1D_DELAYED`、`P1D_MIXED` 五种 T4 观测情景。噪声只影响观测副本的排队人数、拥挤比例和道路耗时，使用有种子高斯抽样并把排队/耗时限制为非负、比例限制在 `[0,1]`。缺失用 `null`，`missing_mask` 中 `true` 始终表示缺失；同一 POI 的排队人数和排队时间一起缺失，不把 0 当缺失。普通字段的延迟默认 5 分钟：捕获后进入 observation buffer，只有 `available_at≤current_time` 才可用于模型和 C 合法动作；在此之前沿用上一份已可用的普通观测，尚无上一份时显示 `null`。

**AUTHORITATIVE_SAFETY_FIELD**：`roads[*].is_open`、`pois[*].is_open`、已公布事件的当前取消/状态，以及系统已知的游客当前位置与剩余时间均零延迟、无噪声、无缺失。它们从当前捕获覆盖到已可用视图，防止真实封路被错误显示为开放。道路的普通耗时可以延迟或缺失，但关闭位不可以。此例外在代码中与普通传感器字段分开标记为 `is_open_available_at=observed_at`；观测顶层的 `safety_observed_at` 指明安全快照时间。

`legal-action-adapter` 现在只接受 buffer 返回的当前已可用 observation，再映射到现有 `buildLivePlannerScenario → getLegalActions` 接口。若排队时间缺失，B 使用显式注册的 30 分钟 T4 规划回退；若拥挤比例缺失，使用 T4 的 0.5；若道路耗时缺失，使用 A 图中原有的示意 `base_travel_time_min`。这些替代值记录在 `planner_view_fallbacks`，不从当前 latent queue 或 latent road speed 偷补。B 内部群体移动仍借用 C `findPath` 和权威道路开闭状态决定真实环境转移，不等同于对外提供给模型/规划器的观测视图。P1-D 不改变人口、POI 驻留、空间移动或返程动力学，也不生成 reward、episode 或训练数据。

### P1-D API 边界审查

| 接口 | 分类 | 可读取内容 | 当前调用方 |
| --- | --- | --- | --- |
| `getState()` | `INTERNAL_LATENT_API` | 全部仿真真值；只用于内部、测试、审计和未来监督目标 | 当前仅 simulator 测试和本地审计脚本 |
| `getObservation()` | `AGENT_FACING_OBSERVATION_API` | 当前已可用观测；不含人口账本、未来事件、在途群组、RNG 状态 | 当前仅 simulator 测试；未来 agent/model 应只接此接口 |
| `getLegalActions()` | `DECISION_API` | 基于已可用观测和明确 T4 回退的 C 合法动作 | 当前仅 simulator 测试 |
| `step()` / `runSteps()` | `INTERNAL_ONLY` | 真实人口、队列、移动审计流水，以及单列的已可用 `observation` | 当前仅 simulator 测试和本地审计；不能把完整结果交给 agent/model |
| `dynamics` / `mobility` | `INTERNAL_ENVIRONMENT_TRANSITION` | 为模拟真实环境转移可读取 latent；C `findPath` 在这里仅作为 B 内部路由函数 | B 模拟器内部 |

仓库当前没有将 `createSimulator()` 连接到 `server/index.js` 的 HTTP 路由；`server/index.js` 中同名的 `provider.getState()` 是 A 的现有服务状态接口，不是 B 的模拟器 `getState()`。面向未来 agent/model 的输入边界是 `getObservation()` 和 `getLegalActions().observation`，不能传入完整模拟器对象、`getState()` 或完整 `step()` 结果。普通缺失字段的规划回退只来自参数注册或 A 的公开示意图；权威安全字段按 `AUTHORITATIVE_SAFETY_FIELD` 路径零延迟提供。B 内部移动构造给 C `findPath` 的场景仍源自 latent 状态，仅供环境转移使用，不得作为 agent/model 规划视图复用。

## 13. P1-E 演出游客生命周期（2026-10-28）

当前业务快照中的 `show-1` 关联 DEMO `theater` 节点，含 `start_time=2026-10-20 11:20:00`、`latest_entry_time=11:20:00`、`capacity=180`，没有 `end_time`。仿真器以注册参数 `default_event_duration_min=30` 补足结束时间（标为 `DERIVED_T4`），不改写业务 JSON。`market-peak` 是 `forecast` 状态且对应非演出节点，不进入演出流程或已公布演出观测。上述时刻、容量、节点和路段都是 DEMO/T4 机制输入，不能解释为经现场核验的节目表、真实入口或道路。

| 时间概念 | `show-1` 时间 | 来源类型 | 含义 |
| --- | --- | --- | --- |
| `boarding_start`（状态键 `boarding_open_time`） | 10:50 | `DERIVED_T4` | `start_time - event_boarding_lead_min(30)`；模拟器生成的 DEMO 入场开始时间 |
| `latest_entry_time` | 11:20 | `BUSINESS_DEMO` | 当前演示数据中最晚进入演出场地的截止时刻；不等同于正式开演的语义，也未经现场核验 |
| `start_time` | 11:20 | `BUSINESS_DEMO` | 当前演示数据中正式开演时间 |
| `end_time` | 11:50 | `DERIVED_T4` | `start_time + default_event_duration_min(30)`；原业务数据没有结束时间 |

入场提前量、缺省结束时长、缺省最晚入场偏移均集中在参数注册表，标记为 `T4 / ASSUMPTION`。状态的 `time_sources` 保存四个时间的来源类型与推导参数；若未来业务快照提供 `end_time`，其来源类型改为 `BUSINESS_DEMO`。演示轨迹在 10:53 首次观测到 BOARDING，是因为固定 5 分钟采样点从 10:48 跨过了精确里程碑 10:50；RUNNING 在 11:20 精确生效，下一采样点为 11:23；RELEASING 在 11:50 精确生效，下一采样点为 11:53。

`SimulationState.events[event_id]` 对可模拟演出独立保存 `BEFORE_ENTRY → BOARDING → RUNNING → RELEASING → FINISHED`。Event Clock 在 `start_time - event_boarding_lead_min`、`start_time`、`latest_entry_time`、`end_time` 设置精确里程碑；每个里程碑先结算前一区间，再应用状态变化。演出期间不按普通 POI 的 `visit_duration_min` 离场。`SHOW_LATEST_ENTRY` 释放尚未入场的演出队列到演出节点，计为 missed；在途群组到下个节点或目的地时重新核对时间和封路，迟到者回到 walking，不瞬移入场。到达时间恰等于 `latest_entry_time` 的在途群组会先到演出队列，同刻里程碑随后将其转出；从该时刻起不再生成新意图。

`event_interest_rate` 从节点上尚无离园意图的 walking 人群抽样，使用由同一 seed 派生的独立 `SeededRNG` 子流。内部环境以 C 的 `findPath` 得到路线，生成 `purpose=EVENT_TRAVEL` 且携带 `target_event_id` 的聚合在途群组；既有在途、演出队列、入场人群不再参与抽样。这一聚合环境转移读取 latent 以维持真实守恒；决策游客的 `ATTEND_EVENT` 仍使用 `getLegalActions()` 和 C 的时间窗合同。封路时在下一个节点通过 C 重新寻路，不可达或赶不上截止时间则取消意图。演出节点本身在演出有效期内不作为普通 POI 目标，避免双重排队。

C 的 `ATTEND_EVENT` 对预计到达 **晚于** `latest_entry_time` 明确拒绝；B 聚合流也拒绝这种到达，并在出发前额外要求预计到达 **早于** 截止时刻，使排队和按入场率处理仍有时间。恰好抵达截止时刻时，C 个人规划在时间窗检查上可通过，B 聚合流采取保守不派发；两者不会出现 C 判迟到而 B 仍派人的相反判断。途中延误达到截止时刻的 B 群组在下一节点取消意图、记 missed 并回到 walking。

`BOARDING`（或尚在入场期限内的 `RUNNING`）按 `min(event_queue_count, capacity-attending_count, floor(event_admission_rate × 区间分钟))` 入场；`RUNNING` 中已入场者持续驻留到 `end_time`。结束后按 `floor(event_release_rate × 区间分钟)` 从 `attending_event` 逐步转为演出节点的 walking，随后由正常移动或离园逻辑处理，形成短时节点客流波峰。`FINISHED` 不再生成新入场意图，队列和入场人数最终均为零。

总账仍用 `queueing`，并维护 `queueing = ΣPOI queue_count + Σevent_queue_count`；`attending_event = Σevent attending_count`；`walking = Σnode_walkers + Σtransit_groups`；`park_population = walking + queueing + inside_poi + attending_event + resting`。单步审计 `event_flows` 分别给出意图、到队列、入场、未入场、途中失约与散场人数，其中途中失约只在 walking 内从 transit 回到 node，不重复增减总账。`event_flow_summary` 给出跨步可追踪的 dispatch/arrival 群组 ID 和聚合计数。参数版本 `p1e.1` 下的兴趣率、入场率、散场率、入场提前量、缺省演出时长与容量均为 `T4 / ASSUMPTION`。

可见层仅包含当前已公布演出的日程与当前状态（零延迟的权威状态路径），以及受 P1-D 噪声、缺失和延迟约束的排队及入场估计数；不包含未来散场人数、真实在途群组、内部累计流水或下一时刻 latent。`getState()`、完整 `step()` 与 event audit 继续限定为内部接口；`getObservation()` 与 `getLegalActions().observation` 才是未来 agent/model 的输入边界。

## 14. P1-F 聚合疲劳与抽象休息（2026-10-28）

本版仍使用聚合人数。每个节点的 walking 桶保存 `node_fatigue[node_id]`（该节点人数的 0～1 加权平均疲劳）；每个 transit 群组保存 `fatigue_level`；POI 与演出队列保存均值，POI 内群组保存 `fatigue_level`，演出入场人数保存均值。人数跨桶转移时用人数加权合并疲劳，部分流出时保留源桶均值。这是用于 T4 合成环境机制验证的群组级加权平均：它会平滑真实个体差异，不能解释为真实个人生理状态，也不能表示每位游客的精确疲劳；不推断年龄、健康或天气影响。`fatigue_low/medium/high_count` 只是按每个聚合桶均值划入 `<0.35 / 0.35～<0.7 / ≥0.7` 的审计统计，不是逐人诊断。

每个时间区间先按所在活动增加或恢复疲劳：节点 walking 与 transit 使用 `fatigue_walk_rate`，普通及演出队列使用 `fatigue_queue_rate`，POI 内使用 `fatigue_visit_rate`，演出入场使用 `fatigue_event_rate`，rest 群组使用 `fatigue_recovery_rate`。区间末执行既有 POI、演出、移动转移；当前决策游客的已知 `visitor.fatigue` 也按简化 walking 速率推进并继续作为可见游客自身状态。所有速率、初始疲劳、休息接受率、触发/释放阈值与最短休息时长集中在参数版本 `p1f.1`，均标记为 `T4 / ASSUMPTION`。

休息优先级固定为 **EXIT > REST > EVENT > POI**：先处理已有与新产生的离园意图，再从尚在节点、无离园意图且疲劳达到 `rest_trigger_threshold=0.7` 的 walking 人数中，按独立 seeded RNG 与 `rest_accept_rate` 生成休息意图。transit、队列、POI 内及演出中游客须先回到节点，不能原地瞬间休息。休息是当前节点的抽象状态，不新增地图节点；`rest_groups` 各自记录 `rest_id, count, node_id, started_at, minimum_rest_until, fatigue_level`。休息群组不参与普通移动或活动意图。

只有同时满足 `current_time >= minimum_rest_until` 与 `fatigue_level <= rest_release_threshold=0.3`，整组才从 resting 回到原节点 walking。`minimum_rest_duration_min=15` 且 `trigger > release` 提供滞回，避免紧邻步骤反复进入/离开。休息不改变在园人数：`walking → resting` 与 `resting → walking` 仅搬运人数；严格检查 `resting = Σrest_groups.count = rest_started_total - rest_completed_total`，以及 `park_population = node_walkers + transit + queueing + inside_poi + attending_event + resting`。`fatigue_summary` 记录每步及累计开始、完成人数和可追踪休息群组流水；这些审计信息仅在内部 `step()` 返回，不进入 agent/model 的观测。

`rest_started_total` 与 `rest_completed_total` 的单位是**人次（person-events）**，同一批聚合游客恢复后再次疲劳、再次休息时会重复计入；它们不能解释为去重游客数。`resting_current` 的单位是当前**人数**。本版没有其他休息状态，所以任意时刻必须满足 `resting_current = rest_started_total - rest_completed_total`。

`getObservation()` 仅继续显示系统已知的单个决策游客 `fatigue`，不暴露 `node_fatigue`、`rest_groups`、聚合疲劳直方图或未来恢复。独立休息随机子流使观测噪声场景不改变真实休息轨迹。该版本不修改 C 的 Schema 或规则，不计算奖励、道路拥堵或天气速度。

## 15. P1-G 道路占用、拥堵和天气通行时间（2026-10-28）

`roads[edge_id].occupancy` 是唯一的路段占用人数，按当前 `mobility_ledger.transit_groups` 中 `current_edge_id` 相同的群组人数求和。处于节点、等待进入路段或等待重新规划的群组不计入。当前 DEMO 图的 68 条边全部标为 `BIDIRECTIONAL`：图适配器把每条边转换为同一个双向 `edge_id`，寻路器在两个方向使用同一个边对象。因此 occupancy 是**示意实体 edge 级占用**，不是方向 lane 级占用；这不意味着现场已核验为单条实体道路。若将来图改为两条不同 ID 的有向边，则自然分别计数，无须现在预先重构。不新增第二份占用表。每次进入、离开后即时更新，`advanceTransit` 开头及末尾又从群组核对；`road_occupancy` 不变量核对非负、总和及每条边一致。

图中没有经过现场核验的宽度或承载量。参数版本 `p1g.1` 暂为每条示意边统一设 `road_reference_capacity=8` 人、`free_flow_threshold=0.25`、`congestion_alpha=1.5`、`max_congestion_multiplier=3`，均在参数注册表标记 `T4 / ASSUMPTION`。`occupancy_ratio=occupancy/reference_capacity`，允许超过 1；`congestion_multiplier=min(3, 1+1.5×max(0, occupancy_ratio−0.25))`，因此随人数单调不减。这里的 8 人只是 synthetic reference capacity / mechanism parameter，用于让「occupancy → congestion → travel time」反馈在合成环境中产生可观察变化，不是景区道路工程容量或现场最多通行人数。将来取得道路宽度、客流计数和实测速度后才可校准。

天气仅在模拟器内部把 `weather.category` 或当前业务 `weather.label` 归一为 `CLEAR / RAIN / HOT`，对应系数 `1 / 1.25 / 1.12`，仍为 `T4 / ASSUMPTION`。不改业务天气 Schema，也不把天气作用到 P1-F 疲劳。道路对**新进入者**的当前估计为 `effective_travel_time_min=(base_travel_time_min/speed_factor)×travel_time_multiplier×congestion_multiplier×weather_multiplier`；基时来自 DEMO/T4 示意图，不表示实测步行时间。进入前计算 `projected_occupancy=当前占用+本群组人数`，以进入后的占用算本群组时间，所以大群组自己也能产生拥堵。实际群组 `locked_segment_travel_time_min` 在进入时将估计值四舍五入到 0.001 分钟后锁定，随经过时间递减；途中天气或占用变化不重写本段剩余时间，到下一边才重新计算。旧的 `minimum_edge_travel_min=5` 只保留给直接调用旧移动 helper 的兼容路径；完整 P1-G 模拟使用进入时连续分钟锁定。这比逐时积分简单、可复现，且避免中途反复改写 ETA。

每条路在内部状态保留 `edge_id`、人数、参考容量、比率、拥堵及天气系数、当前新进入者估计通行时间。`step().road_metrics_summary` 审计在边人数、占用边数、最大占用、最大比率、最大有效时间与平均拥堵系数；`edge_entries` 记录每次进入时的投影人数、两类系数及锁定时间。路级当前估计可能与已在途群组各自的锁定时间不同。封路位先判定：关闭边不接受新群组，也不能用一个极大通行时间代替关闭；在途群组可走完当前边，下一节点才重新规划。

内部环境转移使用真实占用算出的潜在时间；内部群组路径调用 C 的 `findPath`，通过 B 的 `toVisibleState` 和现有 `buildLivePlannerScenario` 输入当前动态道路时间。每个 `advanceTransit` 区间开始构造路径快照，同一区间后续群组进入造成的拥堵会在下一次路径快照反映。对 agent/model 的 `getLegalActions()` 则通过 `buildPlannerView(available observation)` 输入 C：普通道路耗时先经 P1-D 观测生成器处理噪声、缺失与延迟，缺失时使用登记的图基时回退；当前道路开闭位始终零延迟且权威。原始精确 `occupancy` 不进入 observation 或 planner-facing 视图。C 的 `findPath` 现有接口读取规划状态的 `road_states[*].travel_time_min`，无需修改 C 代码。

区间顺序沿用现有精确事件时钟：先推进已在途群组并让已完成路段者回到节点，进入新路段时即时按投影占用锁定时间，然后处理当前时间点的封路、演出和新意图；新意图形成的 transit 群组下一段推进时才进入边。区间末重核占用并生成观测。演出散场和 POI/离园流量均走同一套移动机制，没有专用拥堵特例。

固定 `P0_HIGH, seed=42` 的真实仿真轨迹：第 20 步（11:58）散场 20 人时，剧场附近 `edge_033` 新进入记录为占用 1、容量 8、比率 0.125、拥堵系数 1、晴天系数 1、有效时间 1.87 分钟。第 22 步（12:08）散场又释放 20 人，剧场节点 walking 已到 49；同边的一次新进入记录为投影占用 6、比率 0.75、拥堵系数 1.75、有效时间 3.2725 分钟，锁定为 3.273 分钟。这是普通移动接收演出散场人数后自然出现的变化。相同 `edge_033`、占用 6、种子条件下改为 `RAIN`，基时仍为 1.87、拥堵系数仍为 1.75、天气系数为 1.25，有效时间为 4.090625 分钟；天气系数计算前后在园人口均为 379。

固定 `P0_HIGH, seed=42` 的第 50 步：在园 466、节点 walking 148、transit 100、排队 27、POI 内 142、演出中 0、休息 49；其中在边 65 人、占用边 21 条、单边最大 10 人、最大比率 1.25、最大有效时间 17.658125 分钟、平均拥堵系数约 1.090993。第 100 步：在园 538、节点 walking 179、transit 89、排队 37、POI 内 157、演出中 0、休息 76；其中在边 57 人、占用边 21 条、单边最大 8 人、最大比率 1、最大有效时间 26.0225 分钟、平均拥堵系数约 1.063419。两次人口与路段占用守恒均通过；transit 总人数包含尚在节点等待进入边的群组，因此可大于在边人数。这些数字仅是固定种子 T4 合成轨迹，不是真实客流。

## 16. Reward Schema 与纯计算引擎（review 阶段，2026-10-28）

Reward 的作用层级是**单个决策游客的一次动作转移**，不是整个园区的聚合环境步。当前 `createSimulator().step()` 产生园区流量、POI、演出、休息和道路审计，并保留一个 planner-facing 决策游客，但没有执行或跟踪该游客选择的动作；其聚合 `mobility_flow`、`poi_flows`、`event_flows`、`fatigue_summary` 不能直接归因给该游客。因此第一版 `computeReward({ action, beforeState, afterState, transitionAudit, observationBefore })` 是独立纯函数，不自动挂到 `step()` 或 `getLegalActions()`。调用方必须提供与前后 `visitor_id`、`action_type`、`target_id` 一致的单游客 `transitionAudit`；没有可靠归因时相应分量返回 `null / NOT_APPLICABLE`，而不是从园区总队列或总人口反推。当前实例与测试使用明确构造的转移审计来检验公式，不声称模拟器已经产生这些逐游客完成事件。完成 Reward 不等于已接通真实单游客动作执行。

计算时机是动作选择和环境转移**之后**：`observation_t → action_t → latent outcome → reward_t`。`observationBefore` 仅为边界说明，不被引擎读取、修改或回写；Reward 可用可信审计中的实际耗时、排队和结果作为训练标签/环境反馈，绝不用于当前动作选择。未来若构建 episode，可把 `reward_t` 放在 transition label 中，与 `observation_t/action_t/next_observation/next_latent_target` 分开；本轮不创建 episode writer、数据集或训练模块。

返回 Schema 包含 `reward_version=reward-p1.1`、`parameter_version=reward-params-p1.1`、动作及游客 ID、`components`、`applicability`、`raw_metrics`、`weights`、`total` 和理论 `total_bounds`。`components` 的八项为 `efficiency, experience, safety, completion, travel_penalty, queue_penalty, fatigue_penalty, missed_event_penalty`；每项若无适用或可靠输入即为 `null`，并由 `applicability[name]={applicable:false,reason}` 说明。`null` 与有效的 0 分严格区分。`raw_metrics` 保存实际移动/排队/等待分钟、时间成本、决策游客疲劳前后值、完成及误场证据类别、安全审计和归因标签，不保存园区总量。

默认参数与权重集中在 `config/reward-parameters.js`，全部标记 `T4 / ASSUMPTION`；不是实测满意度权重或景区运营目标。`efficiency=1−clip((travel+queue+wait)/60,0,1)`，但仅对已知全部相关时间的动作计算：POI/演出需实际 travel 和 queue，EXIT 需 travel，WAIT 需实际 wait；REST 不计效率。`travel_penalty=−clip(actual_travel_min/30,0,1)` 适用于 POI、演出、EXIT；`queue_penalty=−clip(actual_queue_min/30,0,1)` 只适用于 POI、演出；`fatigue_penalty=−clip(max(0,fatigue_after−fatigue_before)/0.3,0,1)` 只用与前后决策游客状态一致的归因疲劳对，成功休息降低疲劳时为 0。这里的效率与两项成本惩罚有意分别呈现总体时间评价与可解释成本，权重将其影响限制在固定范围；不会使用噪声观测代替实际转移结果。

`completion=1` 只在 `COMPLETED` 且有与游客、目标、动作类型匹配的完成事件时产生；`MISSED/FAILED` 为 0，仍在途为 `null`。事件意图本身不算观演完成，EXIT 意图本身也不算离园完成。`missed_event_penalty=−1` 仅在相关 `ATTEND_EVENT` 有匹配的 `EVENT_MISSED` 证据时产生；成功观演为 0，其他动作和未决观演为 `null`。`safety=1` 要求已确认合法且审计明确无违规；出现安全违规或动作已确认非法时为 0；审计不充分则为 `null`。正常环境不会为了制造分数而让人走入封路。当前缺少可归因且区别于“是否完成”的活动质量或满意度指标，所以 `experience` 暂为 `null / NO_DISTINCT_ATTRIBUTED_QUALITY_METRIC`；不把完成再奖励一次，也不虚构文化、美食或情绪满意度。

默认权重为效率 0.15、体验预留 0.10、安全 0.15、完成 0.25、移动惩罚 0.10、排队惩罚 0.10、疲劳惩罚 0.05、误场惩罚 0.10；一般动作的权重总和为 1。时间成本有**有意的双层影响**：增加 travel/queue 会降低综合 `efficiency` 正向项，同时增加对应的显式负向惩罚，所以实际有效时间权重大于单看移动/排队权重；这让分项可解释，但未来用于策略目标前须校准，不能当成真实游客偏好。`WAIT` 可重复完成而缺少移动/排队负项，为避免“长时间等待仍拿到完整完成奖励”的基线偏置，其完成权重单独用 T4 参数 `weight_completion_wait=0.05`，其他分量不强行填充。`total=round_6(Σ仅适用项 weight×component)`，未适用项不进入和式，理论范围 `[-0.35,0.65]`；正向项在 `[0,1]`，惩罚项在 `[-1,0]`。当前 `experience` 始终不适用，预留权重也不参与分数。所有分钟和疲劳缩放值都是版本化的 T4 假设，不根据少量演示实例调参。

动作适用性：`VISIT_POI` 与 `ATTEND_EVENT` 可计算实际 travel、queue、效率、疲劳、安全及证实的完成；观演另可计算匹配误场。`EXIT` 可计算实际 travel、效率、疲劳、安全及证实的离园完成。`WAIT` 使用实际 wait 作效率成本，不继承 POI/演出完成，且使用较低的完成权重。`REST` 可计算疲劳、安全及证实的休息完成，不凭休息短就给效率奖励。所有动作的体验项目前均不适用。各动作适用项不同；`reward-p1.1` 用作可解释的 transition quality label，尚不保证不同 action type 作为强化学习目标时完全无偏可比。未来用于 RL 或规划目标前须另行校准动作间基线及时间双层影响。引擎只读输入、不修改环境、观察、动作或 RNG；未来接入时必须先实现逐游客动作与结果审计，不能把当前聚合 `step()` 输出直接喂给 Reward。

## 17. 单游客 Transition Audit 与自动 Reward（review 阶段，2026-10-28）

模拟器现新增内部 `startDecisionTransition(chosen_action)`、`getActiveDecisionTransition()`、`getCompletedDecisionTransitions()`。调用方先取当前 `getLegalActions()`，自行选一项，再传入原样动作；B 不做策略选择。开始函数在**当前已可用 observation** 对应的合法集合中逐字段匹配动作，非法或已退出的动作抛 `INVALID_ACTION`，不建立正常 transition。开始时记录当前观测版本/观测时间、游客 ID、动作目标、合法证据、计划路线、开始时间和疲劳；结果、实际耗时、完成/误场证据及 reward 均尚不存在。`transition_000001` 等 ID 由 simulator 本地递增计数生成，同种子及同动作序列可复现。

当前 `state.visitor` 在 P0～P1-G 只供 C 合法动作和观测使用，聚合人口由另一个账本推进；它从未作为可识别的一人参与 `node_walkers`、`transit_groups`、POI/演出队列或道路占用。正式契约为 **`Decision Visitor = SHADOW_VISITOR`**：在聚合景区背景环境中进行个人决策执行与评价的镜像游客，不是额外加入宏观环境的一名实体游客。它读取当前 queue、road congestion、weather、POI/event state 与 crowd 条件，但假设单个 shadow 对宏观环境的影响可忽略。这是当前 T4 数据工厂的建模选择。四条计数规则是：shadow 不计入 `park_population`、不计入聚合 POI/演出队列、不计入 `edge occupancy`；EXIT 穿过选定出口后 `shadow_in_park: true → false` 并生成 `EXIT_COMPLETED`，**聚合 `park_population` 不因此扣 1**，因为 shadow 从未计入其中。这个选择保证人口与占用守恒，但不能把 EXIT 审计解释为聚合账本中的一次实际离园扣减；若未来要求这一强语义，须先把决策游客从聚合桶中显式拆出并全程计入各桶。

内部审计字段包括 `transition_id, visitor_id, action, started_at, ended_at, status/phase/outcome, planned_route, actual_route, timeline, actual_travel_time_min, actual_queue_time_min, actual_wait_time_min, fatigue_before/after, completion_event, missed_event, safety_audit`。运行中保持同一 transition ID 跨多个 5 分钟 step，`IN_PROGRESS` 的最终 `reward=null`。终态 `COMPLETED/FAILED/MISSED` 才补齐结束时间与证据，纯函数 `computeReward` 自动接收审计并返回 `{audit,reward}`；当前不主动制造 `CANCELLED`。完整审计只在内部 `step().decision_transition` 和内部读取 API 出现，不写入 `getObservation()`、当前 action selection 或 HTTP/前端。

`getMetadata()` 提供 `graph_version`、`scenario_id`、`seed`、`simulator_version=sim-p1ta.1`、`parameter_version`、`observation_version`、`reward_version`、`visitor_mode=SHADOW_VISITOR`、`source_tier=T4` 和 `synthetic=true`。单个审计已有 `transition_id` 及动作开始的 `observation_version`；未来 Episode Writer 可将其与 simulator metadata 一起记录，不必把同样的版本字段反复复制进每个审计。

shadow 道路执行调用现有 C 路径接口，以当时潜在 `roads[*].effective_travel_time_min` 在**进入时**锁定每边时间；实际移动分钟按区间内真正消耗的仿真时间累计，不使用计划路线耗时或噪声观测。边关闭时不进入，已在边上继续走完，下一节点改道或以 `FAILED/TARGET_UNREACHABLE` 终止。shadow 不占道路名额，因此 `actual_route` 是该镜像主体经历的路段和时间，不能解释为已加入聚合拥堵计算。POI/演出排队在镜像队列中按抵达时的当前真实队列位置、开放/容量和实际合成服务率推进；其驻留分钟由模拟时钟累计。它不占聚合服务名额，所以是与环境同步的**shadow 排队经历**，并非聚合队列中一个额外真实游客的流水。时间戳保存到毫秒，实际分钟保留六位用于审计。

`VISIT_POI` 必须先抵达目标，经过镜像队列、进入 POI、完成当前 `visit_duration_min` 的驻留才产出 `POI_VISIT_COMPLETED`；仅到达或入队不算完成。`ATTEND_EVENT` 抵达后按入场开始、最晚入场、容量和服务率排队；已入场者到演出结束才得 `EVENT_ATTENDANCE_COMPLETED`，未赶上最晚入场则得与该游客/事件匹配的 `EVENT_MISSED`。`REST` 抵达设施后至少休息 `minimum_rest_duration_min` 且疲劳低于释放阈值才完成。`WAIT` 按 C 当前合法动作给定的等待时长累计真实仿真分钟。`EXIT` 到达选定出口并使 shadow 在园标志变为 false 才完成；开始 EXIT、拿到路线或仍在途中都不算完成。状态更新使用 P1-F 现有活动速率：移动、排队、POI 内、观演、休息和等待分别结算疲劳；原先对决策游客每区间的通用 walking 疲劳在动作活跃时由阶段疲劳取代，不改聚合疲劳规则。

安全审计由动作开始时的合法集合匹配和执行时的路段开放检查产生，记录受阻边尝试、是否进入关闭边、关闭 POI 访问、事件时间违规等；正常关闭边触发改道，不伪造一次违规穿越。`reward_t` 只在终态自动生成并保存在内部转移结果；仍不进入观察或动作选择。当前版本保留 Reward Engine 的独立手工输入 API，用于公式检查；未来若要把 decision visitor 真正计入聚合人口、排队和道路，必须先重做其账本归属与守恒，而不能把 shadow 轨迹当成实测个人轨迹。Transition Audit 独立提交阶段不创建 Episode Writer、Dataset Builder、划分文件或训练模块。

## 18. Episode Schema 与 Episode Writer（review 阶段，2026-10-28）

`episode_schema_version=episode-p1.1`。一个 Episode 是一名 `SHADOW_VISITOR` 的多次决策游览，`steps` 按高层 decision action 编号 0、1、2……，内部 5 分钟仿真步仅用于执行动作。Writer 只读取模拟器状态，不选择或执行动作，不计算 Reward，也不修改聚合环境。调用顺序：`createEpisode(sim)` → 每次动作前 `captureDecisionInput(sim)` → 调用方从捕获的 `legal_actions` 选动作并调用 `startDecisionTransition` → 逐步运行到终态 → `appendTransition(episode,{input,chosen_action,terminal,terminal_step_timestamp,simulator})` → 有实际结束条件时 `finalizeEpisode`。`IN_PROGRESS` 不写高层记录。

顶层保存 `episode_id, episode_schema_version, provenance, visitor_mode, started_at, ended_at, steps, done, termination_reason`。ID 根据 scenario、seed、runIndex 确定，无 UUID 或墙钟；例如 `ep_P0_BASELINE_seed42_000001`。provenance 包括 graph、scenario、seed、source tier、synthetic、simulator、parameter、observation、reward 和 episode schema 版本。轨迹始终标记 `T4/synthetic=true`，即使参数引用了公开资料也不升级成 T2。

每个 step 保存动作前 `timestamp, observation, visitor_state, legal_actions, chosen_action`，动作后的原始 `transition_audit, reward, next_observation, next_visitor_state, latent_target`，以及 `done, termination_reason, provenance`。`observation` 与 `next_observation` 均直接取 Observation Layer 的 `getObservation()`；`legal_actions` 直接取同一时刻 `getLegalActions().legal` 的完整合法项；`chosen_action` 对应其中一项的 `action`。`chosen_action` 必须逐字段属于该集合，不包含未来结果。`reward` 直接取终态 Transition Audit 自动产生的结果，不另算。`visitor_state` 独立保存 shadow 游客节点、疲劳、剩余时间、园内标志和已完成目标；它不计入环境的聚合人口、排队、道路占用。

`latent_target` 仅供未来训练监督，取终态仿真步后的内部真实环境快照：各 POI 的队列人数、拥挤比例和开放状态；各道路的有效耗时、拥堵倍率和开放状态；可模拟演出的阶段、状态、排队和入场人数；环境汇总的人口与天气。它不进入动作前观察或合法动作输入，不复制整份 SimulationState、人口/移动账本、缓存或 RNG 内部状态。终态审计 `ended_at` 可以落在当前仿真步之内；`latent_target.timestamp` 和 `next_observation.timestamp` 对齐仿真步末端。Writer 要求传入的 `terminal_step_timestamp` 等于当前模拟器时间，防止在后续仿真推进后才把旧终态和新环境错配。

校验要求：动作前观测时间不晚于审计开始，审计开始不晚于结束，审计结束不晚于动作后观测时间；有延迟观测时仅要求 `available_at` 不晚于当时可用时间，不要求 `observed_at` 等于仿真时间。两次连续动作的游客节点、疲劳、剩余时间、园内标志和时间必须衔接；受噪声、缺失、延迟影响，连续两次 observation 的字段值无需完全相等。检查 observation 中不存在潜在目标、内部账本、Reward、审计结果和未来实际完成事件。校验失败不写入半条 step。

当前实际终止触发为 `EXIT` 完成时 `EXITED`，或剩余时间耗尽时 `TIME_EXHAUSTED`。普通完成、误场或可恢复失败通常 `done=false`，仍可继续决策。当前 simulator 没有独立的 simulation-day-end 或不可恢复错误终态信号，因此 Writer 不制造 `DAY_END`/`FAILED`；待底层提供真实信号后再扩展 schema 语义。`finalizeEpisode` 只接受已经真实结束的 Episode。本阶段仅构建内存对象与 JSON 序列化，不构建 Dataset Builder、数据切分、批量生成或训练流程。

## 19. Episode action 时间、游客白名单与字段角色（review 收尾，2026-10-28）

Episode 的相邻高层 decision step **不是固定 5 分钟间隔**。每条终态 step 显式保存 `delta_t_min = (transition_audit.ended_at - transition_audit.started_at) / 60000`，单位为实际仿真分钟，保留六位小数；要求正常终态严格大于零，且与审计时间差一致。它不使用计划耗时或观测预计耗时。`delta_t_min` 可在事后 action-conditioned transition 模型中作为时间跨度输入；在动作选择时尚未知，不能喂给当前决策策略。未来 Dataset Builder 必须按训练任务区分这两个时点。

`visitor_state` 和 `next_visitor_state` 共用显式白名单：`timestamp, visitor_id, current_node_id, fatigue, remaining_time_min, shadow_in_park, visited_poi_ids, attended_event_ids, visited_facility_ids`。前者从动作开始前真实 shadow visitor 投影，后者从终态后投影；不复制整个内部 visitor 对象。两者都不得含未来路线结果、实际耗时、终态、奖励、完成或误场证据、`fatigue_after`、下一节点。连续决策的节点、园内标志、剩余时间保持一致，疲劳允许 1e-6 浮点容差，时间非递减。

字段角色由 `EPISODE_FIELD_ROLES` 明确标记。`MODEL_INPUT`：`observation, visitor_state, legal_actions, chosen_action, delta_t_min`；其中 `delta_t_min` 只可用于动作执行后的转移预测，不能用于执行前的 action selector。`TRAINING_TARGET`：`reward, next_observation, next_visitor_state, latent_target, done, termination_reason`。`AUDIT_ONLY`：`transition_audit`，其实际移动、排队、完成、疲劳与安全明细绝不默认进入当前模型输入。`METADATA`：`episode_id, step_index, timestamp, provenance, episode_schema_version`。`latent_target` 仅在终态后采集，始终属于目标侧内部真值。具体训练任务可取这些组的子集，但不能将结果或审计信息泄漏到动作决策输入。
## 20. Visitor Profile、Scenario Sample 与 Domain Randomization（review 阶段，2026-10-28）

本阶段保持 `Decision Visitor = SHADOW_VISITOR`。聚合背景仍以分布与 cohort 推进，不为每个聚合游客造个人档案。`visitor-p1.1` 档案字段为 `profile_id, profile_version, seed, profile_index, scenario_instance_id, source_tier, parameter_basis, walking_speed_factor, dwell_time_factor, preference_weights, plan_acceptance_rate, deviation_rate, early_exit_base, parameter_provenance`。权重键仅使用现有景区节点类型 `scenery/culture/show/view`；不加入年龄、性别、健康或收入。档案由 seed、index 和独立 RNG 子流确定；默认连续均匀 T4 范围：个人速度倍率 `[0.7,1.3]`、驻留倍率 `[0.7,1.3]`、各偏好权重 `[0.5,1.5]`、计划接受率 `[0.5,0.95]`、下次决策偏离率 `[0.02,0.3]`、提前离园基础倾向 `[0.02,0.15]`。受控显式覆盖标为 `EXPLICIT_T4_OVERRIDE`。全部参数 `source_tier=T4, basis=ASSUMPTION`，不代表问卷或实测均值。

个人速度在 shadow 进入每条道路时以 `effective_travel_time_min / walking_speed_factor` 锁定，影响实际移动、到达和疲劳暴露；不改聚合道路速度或 occupancy。个人 POI 驻留以 `visit_duration_min × dwell_time_factor` 推进；不改聚合 POI 服务。`samplePlanAcceptance(profile, decisionIndex)` 对外部合法推荐动作给出 seeded 接受抽样；`sampleDeviation` 表示**下一次决策点**是否偏离原计划。它们不在 simulator 内自动选动作，也不中途随机取消原子 transition。`earlyExitPropensity` 仅用当前疲劳、剩余时间、天气、已完成访问数计算 `[0,1]` 倾向，不读取未来信息、不自动选择 EXIT；真正离园仍须合法 EXIT → 路径 → 园门 → `EXIT_COMPLETED`。偏好和档案对 Observation Layer 可见，供后续输入使用；当前 C planner 不因此修改。

`dr-p1.1` 的 `sampleScenario` 返回确定性 `scenario_instance_id`（`scn_<family>_seed<seed>_<index>_<dimension_hash>`）、family、seed、index、八个维度、采样参数和逐参数 provenance；维度签名哈希确保同 seed/index 的不同显式维度不会共用 ID。维度是客流 `LOW/MEDIUM/HIGH`，日历 `WEEKDAY/WEEKEND`，天气 `CLEAR/RAIN/HOT`，个人速度 `SLOWER/NORMAL/FASTER/MIXED`，驻留 `SHORT/NORMAL/LONG/MIXED`，道路 `NORMAL/LOCAL_CLOSURE`，演出 `NORMAL_EVENT/EVENT_DELAY`，观测 `CLEAN/NOISY/MISSING/DELAYED/MIXED`。只在调用时抽取一个实例，不枚举笛卡尔积，也不批量生成 Episode。实例与档案可经 `createSimulator({scenarioInstance, visitorProfile})` 接入；未传入实例时原 P0 行为保持。Episode provenance 兼容增加 `scenario_instance_id`、`scenario_parameter_version` 和 `visitor_profile_version`；轨迹仍为 `T4 synthetic`。

T4 有界范围：客流基础倍率 LOW `[0.50,0.65]`、MEDIUM `[0.95,1.05]`、HIGH `[1.50,1.75]`；工作日倍率 `[0.90,1.00]`、周末 `[1.10,1.20]`，实际 `arrival_scale` 为两者乘积（`[0.45,2.10]`），只改变现有聚合 arrival_multiplier。速度区间 SLOWER `[0.75,0.90]`、NORMAL `[0.95,1.05]`、FASTER `[1.10,1.25]`、MIXED `[0.75,1.25]`；驻留 SHORT `[0.75,0.90]`、NORMAL `[0.95,1.05]`、LONG `[1.10,1.25]`、MIXED `[0.75,1.25]`。`LOCAL_CLOSURE` 从图中当前开放的合法道路候选集使用独立 SeededRNG 选出 `closure_edge_id`，记录到场景 provenance；于开始后 10 或 15 分钟关闭、持续 10 或 20 分钟后恢复，复用事件时钟的 `ROAD_CLOSE/ROAD_REOPEN`。`EVENT_DELAY` 对 `show-1` 的开场、最晚入场、结束平移 5/10/15 分钟；入场开放时间由原规则相应平移，来源标记 `SCENARIO_T4_OVERLAY`。这些修改仅在 simulator 的输入副本上进行，不写业务 JSON。

天气维度在仿真输入副本中使用单一 weather category（不保留与新天气矛盾的原 DEMO 温度/晴天描述），并复用 P1-G `CLEAR=1, HOT=1.12, RAIN=1.25` 道路倍率。观测质量直接选现有 P1-D 五种情景：噪声倍率 `[0.8,1.2]` 作用于现有队列/拥挤/耗时噪声标准差；缺失倍率 `[0.8,1.2]` 作用于现有缺失概率且上限为 1；延迟取 5 或 10 分钟；未启用的质量机制为 0。定位观测包含 `position_observation`：权威节点、相邻节点候选、seeded 报告节点、置信度和噪声类型。CLEAN 置信度为 1 且报告真实节点；NOISY/MIXED 置信度 `[0.75,0.95]`，仅可能报告相邻节点；`current_node_id` 仍是 C 安全和合法性判断的权威节点，latent 真值不变。道路和 POI 的 `is_open` 继续是权威、零延迟安全字段。所有采样仅用独立 SeededRNG，参数边界和来源在 `parameter_provenance` 内逐项记录。

新增 T4 有界倍率：`poi_capacity_scale=[0.9,1.1]`、`poi_service_scale=[0.8,1.2]`、`road_capacity_scale=[0.9,1.1]`、`event_admission_scale=[0.9,1.1]`、`event_release_scale=[0.8,1.2]`。有效参数为原有 base 值乘采样倍率；POI 服务倍率同时作用于服务率和入队接纳率，容量倍率作用于 POI 容量和道路参考容量，演出两倍率作用于入场/散场速率。原参数注册表与业务快照不改；每个倍率记录 `T4/ASSUMPTION`、分布和边界。对照测试证明慢服务留存更多队列、低道路容量在同占用下更拥堵、低散场速率释放更久。

数据来源分类保持：T1 为运营方实测、T2 为有来源的公开资料、T3 为现场核验、T4 为假设/纯构造/仿真参数。当前 scenario/profile 分布皆是 T4，不因它们引用既有图或公开资料而升格。DR 独立提交阶段只提供单实例采样、个人档案与现有机制接线，不实现 Dataset Builder、固定 5 分钟数据集、训练/验证/测试切分、批量生成或世界模型训练。
## 21. Dataset Contract、Rollout Policy 与小批量 Builder（review 阶段，2026-10-28）

`dataset-p1.1` 定义两类**内存**数据，均为 `T4/synthetic=true`。Decision Transition Dataset 来自真实执行并经 `validateEpisode` 的高层 action step；每条样本分为 `input / target / audit / metadata`。`input` 仅含动作前可用 `observation, visitor_state, legal_actions, chosen_action` 及动作终态后的实际 `delta_t_min`。这个实际时间跨度仅能用于**事后转移预测**，不可作为执行前 rollout policy 的决策输入。`target` 为自动 `reward, next_observation, next_visitor_state, latent_target, done, termination_reason`；`audit` 保存终态 `transition_audit`、生成策略审计和仿真不变量；`metadata` 包含 Episode/step、场景实例、游客档案、seed、来源、合成标志及各版本。Episode ID 对带场景实例的轨迹附加维度签名，避免同 seed/runIndex 的不同场景冲突。Reward、审计、未来状态和 latent target 不进入 action selection。

Fixed 5-min Environment Rollout Dataset 与 shadow decision transition 无关。每个样本的 `latent_current.environment_state` 是 t 时刻的紧凑环境真值（POI 队列/拥挤、道路耗时/拥堵/占用、演出、人口账本汇总、天气），`observed_input.observation` 是同一仿真时刻的可用 P1-D 观测；未来 `future_target.target_5/15/30/60` 分别指向真实第 `t+1/+3/+6/+12` 个 5 分钟状态。尾部不足相应未来时置 `null` 和 `target_available=false`，不补造。每次环境仿真均检查人口与道路占用守恒；`audit.expected_edge_occupancy` 由在途 cohort 账本汇总，仅用于验证，不进入模型输入。固定时间数据不包含 action-level `delta_t_min`。`trajectory_summaries` 记录每条轨迹的客流层级、天气、累计到达、封路道路和是否实际观察到关闭，供小批量差异核验。

`rollout-policy.js` 仅服务仿真数据生成，不是 C planner。调用方先由 C 的 `getLegalActions()` 获得真实合法集合；Builder 用当前疲劳、当前合法 REST/演出和决策序号确定一个可解释的推荐候选，再由 seeded plan acceptance、下次决策 deviation、图中现有 node type 的 preference_weights 和仅用当前状态的 early-exit propensity 确定最终合法动作。策略不读取 Reward 或未来 latent；提前离园只是提高选择 EXIT 的概率，执行仍按真实路径到园门。为了完整小规模 Episode，最后一个决策预算点可选择**合法且不同于当前节点**的 EXIT，不会瞬移或绕过 Transition Audit。`policy_audit` 记录推荐、抽样、原因与实际接受/偏离/提前退出计数，并与训练 target 隔离。

`generateDecisionDataset` 输入少量场景实例、seed、游客档案规格和每场景 Episode 数；每条 action 用 `startDecisionTransition → step() 直到终态 → appendTransition` 真实运行，最后以 `finalizeEpisode` 确认终止。`generateEnvironmentRollout` 从每个场景的 t0 开始独立推进固定 5 分钟步。两者限制 review 批量上限、默认只返回内存对象，不写 JSONL 或训练文件。Builder 级校验拒绝 NaN/Inf、负队列、非法动作、输入侧未来字段、版本/来源缺失、时间错位、不连续高层决策、人口账本不守恒和道路 occupancy 与 cohort 账本不符；并检查 5/15/30/60 分钟目标索引、与已记录未来状态的一致性、尾部可用标志以及多场景轨迹差异。当前不做 Train/Val/Test Split、正式批量生成或世界模型训练。
## 22. Dataset Validation 与数据角色（2026-10-28）

`dataset-validation-p1.1` 在既有数值、合法动作、守恒、时间和来源检查之上，输出结构化分布报告：场景六维覆盖、游客速度/停留/偏好覆盖、五类动作与策略原因、Episode 长度/时长/完成数/终止原因、Reward 及各 component 的契约范围、5/15/30/60 分钟目标覆盖。缺失覆盖作为 warning 报告；无效样本和越界 Reward 作为 error 报告。报告只读，不改写 Dataset。小批量生成上限为 60 个 Episode，仍只返回内存对象。

固定 5 分钟样本的角色明确为 `observed_input`、`latent_current`、`future_target`、`audit`、`metadata`。部署型世界模型默认只取 `OBSERVED_INPUT.observation`；`LATENT_CURRENT.environment_state` 仅用于 oracle baseline、监督辅助及内部分析，不能默认并入部署输入。`FUTURE_TARGET` 的四个时间跨度仍为 t+1/t+3/t+6/t+12 个真实 5 分钟步，尾部不可用目标仍为 null。动作级样本由 `projectDecisionRoles` 投影为 `POLICY_INPUT(observation, visitor_state, legal_actions)`、`ACTION_LABEL(chosen_action)`、`TRANSITION_MODEL_INPUT(observation, visitor_state, chosen_action, delta_t_min)`、`TARGET`、`AUDIT`、`METADATA`。真实 `delta_t_min` 只在动作结束后可用，禁止输入当前动作选择策略。

30 个 Episode、15 条固定时间轨迹的校准前验证批次含 71 条决策样本，WAIT=0，early exit=28/30。原始 T4 倾向中疲劳和时间项各为 0.35，随决策点叠加过快。游客画像参数版本升为 `visitor-p1.2`，将疲劳/剩余时间/恶劣天气/已完成游览贡献改为 0.12/0.12/0.04/每项 0.01；`early_exit_base` 仍为原有 T4 范围，所有项仍为 `ASSUMPTION`，不宣称真实离园比例。仅在 C 合法动作中没有立即可执行的游览目标时，rollout 推荐合法 WAIT，避免任意注入等待。

相同配置复核得到 128 条决策样本，VISIT_POI=62、ATTEND_EVENT=15、REST=19、WAIT=3、EXIT=29；提前离园 20/30，1 条 Episode 时间耗尽；Reward 无越界。环境轨迹延长至 24 个 5 分钟步后共有 360 条样本，5/15/30/60 分钟有效目标为 360/330/285/195，覆盖率分别为 100%/91.67%/79.17%/54.17%。这些数值仅用于合成数据覆盖检查，不是景区实际行为统计。正式训练数据量仍需后续质量报告评估。
