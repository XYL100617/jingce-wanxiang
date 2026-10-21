# 景策万象

基于轻量化世界模型的景区全程自适应游览决策系统演示工程。保留“大宋武侠城”作为示例数据，同时将景区接入、图结构和知识库设计为通用接口，可迁移到其他景区。

## 运行

```powershell
cd D:\jingcewanxiang
npm.cmd start
```

浏览器打开 `http://localhost:4173`。

项目不依赖外部 npm 包，安装 Node.js 后无需额外安装依赖。执行 `npm.cmd test` 运行契约测试和隔离端口上的真实 HTTP 测试；需要改用其他端口时，在 PowerShell 中先设置 `$env:PORT = '4180'` 再启动服务。后端使用 Node.js 原生 HTTP 服务，适合在比赛现场或无网络环境中演示。字体使用了 Google Fonts 的渐进增强引用；即使无法访问外网，系统仍可正常运行。

## 系统结构

- `server/index.js`：HTTP 服务、API 分发、旧 Demo 兼容层、偏好学习、Pareto 候选路线和滚动重规划；景区图和初始状态位于 `server/data/`，预测逻辑位于 `server/state/`。
- `public/index.html`：面向游客的智能伴行助手，按原项目结构包含首页、虚拟伴侣、实时导航、应急管理、个性化路线、路线 DNA、个人中心七个模块。
- `public/styles.css`：响应式视觉系统，支持桌面和移动端展示。
- `public/app.js`：前端状态管理、Leaflet 真实底图与景区步行图层、路线图、预测曲线、问卷和动态事件交互。

## 已实现演示链路

1. 游客模块包括个性化路线、实时细粒度导航、虚拟伴侣、应急管理和路线 DNA。
2. 系统算法单独作为内部决策中枢：偏好学习、轻量化图世界模型、分层规划和滚动重规划，不与游客模块混用。
3. 环境状态包含人流、排队、天气、活动与道路图；游客状态单独维护位置、剩余时间、已游项目和舒适负荷。
4. 轻量化图世界模型对未来 15/30/60 分钟的人流、排队与游客舒适负荷做滚动推演，并输出置信度与不确定性。
5. 上层规划器生成效率偏、均衡偏、体验偏三条 Pareto 代表路线。
6. 下层细粒度导航输出点到点的路段、时间、遮阴、座椅和拥挤提示。
7. 虚拟旅伴使用景区知识库回答问题，并与当前位置和下一目的地联动。
8. 路线 DNA 支持种子广场、Copy DNA 和按偏好变异。
9. 应急模式支持暴雨、拥挤预警和 SOS，个人中心展示授权与隐私设计。

实时导航使用 Leaflet 加载 OpenStreetMap 真实底图，演示中心定位在大宋武侠城（开封，约 34.82065, 114.34426），叠加景区步行图、实时人流、舒适度和事件图层。景区内部景点点位和路段仍应由景区 GIS/测绘数据校准后替换，当前代码提供了通用图结构适配层。

## 后续接入真实数据

真实项目中可将 `server/data/current_state.json` 中的初始状态替换为景区管理系统、闸机、摄像统计、天气、活动排期和用户授权反馈数据；当前接口已经预留了 `/api/replan`、`/api/preferences`、`/api/feedback` 和 `/api/simulate-event`，便于逐步接入真实服务。

## A 模块：景区状态与模拟环境

当前仓库实际运行目录是 `D:\jingcewanxiang`。在该目录执行 `npm start` 启动演示，执行 `npm test` 运行 Node.js 内置断言编写的契约测试。

- `server/data/scenic_graph.json` 是唯一的景区图源。节点有统一 `node_id`，POI 另有 `poi_id`，道路有 `edge_id`、距离、基础时间和方向。`stateProvider` 从中生成旧网页所需的数组式 `graph.edges`。

静态图中的 `area_id` 标识区域，`access_roles` 标识节点承担的通行角色。第一版复用 `market`、`juxianzhuang`、`summit` 作为水浒区、仙侠区、江湖艺术区的入口代理，不代表新增或确认了独立物理入口；`gate` 和 `southgate` 均标记为可进园、可出园。

