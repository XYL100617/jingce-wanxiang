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

**路网与速度**：边有效速度可取 `v=max(v_min, min(v_visitor,v_base) × f_crowd(density) × f_weather(weather))`，`travel_time=length/v`；封闭边禁止新进入并通知 C 的 `road_states[edge_id].available=false`，恢复事件之后才可再次进入。拥挤、天气和个体速度因子应有宽范围且可追踪；图中 `distance_m/base_travel_time_min` 是示意估计，不可用于现实安全结论。若游客已在封闭边，需单独定义可完成通过、原路撤回或强制中止的事件策略与计数。

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
