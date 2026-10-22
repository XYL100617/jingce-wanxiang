# B模块规则规划与协作接口

## 当前结论

B 不需要等待 A 的动态状态服务即可开发。`server/planner/` 只依赖统一协议对象，并用 `createMockScenario()` 提供固定、可重复的正常、排队突增和道路关闭场景。A 的真实输出准备好后，替换 HTTP 请求中的 `graph`、`state`、`forecast` 即可，规划算法无需修改。

## B已实现范围

- `forecast.js`：按预计到达时刻线性插值查询排队和道路通行时间；道路可用性采用阶梯值。
- `astar.js`：按道路预测和关闭状态计算节点序列、道路序列、距离和通行时间。
- `rules.js`：生成 `VISIT_POI`、`ATTEND_EVENT`、`REST`、`WAIT`、`EXIT`，执行硬约束检查并推进游客副本。
- `planner.js`：Beam Search 生成二至四步游程、主方案、备选方案、得分、偏好匹配度和推荐理由。
- `preference-engine.js`：把完整问卷转换为八维连续权重、软评分参数与步行/排队硬约束。
- `mock-scenario.js`：提供不依赖 A 的固定样例。
- `/api/b/plan`：接收协议数据并返回 `PlanResult`。
- `/api/b/replan`：接收 `UserEvent`，从当前时间和位置重规划。
- `docs/contracts/b-planner.schema.json`：A/B/C 共用的机器可读契约草案及事件枚举。

## B 已支持的滚动重规划事件

- `SKIP_TARGET`、`REQUEST_REPLAN`
- `POSITION_UPDATE`、`PROGRESS_UPDATE`
- `POI_CLOSED`、`QUEUE_UPDATE`
- `ROAD_CLOSED`、`ROAD_OPENED`
- `EVENT_CANCELLED`、`EVENT_MISSED`

事件会先作用于状态或预测副本，再从事件发生时的真实节点和时间重新执行硬约束、A* 与 Beam Search；B 不回写 A 的权威状态。

## A需要共同确认的字段

A 只需确认并稳定以下契约，不需要把内部状态对象交给 B：

1. `ScenicGraph.nodes[].node_id` 与 `edges[].edge_id/from_node_id/to_node_id`。
2. `pois/events/facilities/exits` 中业务 ID 到 `node_id` 的映射。
3. `ScenicState.timestamp`、`visitor.current_node_id`、`remaining_time_min`、`fatigue` 和已访问集合。
4. `poi_states[poi_id].is_open/current_queue_min` 与 `road_states[edge_id].available/travel_time_min`。
5. `EnvironmentForecast.poi_predictions[poi_id][]` 和 `road_predictions[edge_id][]` 的时间粒度。
6. 三个对象的 `schema_version`、`scenario_id`，以及状态和预测版本号。

当前 B 约定：时间字符串使用 `YYYY-MM-DD HH:mm:ss`；数值预测做线性插值；道路 `available` 使用最近一个不晚于查询时刻的值。若 A 采用其他规则，应在协议版本升级时共同修改查询层，而不是改搜索算法。

## C可以直接使用的字段

C 不需要调用 B 的内部搜索对象，只读取 `PlanResult`：

- `next_action`：下一动作和目标 ID；
- `itinerary[]`：动作顺序、预计到达、预计排队、开始和完成时间；
- `current_route.node_sequence/edge_sequence`：当前路线绘制依据；
- `alternative_plans[]`：备选路线和得分；
- `reason`：推荐理由；
- `based_on_state_version/based_on_forecast_version`：联调问题定位。

C 产生 `SKIP_TARGET` 或 `REQUEST_REPLAN` 事件后调用 `/api/b/replan`，必须带当前 `ScenicState`，B 才能保证从游客真实位置而不是入口重规划。

## 暂时不要改动的代码

- 不要继续在 `server/index.js` 的 `makeRoutes()` 中增加 B 的规则；它是旧演示链路，后续应由适配器逐步替换。
- 不要把地图坐标、DOM 元素或 Leaflet 对象传入规划器。
- 不要在 B 内生成排队预测或修改 A 的权威状态；B 只查询预测并推进游客副本。
- 不要让 C 重新计算最短路；C 按 `edge_sequence` 和 `node_sequence` 展示。

## 下一轮共创顺序

1. A、B 共同评审并冻结 `docs/contracts/b-planner.schema.json` 和时间插值规则。
2. C 用内置 `PlanResult` 完成 `show_plan` 与 `replace_route`。
3. A 将正常、排队突增、道路关闭三组真实样例接入 `/api/b/plan`。
4. 三人共同跑 `npm test` 和六个验收场景，再把旧 `makeRoutes()` 调用迁移到新接口。