- `server/data/current_state.json` 是服务启动时加载的初始 `ScenicState`，包含游客、天气、POI、道路和活动状态。状态更新会增加 `state_version`；对外读取返回副本。
- `server/state/forecastSimulator.js` 生成所有 POI 和道路的 `EnvironmentForecast`。第一版使用可重复的规则模拟，没有训练神经网络世界模型。未来只需替换该文件内部实现，B 和 C 读取的图、状态、预测及查询接口无需改变。
- `server/data/scenarios.json` 配置 NORMAL、QUEUE_SPIKE、ROAD_CLOSE 及 ROAD_SLOWDOWN。`scenarioEngine` 记录场景事件，支持未来排队突增、道路关闭和减速。
- `forecastQuery` 的 `queryQueue(forecast, poiId, arrivalTime)` 和 `queryTravelTime(forecast, edgeId, enterTime)` 按预计到达时间查询；数值线性插值，`available` 保持离散状态。未知 ID、非法时间和超出预测范围会报明确错误。

当前状态保存在服务进程内存中。正式服务运行时每 12 秒执行一次环境更新：沿最近一次外部状态变更后的预测基准计算下一分钟的值，再把该分钟的 POI 排队时间、拥挤比例、拥挤等级和开放状态，以及道路通行时间和可用状态写回当前状态，同时把模拟时间推进一分钟。这样逐分钟推进不会反复以已舍入的数值为基准；外部状态变更时会重新建立预测基准。读取未来预测不会提前改写当前状态；未来事件到达生效时间后才影响定时更新写回的值，即时生效的事件可在提交时更新当前状态。POI 开放状态目前沿用当前值，没有营业时间自动调度。当前没有定时更新游客位置、剩余游览时间、疲劳、已访问景点、用户偏好、天气或演出状态的逻辑；其中部分字段可由现有用户操作接口更新。运行期间的内存更新不会自动写回 `current_state.json`，服务重启后从该初始文件重新加载，当前版本不保证持久保存运行期间的全部状态。

`EnvironmentForecast` 的 `base_timestamp` 是预测基准时间，`horizon_min` 是从该时刻起的预测范围，起点和终点都包含在采样结果中。`step_min` 是常规采样网格的分钟间隔；范围内的事件开始和结束时刻也会加入采样点，并按时间排序、去重。因此事件发生后，相邻预测点的间隔可以小于 `step_min`。例如基准时间后第 17 分钟开始的事件会增加 `offset_min: 17`。事件的生效区间为 `[timestamp, end_time)`：开始时生效，结束时不再生效。

道路预测的 `available` 表示对应时刻能否通行，路径使用方必须先检查该布尔值。道路关闭时 `travel_time_min` 仍是数值，表示按当前道路通行时间及预测规则计算的参考时间，不代表游客可以实际通行或据此规划路线。`queryTravelTime` 返回这两个字段；它对通行时间做数值插值，对 `available` 使用当前采样点的离散状态，不会将关闭道路视为可通行。

预测以静态图的 `poi_id`、`edge_id` 分别作为 `poi_predictions`、`road_predictions` 的键。每个点的 `timestamp` 等于 `base_timestamp` 加 `offset_min` 分钟；`horizon_min` 是预测终点，`step_min` 是基础采样间隔。按预计到达时间调用 `queryQueue`、按预计进入道路时间调用 `queryTravelTime`；时间落在采样点之间时，数值线性插值，布尔状态取左侧采样点。未知 ID、非法时间或超出预测范围会返回错误。

旧版固定候选路线和导航现在从同一份当前状态生成规划用预测，并按累计行程时间查询道路可用性与预计通行时间；候选路线还按预计到达时间查询景点排队与拥挤程度，纳入评分。规划内部使用 240 分钟范围以覆盖多站候选路线，公开预测接口仍默认 `horizon=60&step=10`。关闭道路不会进入路线，减速会改变预计路段耗时或路径选择，未来排队会改变候选路线评分；如果没有可行路径，导航返回 HTTP 409 和 `No feasible route`。导航路段保留原字段，并增加 `edge_id` 供调用方识别道路。

正式 API：

```text
GET  /api/v1/scenic-graph
GET  /api/v1/state
GET  /api/v1/environment-forecast?horizon=60&step=10
GET  /api/v1/query-queue?poi_id=theater&arrival_time=2026-10-20T10:43:00Z
GET  /api/v1/query-travel-time?edge_id=edge_001&enter_time=2026-10-20T10:48:00Z
POST /api/v1/scenario-event  {"event_type":"QUEUE_SPIKE","target_id":"theater"}
POST /api/v1/scenario-event  {"event_type":"ROAD_CLOSE","target_id":"edge_001"}
POST /api/v1/scenario-event  {"event_type":"ROAD_SLOWDOWN","target_id":"edge_001"}
```

### A 模块对接字段清单（当前 `schema_version: "0.1"`）

以下字段按当前接口实际返回值列出，供 B、C 直接读取；未标“可选”的字段在当前数据和接口生成的对应对象中均有值。`node_id` 标识路网节点，`poi_id` 标识景点或设施，`edge_id` 标识道路；预测字典分别以 `poi_id` 和 `edge_id` 为键。服务生成的时间使用 UTC 的 `YYYY-MM-DD HH:mm:ss` 字符串；时间参数也接受 `YYYY-MM-DDTHH:mm:ssZ`，查询结果中的 `arrival_time`、`enter_time` 保留传入的字符串。`algorithm_x`、`algorithm_y` 是算法坐标，不是 GPS 经纬度。

**`GET /api/v1/scenic-graph`：静态景区图**

| 层级 | 字段与类型 | 含义 |
| --- | --- | --- |
| 顶层 | `schema_version: string`、`nodes: Node[]`、`edges: Edge[]` | 图版本、节点和道路数组。 |
| `Node` | `node_id: string`、`id: string`、`name: string`、`type: string` | 节点 ID、旧版展示 ID、名称和节点类型；当前 `id` 与 `node_id` 相同，`type` 包括 `gate`、`scenery`、`culture`、`show`、`view`、`service`。 |
| `Node` | `poi_id?: string`、`area_id?: string`、`access_roles?: string[]` | 可选的 POI ID、区域 ID、通行角色；园门无 `poi_id`，当前角色值为 `PARK_ENTRANCE`、`PARK_EXIT`、`AREA_ENTRANCE`。 |
| `Node` | `algorithm_x: number`、`algorithm_y: number`、`capacity: number`、`shade: number`、`tags: string[]` | 算法坐标、容量、遮阴值和标签。 |
| `Edge` | `edge_id: string`、`from_node_id: string`、`to_node_id: string` | 道路 ID 和两端的 `node_id`。 |
| `Edge` | `distance_m: number`、`base_travel_time_min: number`、`shade: number`、`direction: string` | 米数、基础分钟数、遮阴值和方向；当前数据均为 `BIDIRECTIONAL`。 |

**`GET /api/v1/state`：当前状态 `ScenicState`**

可选查询参数 `timestamp`、`visitor_id` 只能匹配当前内存状态的时间和游客 ID；此接口不提供历史状态。返回对象如下：

| 层级 | 字段与类型 | 含义 |
| --- | --- | --- |
| 顶层 | `schema_version: string`、`scenario_id: string`、`state_version: string`、`timestamp: string` | 协议版本、场景 ID、随状态更新递增的版本、当前模拟时间。 |
| 顶层 | `visitor: Visitor`、`weather: Weather`、`poi_states: Record<poi_id, PoiState>`、`road_states: Record<edge_id, RoadState>` | 游客、天气、各 POI 和各道路的当前状态。 |
| 顶层 | `event_states: Record<event_id, EventState>`、`feedback: object[]` | 演出/活动状态和用户反馈记录。 |
| 顶层 | `legacy_crowd: Record<string, number>`、`legacy_queues: Record<string, number>`、`scenario_events?: ScenarioEvent[]` | 旧版展示兼容数据；`scenario_events` 在提交场景事件后出现，记录预测用异常事件。B、C 判断 POI 和道路状态应使用 `poi_states`、`road_states`。 |
| `Visitor` | `visitor_id: string`、`current_node_id: string`、`remaining_time_min: number`、`fatigue: number`、`walked_distance_m: number`、`visited_poi_ids: string[]` | 游客 ID、当前位置节点、剩余分钟、疲劳值、已走米数、已访问的 POI ID。 |
| `Visitor` | `preference: null \| object` | 初始值为 `null`；经现有偏好接口设置后，对象包含 `time`、`interest`、`comfort`、`freedom`、`culture` 五个数值权重。 |
| `Weather` | `label: string`、`temp: number`、`uv: number`、`rain: number` | 天气描述、温度、紫外线值、降雨值。 |
| `PoiState` | `open: boolean`、`queue_min: number`、`crowd_ratio: number`、`crowd_level: string` | 是否开放、当前排队分钟、拥挤比例、拥挤等级（当前使用 `LOW` / `MEDIUM` / `HIGH`）。 |
| `RoadState` | `available: boolean`、`travel_time_min: number` | 当前是否可通行、当前通行分钟数；规划时必须先判断 `available`。 |
| `EventState` | `event_id: string`、`node_id: string`、`status: string`、`start_time: string`、`latest_entry_time: string`、`capacity: number`、`title: string` | 演出/活动的节点、状态、开始及最晚入场时间、容量、标题；当前不自动推进演出状态。 |
| `ScenarioEvent` | `event_id: string`、`event_type: string`、`target_id: string`、`timestamp: string`、`end_time: string`、`severity: string`、`multiplier: number` | 已注入异常事件及其生效区间 `[timestamp, end_time)`。 |

**`GET /api/v1/environment-forecast?horizon=60&step=10`：未来环境预测**

`horizon`、`step` 是可选的分钟数，默认分别为 60、10；返回对象及每个预测点的全部字段如下：

| 层级 | 字段与类型 | 含义 |
| --- | --- | --- |
| 顶层 | `schema_version: string`、`scenario_id: string`、`state_version: string`、`forecast_version: string` | 协议、场景、预测所依据的状态版本、预测结果版本。 |
| 顶层 | `base_timestamp: string`、`horizon_min: number`、`step_min: number` | 预测起点、覆盖分钟数、基础采样间隔；事件边界可额外插入采样点。 |
| 顶层 | `poi_predictions: Record<poi_id, PoiPoint[]>`、`road_predictions: Record<edge_id, RoadPoint[]>` | 当前静态图全部 POI 和道路的预测序列。 |
| `PoiPoint` | `offset_min: number`、`timestamp: string`、`queue_min: number`、`crowd_ratio: number`、`crowd_level: string`、`open: boolean` | 相对基准分钟、该点时间、排队分钟、拥挤比例/等级、开放状态。 |
| `RoadPoint` | `offset_min: number`、`timestamp: string`、`travel_time_min: number`、`available: boolean` | 相对基准分钟、该点时间、预计通行分钟、可用状态。关闭道路仍保留数值型参考通行时间。 |

**按预计到达时刻查询与事件提交**

| 接口 | 请求字段 | 成功返回的全部字段 |
| --- | --- | --- |
| `GET /api/v1/query-queue` | `poi_id: string`、`arrival_time: string`；可选 `horizon: number`、`step: number` | `poi_id: string`、`arrival_time: string`、`queue_min: number`、`crowd_ratio: number`、`crowd_level: string`、`open: boolean`、`forecast_version: string`。 |
| `GET /api/v1/query-travel-time` | `edge_id: string`、`enter_time: string`；可选 `horizon: number`、`step: number` | `edge_id: string`、`enter_time: string`、`travel_time_min: number`、`available: boolean`、`forecast_version: string`。 |
| `POST /api/v1/scenario-event` | JSON：`event_type: string`（`QUEUE_SPIKE`、`ROAD_CLOSE`、`ROAD_SLOWDOWN`）、`target_id: string`（建议显式提供；前两种事件未提供时使用场景默认目标，`ROAD_SLOWDOWN` 须提供）；可选 `timestamp: string`、`duration_min: number`、`end_time: string`、`severity: string`（`low` / `medium` / `high`） | `state: ScenicState`、`forecast: EnvironmentForecast`；事件记录写入 `state.scenario_events`。 |

两项时间查询均基于请求时的当前状态生成预测；数值在相邻预测点间线性插值，`open`、`available` 和 `crowd_level` 取左侧预测点，恰好到达下一点时改用该点。错误响应统一含 `error: string`：参数或时间格式/范围错误返回 HTTP 400，未知 POI、道路或游客 ID 返回 HTTP 404；服务内部异常返回 HTTP 500。调用方不能仅凭关闭道路的 `travel_time_min` 判断其可通行。

### 第一版交接与样例

`server/examples/normal_state.json`、`normal_forecast.json` 分别是初始状态和正常预测的完整响应；`queue_spike_event.json`、`road_close_event.json` 是事件请求；`invalid_event.json` 是无效事件请求。`http_integration.json` 是隔离服务实际 HTTP 响应的精简摘录：排队突增的生效前、期间、结束后及非目标 POI 对照，道路关闭的开始/结束边界和绕行，道路减速的预计时间与路线变化，以及非法预测参数和事件请求的状态码、错误结构。它采用初始演示状态作为固定基准；`npm.cmd test` 会复核样例与当前 HTTP 响应一致。

HTTP 测试直接在 `127.0.0.1` 的随机端口启动隔离服务，不向已运行的演示服务提交事件，也不启动正式服务的自动推进定时器。`/api/snapshot` 等旧接口继续从同一状态和图生成演示数据；`lightWorldModel()` 是第一版规则模拟的旧网页展示兼容层。

第一版暂缓游客位置、剩余时间、疲劳、已访问 POI 的完整自动维护和演出生命周期调度；未接入实时客流，预测仍为可重复的规则模拟。景区算法坐标、实际道路方向及运营入口规则需要现场数据校准，当前不代表真实测绘结果。
