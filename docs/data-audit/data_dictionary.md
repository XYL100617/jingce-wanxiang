# 景策万象当前数据字典

根目录：`D:\jingcewanxiang-2`；审计日2026-10-26（Asia/Shanghai）；HEAD `cc93dd3c9d0239d6b6385f71b6a3978124031302`。本字典记录现有字段，不向业务JSON新增字段。

“必填依据”：Schema=当前b-planner.schema.json的required；代码=现有调用链读取或校验；现存=快照有值但不意味着接口强制；生成=函数固定输出；可选=未强制。未写必填的业务属性不能当已完整校验。

时间约定：SPACE=`YYYY-MM-DD HH:mm:ss`，仓库服务代码按UTC解释；ISO=`YYYY-MM-DDTHH:mm:ss.sssZ`，部分输入允许偏移。格式兼容不代表时区来源已核实。`-`表示不适用；UNKNOWN表示当前仓库无法确认。没有来源证据的坐标全部REFERENCE_ONLY，仅作为参考/算法/渲染用途，不得宣称为实测经纬度。

## 1 实体与ID命名空间

静态图把POI属性嵌入node：45个node，41个带poi_id且全部与node_id同值。B适配图才将pois/events/facilities/exits分开，并各自保存node_id外键。`node_id`代表图顶点，`poi_id`代表游览实体，`event_id`代表活动，`facility_id`代表设施，`edge_id`代表道路；同值不等于实体类型相同。CSV以`entity_type + canonical_id`联合识别。

当前没有独立的`entrance_node_id`或`poi_entrances`表。B的`poi.node_id`是等价的“到达目标节点”关系，但没有证据证明该节点就是现场可进入的实际入口。前端Canvas的forecourt坐标只解决绘图锚点，不能补足业务入口证据。

## 2 node 节点

含义：规划图顶点。实际位置：server/data/scenic_graph.json.nodes；public/c-demo-graph.json副本；B live-adapter.graph.nodes；mock-scenario.js.nodes。证据：stateProvider.js、live-adapter.js:15–38、astar.js。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| node_id | string | Schema/代码 | 稳定图节点标识 | - | - | 当前45个唯一非空ID | edge两端、visitor.current_node_id、业务node_id引用 | 图索引与路径 | raw同时保存id；无独立ID生命周期表 |
| id | string | 现存 | 旧前端展示标识 | - | - | 当前全部等于node_id | 旧graph.nodes[].id | 兼容层间接使用 | B Schema未定义；不能另造私有ID |
| poi_id | string | 可选/现存41节点 | 节点内嵌POI关联 | - | - | 非园门节点有；当前同node_id | poi_states与poi_predictions的键 | 经适配后识别POI | 静态结构没有独立poi实体表 |
| name | string | 现存 | 当前图中的中文显示名 | - | - | 以当前文件值为准 | 映射CSV规范名 | 解释/交接；算法不靠名称连接 | 官方名称证据UNKNOWN；适配Node丢弃name |
| type / node_type | string | 现存/可选 | 节点类型 | - | - | raw:gate/scenery/culture/show/view/service；B字段node_type | 影响POI/设施/演出派生 | 候选类型判定 | raw type→B node_type重命名；show不等于有演出时刻 |
| algorithm_x / algorithm_y | number | 现存/Schema可选 | 归一化算法参考位置 | 无物理单位 | - | 脚本x=源图x/25.6；y=源图y/5，四舍五入2位 | 按node_id映射渲染nodes | 邻近排序/A*启发式 | REFERENCE_ONLY；两轴不同缩放，不是米/GPS |
| capacity | number | 现存 | 演示容量参数 | 人数式含义；真实口径UNKNOWN | - | 园门999等文件值 | 可用于显示crowd_ratio×capacity | B适配未保留 | 非现场服务率/容量证据 |
| shade | number | 现存 | 遮阴/舒适参考参数 | 无量纲 | - | 代码按0–1使用 | 进入POI comfort_score及道路提示 | 评分间接使用 | 标注/测量方法UNKNOWN |
| tags | string[] | 现存 | 文化、兴趣或功能标签 | - | - | 如文化/美食/演艺/亲子 | 偏好标签匹配 | 效用特征 | 非受控词汇表；类别和标签语义可重叠 |
| area_id | string | 现存 | 六个示意片区标识 | - | - | wuxia_film/shili_foreign/water_margin/pastoral/xianxia/jianghu_art | 前端data-area-id | 当前评分不直接消费 | 片区真实边界UNKNOWN |
| access_roles | string[] | 可选 | 园门/区域入口代理角色 | - | - | PARK_ENTRANCE/PARK_EXIT/AREA_ENTRANCE | 生成exit_*；部分POI兼任区域入口 | 出口候选 | 代理角色不能证明实际物理入口 |
| location_source | string | 现存 | 位置来源标签 | - | - | 45节点均hand_map_reference | 绑定节点几何 | 来源限制 | 仅REFERENCE_ONLY；没有原图URL/许可 |

## 3 edge / road 道路

含义：两个图节点之间的业务连接。实际位置：scenic_graph.json.edges；B adapter.graph.edges；state.road_states与forecast.road_predictions保存动态属性。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| edge_id | string | Schema/代码 | 道路主键 | - | - | edge_001至edge_068，唯一 | road_states/road_predictions/layout.edges的键 | A*边索引、路线输出 | mock使用edge_gate_*独立命名空间 |
| from_node_id / to_node_id | string | Schema/代码 | 道路两端 | - | - | 均引用当前合法节点 | →nodes.node_id | 构造邻接表 | 端点当前均正确；无实际入口精度证明 |
| distance_m | number | Schema/代码 | 道路参考长度 | 米 | - | 当前40–1115；Schema允许0 | 边的几何/路径距离累计 | total_distance_m | 值来自渲染折线×0.82估算，不是实测；代码校验未充分拒绝负值 |
| base_travel_time_min | number | Schema | 基础通行耗时 | 分钟 | - | 当前1–14.87；Schema要求>0 | forecast与当前road_state默认 | A*启发式、缺失回退 | 脚本按distance/75生成；75米/分钟为示意假设 |
| shade | number | 现存/可选 | 道路遮阴参考 | 无量纲 | - | 按0–1显示 | 路径提示 | 当前B A*不以shade硬约束 | 测量来源UNKNOWN |
| direction | string | raw现存 | 原始图方向 | - | - | 68条均BIDIRECTIONAL | adapter→bidirectional | 经适配使用 | 不要把raw直接送A*后假定所有方向已受约束 |
| bidirectional | boolean | B可选 | 是否双向 | - | - | adapter根据direction生成；A*只在false时禁止反向 | from/to邻接 | A*方向性 | 未提供默认双向；raw direction和B布尔不同 |
| road_class | string | raw现存 | 绘图道路等级 | - | - | main_walkway/footpath | layout主次道路 | B适配未保留 | 视觉等级不等于通行许可 |
| location_source | string | 现存 | 几何来源 | - | - | 全部hand_map_reference | edge对应示意折线 | 来源约束 | REFERENCE_ONLY |
| metric_source | string | 现存 | 长度/耗时估算方法标签 | - | - | 全部schematic_polyline_estimate | 由迁移脚本重写 | 判断能否当真实成本 | 无误差/测量日期 |
| road_states[edge_id].available | boolean | B Schema必填；raw现存 | 当前道路可用性 | - | - | 初值全true | →edge_id | 先过滤再查询成本 | 缺失在B中默认为可走；未来恢复和当前false采用保守AND |
| road_states[edge_id].travel_time_min | number | 可选/现存 | 当前道路通行成本 | 分钟 | - | 当前正值；Schema最低0 | →同edge_id | 查询缺失回退 | 无真实采集口径、未知值掩码 |

## 4 poi 景点实体及状态

含义：可执行VISIT_POI的业务目标。静态图内嵌41个poi_id；B live-adapter.graph.pois当前38个，排除了2个service和1个已有演出对应节点。位置：live-adapter.js:38–63及mock-scenario.js。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| poi_id | string | Schema | POI主键 | - | - | B live38个；raw内嵌41个 | poi_states/poi_predictions/visited_poi_ids | 动作target_id | 不能以静态POI数直接推断B游览候选数 |
| node_id | string | Schema/代码 | 到达该POI的目标节点 | - | - | 必须存在于nodes | →node.node_id | 路径终点 | 有外键但无独立entrance_node_id/入口证据 |
| category | string | 可选/生成 | 规划类别 | - | - | 美食/历史文化/自然/演出/综合 | 按raw.type和tags推导 | 偏好评分 | 不是静态原始字段；推导规则不是官方分类 |
| tags | string[] | 可选/生成 | 兴趣/体验标签 | - | - | 来自原始node.tags | preferenceFeatures | 评分 | 词表未独立版本化 |
| open_time / close_time | string | 可选/生成 | 访问开始/结束时间界限 | 时间点 | SPACE UTC语义 | live一律当日09:00/22:00；mock另定 | 使用state.timestamp日期 | 合法动作到达/完成检查 | raw未存营业时段；live值是构造默认，不是已核实营业时间 |
| visit_duration_min | number | 可选/生成 | 景点游览时长 | 分钟 | - | view15/show30/其他22；mock24/20 | 决定completion_time | 规则推进 | 默认规则；实测来源UNKNOWN |
| base_utility | number | 可选/生成 | 基础游览效用 | 评分 | - | live按type：27/32/24/22 | 动作评分 | Beam效用 | 无现实满意度解释或标签依据 |
| comfort_score / shade_score | number | 可选/生成 | 舒适参考特征 | 无量纲 | - | 来自node.shade；comfort Schema 0–1 | preferenceFeatures | 评分 | 两同义字段并存；shade_score未在Schema列出 |
| open / is_open | boolean | raw现存/B可选 | 当前是否开放 | - | - | raw open；B is_open | 以poi_id关联 | 合法性检查is_open===false | 适配转换明确；原始字段直传不被B识别 |
| queue_min / current_queue_min | number | raw现存/B可选 | 当前排队耗时 | 分钟 | - | 原始0–25；Schema>=0，无物理上界 | 以poi_id关联 | 预测缺失时回退 | 同义异名；缺失B静默按0 |
| crowd_ratio | number | raw现存 | 拥挤参考比例 | 无量纲 | - | 当前0.2–0.76；预测上限0.98 | →poi_id | B适配换算为数字level | 实际人数/容量分母和观测方法UNKNOWN |
| crowd_level | string / number | raw现存/B可选 | 拥挤分级 | 无量纲 | - | raw LOW/MEDIUM/HIGH；B ceil(ratio*4)且限制0–4 | →poi_id | B当前不作为硬约束 | Schema要求number；原始字符串不能直接按B协议验证 |

## 5 event 演出与运营事件

含义：演出目标和运营状态记录。raw current_state.event_states有show-1和market-peak；B仅将非forecast、非cancelled标记且节点type=show的记录派生为graph.events。位置：live-adapter.js:19–25、64–82；scenario事件另见第12节。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| event_id | string | Schema/现存 | 活动ID | - | - | show-1；market-peak为运营预测事件；mock event_show | 字典键必须与对象event_id一致 | ATTEND_EVENT target_id | 运营活动不都等于可参加演出 |
| node_id | string | Schema/现存 | 活动所在图节点 | - | - | show-1→theater；market-peak→market | →nodes.node_id | 演出路径终点 | 无独立演出入口node证据 |
| title | string | raw现存 | 运营活动名称 | - | - | 当前2条文件值 | event_id | 前端说明 | B graph.events未保留title |
| status | string | raw现存 | 运营状态文本 | - | - | 当前upcoming/forecast；代码另识别live/cancelled | 影响适配筛选和界面 | 间接判定 | 没有完整状态机或按时间自动调度 |
| start_time | string | raw现存/B可选 | 开始时刻 | 时间点 | SPACE UTC语义 | show-1 11:20；mock11:10 | 同event_id | 提前到达等待 | 源资料与演出排期采集日UNKNOWN |
| latest_entry_time | string | raw现存/B可选 | 最晚允许到达时刻 | 时间点 | SPACE UTC语义 | live show-1等于开始；mock提前5分钟 | 同event_id | arrival>latest时拒绝 | 两者均符合当前<=规则；是否真实运营规则UNKNOWN |
| end_time | string | B生成/可选 | 演出结束时刻 | 时间点 | SPACE UTC语义 | raw缺失；live默认start+30分钟 | 用于completion_time窗检查 | 合法性 | 来源为适配构造 |
| duration_min | number | B生成/可选 | 参加演出耗时 | 分钟 | - | live默认30；>=1 | 与end_time相配 | 规则推进 | 原始文件没有时长；不代表实测 |
| capacity | number | raw现存 | 运营事件容量参考 | 人数式含义，实际口径UNKNOWN | - | show-1 180；market-peak 220 | 可与node.capacity不同 | B适配未保留/未作容量检查 | 不能声称容量硬约束已实现 |
| is_open / cancelled | boolean | B可选 | 活动可用/取消标志 | - | - | 按原status和cancelled派生 | event_states[event_id] | 合法性 | 没有继承场地poi.open；cancelled=true被筛除后场地可回到普通POI |
| category / tags / base_utility | string / string[] / number | B生成 | 演出评分属性 | 标签/评分 | - | live:演出、[演出,预约]、38 | target event_id | 偏好/Beam | 硬编码规则，无标注来源 |

## 6 facility 与 exit

含义：休息设施和离园出口。业务实体在live-adapter.graph.facilities/exits生成；raw只通过type=service、access_roles或type=gate表达。前端f_*设施属于第15节视觉实体。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| facility_id | string | Schema | 业务设施ID | - | - | live rest/chaguan；mock facility_rest | →node_id；visited_facility_ids | REST target_id | 与poi_id当前同值但语义不同 |
| node_id | string | Schema/代码 | 设施/出口的图位置 | - | - | 必须存在nodes | →node.node_id | 路径目标 | 未现场核验实际入口 |
| facility_type | string | Schema | 设施功能 | - | - | 当前全为rest | 候选REST筛选 | 合法动作 | 不能从此推断医疗、卫生间等服务已进入规划 |
| rest_duration_min | number | 可选/生成 | 休息时长 | 分钟 | - | live15；mock15；Schema>=0 | 规则REST恢复 | stepByRules | 默认假设 |
| min_fatigue | number | 可选/生成 | 触发休息参考阈值 | 疲劳代理量 | - | live0.38；缺省代码0.4 | visitor.fatigue比较 | 候选REST | 不是健康阈值或真实测量 |
| base_utility | number | 可选/生成 | 休息评分 | 评分 | - | live7；mock6 | 评分 | Beam | 人工规则 |
| exit_id | string | Schema | 出口业务ID | - | - | exit_gate/exit_southgate/exit_westgate/exit_eastgate | →对应园门node_id | EXIT和返程检查 | 出口营业、方向、临时关闭无独立状态实体 |

## 7 visitor 游客状态

含义：当前游客决策状态及规划中的副本。位置：current_state.visitor；live-adapter.state.visitor；rules.stepByRules输出；mock样例。真实账号UUID和visitor_001未建立一对一隔离。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| visitor_id | string | raw现存/B可选 | 游客标识 | - | - | visitor_001 | 状态所属对象 | 复放/会话识别 | 单份共享演示标识；不是账号UUID |
| current_node_id | string | Schema/代码 | 当前图节点 | - | - | 初始gate；必须在图内 | →nodes.node_id | A*起点/重规划 | 只表达节点，无GPS或边上位置 |
| remaining_time_min | number | Schema | 剩余可游览时间 | 分钟 | - | 初始272；Schema>=0 | 相对state.timestamp | 可行性/返程 | leaveAt来自HH:mm输入，模拟日期和时区需一致 |
| fatigue | number | Schema | 规则疲劳代理量 | 无量纲 | - | 初始0.12；Schema[0,1] | 步行/排队增加，REST恢复 | 评分/候选休息 | 实际健康/疲劳采样UNKNOWN；入口validateInputs未严格校验 |
| walked_distance_m | number | raw现存 | 旧状态已行走距离 | 米 | - | 初始0 | 旧user.walked | B live-adapter未保留 | B推进累计的是cumulative_walk_min，非同字段 |
| visited_poi_ids | string[] | 现存/Schema可选 | 已访问景点集合 | - | - | 初始[]；应唯一 | →graph.pois[].poi_id | 候选与合法性都拒绝重复 | 未来服务/演出集合另存，不能混入 |
| preference | null / object | raw现存 | 原始游客八维偏好 | 权重 | - | 初始null；问卷后八维归一化 | preference-engine输出 | 适配成preference_weights | raw字段名与B不同 |
| preference_weights | object | B可选；存在时Schema要求8项 | B评分权重 | 无量纲 | - | time/interest/comfort/freedom/culture/nature/performance/food；各[0,1] | →PreferenceWeights | Beam偏好评分 | 初始适配输出{}违反8字段required；Schema本身未约束和=1 |
| preference_profile | object / null | B生成 | 完整问卷推断资料 | - | - | 初始null或preferenceProfile | 含约束和解释 | 间接提供规则 | Schema未详细定义 |
| preferred_categories | string[] | B可选/生成 | 偏好类别摘要 | - | - | 按权重排序前两类；无权重仍生成前两类 | POI/event.category | 无权重时匹配评分 | 初始不是实际作答结果 |
| attended_event_ids | string[] | B可选/生成 | 已参加演出 | - | - | 默认[] | →graph.events.event_id | 避免重复 | 原始初值未存，进度后可扩展 |
| visited_facility_ids | string[] | B可选/生成 | 已使用休息设施 | - | - | 默认[] | →graph.facilities.facility_id | 避免重复REST | 与visited_poi_ids不同 |
| current_plan_next_target | string / null | B生成 | 当前路线下一目标 | - | - | runtimeUser提供或null | 业务target_id | 改线成本 | 跨业务类型标识未带entity_type |
| require_rest | boolean | B可选/生成 | 画像要求至少一次休息 | - | - | 画像constraints.require_rest为true时启用 | 设施候选 | 强制先休息规则 | 含义比一般“沿途安排休息”更强，需B确认 |
| force_rest | boolean | 代码可选 | 主动强制休息 | - | - | true/false | 候选逻辑读取 | REST候选 | 未在初始文件和Schema中定义 |
| cumulative_walk_min / cumulative_queue_min | number | mock现存/step生成 | 累计步行/排队时间 | 分钟 | - | 初始0或缺省0 | 由动作耗时累积 | 轨迹/评分分析 | 不能替代walked_distance_m |
| action_count | number | step生成 | 规划副本已执行动作数 | 次数 | - | 整数递增 | 版本后缀/首动作判定 | 多步搜索 | 未在Schema定义 |
| missed_event_ids | string[] | step生成/事件生成 | 已错过演出 | - | - | 超过latest且未参加 | →event_id | 后续状态说明 | 与取消不同；EVENT_MISSED也把cancelled置true |
| next_legal_actions | Action[] | step生成 | 推进后可执行动作 | - | - | compute_next_actions=false时空数组 | 下一状态合法动作 | 回放/规则模拟 | 不是原始观察数据 |
| must_exit | boolean | step生成 | 结束或必须离园标志 | - | - | EXIT/剩余不足/无非EXIT动作 | 后续动作 | 终止判断 | 无出口可达时不是自动救援方案 |

## 8 ScenicState 顶层和天气

含义：某模拟时刻的景区环境及单游客状态。原始位置current_state.json、stateProvider；B位置live-adapter或mock。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| schema_version | string | Schema/代码 | 协议版本 | - | - | 当前0.1；三输入必须一致 | 图/状态/预测 | validateInputs | 不是graph_version |
| scenario_id | string | Schema/代码 | 场景标识 | - | - | demo_001；mock b_*_001 | 三输入一致 | 隔离样例/重规划 | raw graph无此字段，adapter补入 |
| state_version | string | Schema | 当前状态版本 | - | - | state_0001；setState递增；B副本加后缀 | PlanResult.based_on_state_version | 追溯 | 不是内容哈希或采集时间；重放事件后缀可重复 |
| timestamp | string | Schema | 当前模拟时刻 | 时间点 | SPACE UTC语义 | 初始2026-10-20 10:18:00 | 预测基准/规划起点 | 全部时间判断 | 产品显示未明确UTC/北京时间转换 |
| visitor | object | Schema/代码 | 单游客状态 | - | - | 见第7节 | current_node_id外键 | 决策状态 | 多人共享 |
| poi_states / road_states / event_states | object | raw现存/B Schema可选 | 按业务ID索引的状态 | 按子字段 | - | 键分别poi_id/edge_id/event_id | 与图关联 | 合法性和预测 | Schema没有要求所有图对象必须具备状态 |
| weather | object | raw现存 | 天气背景 | - | - | label/temp/uv/rain | 环境状态 | 当前B未直接消费 | 没有位置、观测源、测量时刻 |
| weather.label | string | 现存 | 天气文字 | - | - | 晴间多云 | - | 当前不用 | 来源UNKNOWN |
| weather.temp / uv / rain | number | 现存 | 温度/紫外线/降雨相关值 | UNKNOWN（代码未明确量纲和rain定义） | - | 27 / 6 / 0.08 | - | 当前不用 | 不能擅自将rain认定降雨毫米或概率 |
| feedback | object[] | raw现存 | 用户反馈数组 | UNKNOWN | at为ISO | 初始[] | 用户标识约束缺失 | 待确认 | 无固定反馈契约 |
| legacy_crowd / legacy_queues | object | raw现存 | 旧图中无poi_id对象的兼容值 | 比例/分钟 | - | gate/southgate等 | 旧node id | 旧导航兼容 | 不等于B所有POI状态 |
| scenario_events | object[] | 可选/事件生成 | 已注入环境事件 | 见第12节 | SPACE | 初始文件无，提交后生成 | target_id依类型映射 | 预测输入 | 不能与UserEvent混用 |

## 9 EnvironmentForecast 与查询结果

含义：规则生成的未来环境序列。位置：forecastSimulator.js、normal_forecast.json；B适配版本由live-adapter产生。原始预测保留41 POI；B只保留38个普通POI序列。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| schema_version / scenario_id | string | Schema/代码 | 协议与场景 | - | - | 0.1/demo_001或相应mock | 与图状态一致 | 输入校验 | 一致性不表示图拓扑版本已确认 |
| state_version | string | 原始生成 | 生成预测所用状态版本 | - | - | state_0001等 | →原始ScenicState | 追溯 | B不校验forecast.state_version与state.state_version匹配 |
| forecast_version | string | Schema | 预测标识 | - | - | forecast_+sha256前12位；mock固定ID | PlanResult.based_on_forecast_version | 追溯 | 重规划只追加事件名后缀，不自动重建基准 |
| base_timestamp | string | Schema | 预测起点 | 时间点 | SPACE | 通常等于state.timestamp | 每个point.timestamp | 按到达时刻查询 | 未来事件使state前进后，B仍可使用旧预测基准 |
| horizon_min | number | Schema | 声明预测范围 | 分钟 | - | 原始API整数0–1440；默认60，live规划600，mock90；B Schema仅>=0 | 相对base_timestamp | 有效范围 | mock实际只采样到40；B查询越界不拒绝 |
| step_min | number | Schema | 常规采样间隔 | 分钟 | - | 原始API整数1–1440；默认10；事件边界可加点；B Schema仅>0 | point序列 | 插值 | 不是所有相邻点严格相隔step |
| poi_predictions | object<string,Point[]> | Schema | 景点预测字典 | - | - | 键为poi_id；原始41/B38 | →POI | 预计排队 | B没有完整校验未知POI键 |
| road_predictions | object<string,Point[]> | Schema | 道路预测字典 | - | - | 键为edge_id，当前68 | →edge | 预计入边通行 | B检查未知道路键，但不强制完整覆盖 |
| point.timestamp / offset_min | string / number | timestamp Schema；offset原始生成 | 点时间与基准分钟偏移 | 时间点/分钟 | SPACE | 当前0/10/…/60；事件边界插点 | timestamp=base+offset | 查询 | B适配去掉offset，仅保留timestamp |
| point.queue_min | number | 可选/生成 | 预计排队时间 | 分钟 | - | Schema>=0；预测值为规则输出 | poi_id | 到达时刻插值 | 缺失回退当前值再缺失为0，不代表无排队 |
| point.crowd_ratio / crowd_level | number / string或number | 原始生成/B可选 | 拥挤比例及分级 | 无量纲 | - | 原始level为LOW/MEDIUM/HIGH；B为0–4 | poi_id | 当前主要评分/显示上下文 | 原始287个字符串level与B Schema数值型不一致 |
| point.open | boolean | 原始生成 | 未来POI开放标记 | - | - | 当前生成器恒等当前open | poi_id | B本应用于到达时可用性 | 适配时丢弃；B queryQueue/isActionLegal不读取 |
| point.travel_time_min / available | number / boolean | 可选/生成 | 未来道路成本/可用性 | 分钟/布尔 | - | 关闭时仍有正的参考耗时 | edge_id | 先判断available | 不能仅凭travel_time>0认定道路可走 |
| query.arrival_time / enter_time | string | 查询接口输入 | 到达POI/进入道路的预计时间 | 时间点 | SPACE或ISO | 正式查询校验时域 | poi_id/edge_id | 时间依赖查询 | 原始查询返回原输入字符串，故输出可混用SPACE/ISO |
| query.forecast_version | string | 查询生成 | 查询所用预测版本 | - | - | 同生成预测 | →forecast_version | 解释/追溯 | B queryQueue只返回数值，queryRoad只返回状态和耗时 |

## 10 Action、Route、ItineraryItem

含义：规划动作、图路径和动作执行时间表。位置：rules.js、astar.js、planner.js和b-planner.schema.json。Action的target_id按action_type解释。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| action_type | string | Schema | 动作种类 | - | - | VISIT_POI/ATTEND_EVENT/REST/WAIT/EXIT | 决定目标命名空间 | 候选/合法性/推进 | 没有显式MOVE动作；行走包含在动作路径 |
| target_id | string | Schema | 动作目标 | - | - | POI/event/facility/exit对应ID；WAIT通常wait | 按action_type选择业务表 | 检索定义 | 不能单靠target_id判断实体类型 |
| target_node_id | string | 生成/Itinerary Schema | 动作到达图节点 | - | - | 从业务definition.node_id覆盖得到 | →node_id | 路径终点 | Action基础Schema未列出但输出实际存在 |
| duration_min | number | Action可选代码读取 | WAIT动作指定时长 | 分钟 | - | 否则使用wait_duration_min=10 | WAIT | 规则推进 | Action Schema未列范围，负值入口未完整拦截 |
| route.reachable | boolean | A*生成 | 是否存在可行路径 | - | - | true/false | 该次起终点 | 合法性 | Route Schema未要求该字段 |
| route.node_sequence | string[] | Schema | 路径节点顺序 | - | - | 有边时节点数=边数+1 | →node_id | 绘制/执行 | Schema只检数组字符串，不检实际连通 |
| route.edge_sequence | string[] | Schema | 路径道路顺序 | - | - | 必须与节点逐段相连 | →edge_id | 绘制/封路检查 | 需要额外图外键和方向校验 |
| route.total_distance_m | number | Schema | 路径参考距离总和 | 米 | - | Schema>=0；应等于边distance_m求和 | 对应edge_sequence | 成本/解释 | public/c-demo-plan存在旧距离；不是实测 |
| route.travel_time_min | number | Schema | 预计行走时间 | 分钟 | - | Schema>=0 | 按预计入边时刻累计 | 时间推进 | 入边后跨封路开始的政策未定义 |
| route.reason | string | 不可达时生成 | 不可达原因 | - | - | 路网限制等文字 | 路径结果 | 拒绝原因 | Schema未细化 |
| itinerary.action_type / target_id / target_node_id | string | Schema | 每站动作及目标 | - | - | 同Action | 关联上述命名空间 | 行程执行 | 不可用名称代替ID |
| itinerary.visit_duration_min | number | 生成 | 该动作活动/游览/休息时长 | 分钟 | - | 从checked.duration_min | 对应业务定义 | 计算完成时间 | 名称虽visit，其他动作也使用 |
| itinerary.arrival_time / service_start_time / completion_time | string | arrival/completion Schema；service生成 | 到达、开始服务、完成时刻 | 时间点 | SPACE；Schema部分只约束string | 到达<=服务开始<=完成 | 由上一动作串联 | 闭环回放 | 演出早到等待；需跨站时间单调校验 |
| itinerary.travel_time_min / predicted_queue_min / wait_time_min | number | travel Schema；其余生成 | 步行、排队、演出前等待 | 分钟 | - | 应>=0 | 对应route/queue | 成本/时间 | 演出wait与排队分开；样例演出仍含排队22属于展示旧口径 |
| itinerary.route | Route | Schema | 到达该站的路径 | - | - | 见上述Route | 节点/道路引用 | 地图与导航 | 未包含全过程连续定位轨迹 |
| itinerary.preference_fit / preference_dominant_factor | number / string或null | 生成/可选 | 偏好匹配与贡献最大的维度 | 无量纲/文本 | - | fit按Schema[0,1]；dominant八维之一/null | 对应visitor权重 | 解释 | 运行时未通过Schema强制约束权重和 |
| itinerary.action_score | number | 生成/可选 | 动作评分 | 规则评分 | - | 可以为负 | 累计到方案score | Beam比较 | 不可当真实满意度 |

## 11 PlanResult 主备方案

含义：B给前端的统一规划结果。位置：planner.js:229–407；public/c-demo-plan.json为单独静态展示样例。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| schema_version / scenario_id | string | Schema | 协议与场景 | - | - | 同输入graph/state | 三输入身份 | 输出一致性 | 无独立graph_version |
| plan_id | string | Schema | 方案ID | - | - | plan_状态版本_main/alt_目标序列；展示c_demo_* | 账号路线历史/方案选择 | 选择方案 | 由状态名和目标串拼接，不是全局唯一内容哈希 |
| based_on_state_version / based_on_forecast_version | string | Schema | 输入版本记录 | - | - | 来自输入 | →state/forecast版本 | 可解释追溯 | public固定样例forecast_state_0001与实际hash预测不同 |
| generated_at | string | 生成 | 生成时的模拟时刻 | 时间点 | SPACE | state.timestamp | 非真实系统生成时钟 | 追溯 | Schema未细化 |
| next_action | Action / null | Schema | 下一动作 | - | - | 非空行程取第一站动作 | target_id按类型解释 | 导航/陪伴 | 不包含全部路径，另读current_route |
| itinerary | ItineraryItem[] | Schema | 完整动作列表 | - | - | 可为空 | 逐站Route | 执行/回放 | 仅格式合规不能保证样例时间和距离正确 |
| current_route | Route | Schema | 第一动作的路段路径 | 米/分钟 | - | 空方案为零长度空数组 | 第一站route | 当前导航 | 不是全行程合并路径 |
| score | number | Schema | 累计规则效用 | 评分 | - | 正负均可 | action_score累计 | 主备比较 | 不能解释为准确率/真实满意度 |
| score_breakdown.preference / cost | number | 生成 | 偏好项和其余评分累计 | 评分 | - | 按代码计算 | 同score | 解释 | cost包含除偏好以外各项，不纯是物理成本 |
| alternative_plans | object[] | Schema | 备选方案摘要 | - | - | 最多3个；有递归补备选逻辑 | plan_id/itinerary/current_route等 | 比较和切换 | Schema只声明array，未逐项约束备选结构 |
| alternative_status / alternative_message | string / string或null | 生成 | 备选是否可用及说明 | - | - | available/none_feasible | 相关约束 | 前端解释 | 不是运营事实 |
| reason | string | Schema | 推荐/不可达原因 | - | - | 规则生成文本 | 首站和约束 | 解释 | 文本须结合实际feasible/diagnostics理解 |
| feasible | boolean | Schema | 是否有非空行程 | - | - | 代码main.itinerary.length>0 | 与reaches_exit不同 | 前端流程 | 审计max_actions=1时可true而reaches_exit=false |
| diagnostics | object | 可选/生成 | 规则运行诊断 | - | - | 见下表 | 输出状态 | 验收 | 不是模型置信概率 |
| replan | object | replan生成 | 重规划触发记录 | - | - | trigger/event_timestamp/from_node_id | UserEvent及当前起点 | 解释改线 | Schema未列明 |
| selected_plan_id | string | 切换时生成 | 用户选定方案ID | - | - | promoteAlternative输出 | →主/备plan_id | 前端切换 | promote后原diagnostics没有按备选全部重算 |

## 11.1 PlanResult.diagnostics

实际位置：planner.js返回对象。以下字段均由代码生成，当前Schema仅把diagnostics定义为object。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| used_arrival_time_forecast | boolean | 生成 | 标记使用到达时刻查询 | - | - | 固定true | 查询层 | 功能说明 | 不代表预测时域或来源有效性已验证 |
| planned_action_count / useful_action_count / minimum_useful_actions | number | 生成 | 动作数、有用游览数和最低目标 | 次数 | - | 有用动作仅VISIT_POI/ATTEND_EVENT | itinerary | 验收 | REST/WAIT/EXIT不计有用游览数 |
| satisfies_minimum_actions | boolean | 生成 | 是否达到最低游览数 | - | - | useful>=minimum | 上述计数 | 质量判定 | feasible=true不保证此项true |
| rules_version | string | 生成 | 规则版本标签 | - | - | b-rules-0.2 | 代码规则 | 追溯 | 与schema0.1不是同一种版本 |
| alternative_count | number | 生成 | 备选数 | 次数 | - | 0–3 | alternative_plans | 展示 | 切换后诊断未必同步更新 |
| preference_weights_applied | boolean | 生成 | 是否存在权重键 | - | - | Object.keys长度>0 | visitor.preference_weights | 解释 | 不是完整性/归一化校验 |
| planned_end_time / unallocated_time_min | string / number | 生成 | 选定方案结束时刻/未分配分钟 | 时间点/分钟 | SPACE | 从main最终副本读取 | state.timestamp/remaining_time | 余量分析 | 不能与真实墙钟混用 |
| reaches_exit | boolean | 生成 | 方案搜索是否以EXIT结束 | - | - | main.ended===true | 出口动作 | 完整性判断 | 和feasible区分；没有到EXIT的方案仍可能保留返程余量 |

## 12 UserEvent 与 scenario 环境事件

含义：UserEvent是规划重算输入；scenario-event是环境模拟输入；C地图点击是第三种交互事件，三者不能直接互换。位置：planner.js:150–228、scenarioEngine.js、server/index.js。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| UserEvent.schema_version / scenario_id | string | Schema；代码存在时比较 | 事件协议/场景 | - | - | 应同state | →状态场景 | replan校验 | 代码允许省略，Schema要求；前端demo适配补入 |
| UserEvent.event_type | string | Schema/代码 | 规划事件种类 | - | - | SKIP_TARGET/REQUEST_REPLAN/POSITION_UPDATE/PROGRESS_UPDATE/POI_CLOSED/QUEUE_UPDATE/ROAD_CLOSED/ROAD_OPENED/EVENT_CANCELLED/EVENT_MISSED | 决定字段含义 | 重规划 | 不同于ROAD_CLOSE/QUEUE_SPIKE |
| UserEvent.timestamp | string | Schema可选/代码可选 | 事件时刻 | 时间点 | SPACE或代码可解析格式 | 未来时间推进剩余时长；过去时间仍会立即应用 | 相对state.timestamp | 重规划起点 | 无过时事件拒绝/去重/序号；日期校验比scenarioEngine宽松 |
| UserEvent.target_id | string | 依类型Schema/代码必填 | 跳过/关闭/队列/活动目标 | - | - | 按事件类型引用POI或event等 | →对应业务表 | 更新/排除目标 | PROGRESS_UPDATE可选，提供则必须与位置同一目标 |
| UserEvent.edge_id | string | 道路事件必填 | 受影响道路 | - | - | 必须有road_state | →edge_id | 封路/恢复 | 重算会将整个预测数组available置同值，忽略原生未来恢复安排 |
| UserEvent.current_node_id | string | 位置/进度事件必填 | 新位置 | - | - | 合法node_id | →node | A*起点 | 无真实GPS证据 |
| UserEvent.queue_min | number | QUEUE_UPDATE必填 | 更新排队值 | 分钟 | - | >=0；代码Number转换 | →target POI | 重算排队 | 所有预测点取max(新值,原值)，不是带生效时间的新观测融合 |
| UserEvent.remaining_time_min / fatigue | number | PROGRESS可选 | 上报剩余时间/疲劳代理量 | 分钟/[0,1] | - | remaining>=0；fatigue[0,1] | visitor | 进度更新 | 不是真实采集校准标签 |
| scenario配置.NORMAL | object | 静态现存 | 正常漂移参数 | 每小时 | - | queue_drift_per_hour1.2/crowd_drift_per_hour0.025/road_delay_per_hour0.04 | forecastSimulator | 间接使用 | 来源/校准UNKNOWN |
| scenario配置.QUEUE_SPIKE | object | 静态现存 | 排队突增 | 分钟/无量纲 | 相对基准分钟 | target theater/start20/duration45/queue+24/crowd+0.2 | target_id→POI | 事件测试 | 纯规则 |
| scenario配置.ROAD_CLOSE | object | 静态现存 | 封路 | 分钟 | 相对基准分钟 | target edge_001/start30/duration60 | target_id→edge | 封路边界测试 | 无真实运营记录 |
| scenario配置.ROAD_SLOWDOWN | object | 静态现存 | 道路减速 | 分钟/倍数 | 相对基准分钟 | start0/duration60/travel_time_multiplier1.8；target须请求提供 | →edge_id | 道路成本测试 | 低/中severity即时状态与预测恢复公式不一致，见报告 |
| ScenarioEvent.event_id / event_type / target_id | string | 生成 | 环境事件编号、类型、目标 | - | - | scenario_000N；QUEUE_SPIKE/ROAD_CLOSE/ROAD_SLOWDOWN | 按类型→POI/edge | 预测输入 | POI_CLOSE在一处判断中出现但配置无此类型，不能认定接口支持 |
| ScenarioEvent.timestamp / end_time | string | 生成；请求可选 | 环境事件生效区间 | 时间点 | SPACE，输入可ISO Z | [start,end)；end>=start；duration_min允许0 | 相对state.timestamp | 事件时刻插点 | 无公告时刻/采集时刻区分 |
| ScenarioEvent.severity / multiplier | string / number | 生成 | 强度与内部系数 | 无量纲 | - | low→0.5；medium→0.75；其他→1；默认high | 作用于规则参数 | 情景强度 | severity文本未限制枚举；减速即时写回未按multiplier缩放 |
| C交互.event_type / target_id / edge_id / node_id | string | C接口校验 | 点击和地图请求 | - | SPACE timestamp | POI_CLICK/ROAD_CLICK/MAP_REPLAN_REQUEST | →当前图ID | B只通过集成转成规划请求 | 不能套用UserEvent枚举或当游客执行动作 |
| mock.variant / scenario_id | string | 代码支持 | 固定样例选择 | - | - | normal/queue_surge/road_closure；b_*_001 | 独立mock图 | 隔离开发 | 不是正式景区历史场景编号 |

## 13 问卷、PreferenceProfile与规则配置

位置：public/app.js常量、server/preference-engine.js、docs/contracts/examples/preference-request.json。输出为规则推断画像，不是训练出的偏好模型。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| answers.type / group / mobility | string | 代码可选 | 节奏、同行与步行能力 | - | - | fast/normal/free；solo/friends/family/elderly；normal/light/minimal | 影响先验/约束 | 评分输入 | 未提供使用代码默认值 |
| answers.interests | string[] | 代码可选 | 兴趣选择 | - | - | culture/nature/performance/food/photo/interactive | 兴趣贡献矩阵 | 权重推断 | 未知兴趣项不贡献 |
| answers.queue_tolerance / walking_tolerance / schedule_preference / depth_preference / crowd_sensitivity / novelty_preference / rest_need / photo_preference | number | 代码可选 | 八项情境量表 | 1–5等级 | - | 1–5；代码部分clamp/default3 | SCALE_MATRIX | 权重与阈值 | 接口未统一强制原始类型；默认不等于真实回答 |
| leaveAt / current_node_id / exit_node_id | string | 请求可选 | 离园时刻、起点、选定出口 | 时间点/ID | leaveAt HH:mm | 起点合法node；出口为PARK_EXIT；空出口自动 | →node_id | 剩余时间与返程约束 | 离园时刻按当前模拟日计算，跨日语义由代码默认 |
| questionnaire_version | string | 生成 | 问卷规则版本 | - | - | 0.2 | 画像 | 追溯 | 不等同schema_version0.1 |
| weights / labels | object | 生成 | 八维归一化权重和中文标签 | 无量纲 | - | 八维总和按四舍五入修正约等于1 | PreferenceWeights | 评分 | Schema只查逐项范围，不查总和 |
| profile.archetype / group / mobility / interests / top_factors | string / string[] | 生成 | 画像摘要 | - | - | 来源于answers | visitor.preference_profile | 解释 | 没有授权记录或用户ID内嵌于画像 |
| profile.confidence | number | 生成 | 回答完整程度分数 | 0–100式分数 | - | 代码限制35–100 | 量表填写率公式 | 仅解释 | 不是模型准确率/统计置信度 |
| constraints.max_walk_per_leg_min / max_queue_min / require_rest | number / boolean | 生成 | 步行排队上限和休息要求 | 分钟/布尔 | - | 步行8/14/28；排队12/22/35；rest_need>=4 | planner_rules | 合法性 | 规则阈值，不是可验证个体生理参数 |
| explanation[].source / factor / delta | string / number | 生成 | 答案贡献说明 | 规则分值 | - | 最多主要8条贡献 | 八维factor | 解释 | 不是因果估计或采集标签 |
| planner_rules | object | 生成/请求可覆盖 | 传递给规则规划器的参数 | 按子字段 | - | max_walk/max_queue/score/preferred_exit_node_id | DEFAULT_RULES合并 | 规划约束 | 请求可提供其他参数，范围/类型校验不足 |

## 14 规则参数、知识、账号及反馈补充

本节只登记额外结构化内容。位置分别为planner/config.js、server/index.js、server/accounts.js、docs/account-contract.md；未读取或复制真实密码、Cookie或个人日志内容。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beam_width / planner_candidate_limit / max_actions / min_actions | number | 默认常量 | 搜索规模及最少游览数 | 次数 | - | 3/6/18/2 | 搜索配置 | Beam | 文档仍称2–4步，实际max18 |
| wait_duration_min / return_buffer_min / max_walk_per_leg_min / max_queue_min | number | 默认常量 | 等待、返程缓冲和约束 | 分钟 | - | 10/5/30/45 | 规则 | 合法性 | 不是场景服务容量限制 |
| fatigue_walk_per_min / fatigue_queue_per_min / fatigue_rest_recovery_per_min | number | 默认常量 | 疲劳代理推进系数 | 每分钟代理量 | - | 0.008/0.004/0.012 | visitor.fatigue | stepByRules | 未现场标定 |
| score.* | number | 默认常量 | 偏好收益/步行排队等待/疲劳迟到/改线/提前离园代价 | 规则评分 | - | preference34/walk1.2/queue0.45/wait0.25/fatigue12/late8/switch3/early80 | scoreAction | Beam | 可被请求覆盖，非物理量 |
| companionFacts[location].name / title / fact / prompt | string | 现存4条 | 景点文字和快捷提问 | - | - | museum/lake/theater/rest | location当前按node式标识查找 | 当前不入规划 | 无source_id/审核/有效期；未命中回退museum |
| routeSeeds[].id / title / author / tags / minutes / likes / stops / cover | string / string[] / number | 现存3条 | DNA演示卡片 | 分钟/显示计数 | - | 8A3F/2C71/F902；stops为旧节点ID | 旧makeRoutes | 间接演示使用 | 无真实作者/点赞来源；不是PlanResult派生的可复放DNA |
| user.id / username / displayName / role / permissions | string / string[] | 账号生成 | 账号与角色 | - | - | UUID；guest/visitor/manager | 请求req.account | 身份边界 | 与visitor_id不同；需按用户隔离状态 |
| passwordSalt / passwordHash | string | 账号生成 | scrypt凭据 | - | - | 服务端保存；非公共接口字段 | 内部user | 当前不用 | 不是训练或公开资产；本审计不导出值 |
| consent.location / feedback / sharing | boolean | 账号生成 | 授权开关 | - | - | 默认false | 账号profile | B使用位置/反馈前应遵守 | 当前陪伴/反馈读取链未强制关联 |
| routeHistory[].planId / createdAt / stops | string / string[] | 登录用户保存 | 最近最多30条路线摘要 | - | ISO UTC | stop使用target_node_id或target_id | PlanResult/账号UUID | 间接恢复/展示 | 不是完整PlanResult、轨迹或状态快照 |
| sessions.token / userId / expires | string / number | 登录生成（内存） | 会话身份与到期 | 毫秒Unix时间 | UTC纪元 | 7天会话 | 账号ID | 当前不用 | 重启失效；不包含在公共训练数据 |
| audit.timestamp / requestId / actorId / actorRole / action / target / outcome / details | string / object / null | 审计日志生成 | 操作追溯 | - | ISO UTC | success/denied；3条本地旧记录 | target按动作可为node/edge/account | 开发排错 | 日志受.gitignore忽略；不能当动态客流真值 |
| feedback[].at / load / 其他body字段 | string / number / 任意 | 请求追加 | 反馈时刻和负荷等 | load为0–1式代理；其余UNKNOWN | ISO UTC | 无固定Schema | 全局state.feedback | 待确认 | 未经授权/清洗不得默认为标签 |

## 15 坐标、视觉ID及前端约定

位置：scenic-layout.js、wandashan-map2d.js、app.js、scenic-overview.js、c-map.js。以下数值均REFERENCE_ONLY；没有发现可被仓库证明为实测/官方经纬度的数据资产。

| 字段 | 类型 | 必填依据 | 含义 | 单位 | 时间格式 | 合法值/当前值 | ID关系 | B的使用 | 不一致/证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| layout.nodes[node_id] | number[2] | 现存45项 | 源图位置 | 2560×500参考图坐标 | - | [x,y] | 同业务node_id | 不得直接作为米数 | 与算法归一化轴缩放不同 |
| layout.edges[edge_id] | number[2][] | 现存68项 | 绘制道路折线 | 源图坐标 | - | 每线首尾等于业务端点的layout坐标 | →edge_id及from/to | 脚本派生距离；运行B读生成图 | 绘图调整执行sync脚本后会改变规划成本 |
| displayNames / nodeNumbers | object<string,string或number> | 视觉常量 | 显示覆盖名和地图编号 | 编号无业务单位 | - | displayNames3项；nodeNumbers45项 | node_id键 | 当前不用 | 数字编号不是POI业务ID |
| referenceLandmarks[].id / name / kind / x / y | string / number | 现存8项 | 参考地标及3片区入口 | 源图坐标 | - | street/square/service/gate等 | 无明确node_id外键 | 当前不用 | water_margin_entrance不能默认等于market |
| secondaryPaths[].id / points / verified | string / number[][] / boolean | 现存16项 | 仅供视觉的步道 | 源图坐标 | - | verified true/false为代码标签 | 不是edge_id | 当前不用 | 缺少核验人/日期/证据，true不构成实地核验 |
| layout.facilities[].id / name / x / y / icon / verified | string / number / boolean | 现存6项 | 卫生间/服务/医疗等视觉符号 | 源图坐标 | - | f_info_mid等f_*私有ID | 无业务facility_id或node_id映射 | 当前不用 | 不能当REST或应急可达目标 |
| waterBodies | number[][][] | 现存3项 | 水体边界 | 源图坐标 | - | 多边形点 | 视觉区域 | 当前不用 | 不是GIS调查边界 |
| overviewPoint / detailPoint | function→number[2] | 渲染生成 | 两张SVG投影 | 渲染坐标 | - | overview按y轻微调整；detail=[x,70+2.12y] | 同源layout点 | 地图呈现 | 渲染函数没有修改运行中图拓扑 |
| overviewCanvasNodes / overviewCanvasRouteNodes / overviewCanvasEdges | object | 现存45/45/68项 | 旧Canvas建筑和前庭锚点及曲线 | 2400×1600画布坐标 | - | 局部坐标投影300+1.8x,165+1.8z | 以规范node/edge键关联 | 当前Canvas模式未启用 | 前庭锚点仅绘图，不是业务entrance_node_id |
| SPOTS[].id / no / name / cat / x / z / h / label / compact / visualOnly | string / number / number[] / boolean | Canvas常量35项 | 旧地图建筑/标记 | 局部世界/画布坐标 | - | south/wall/arena等与业务不同；8个visualOnly | 无统一显式业务映射表 | 当前不用 | 同名仅候选关联；含c_dyehouse=打铁铺等不能凭ID猜合并 |
| TOUR_ROUTE / TOUR_STOPS | number[][] | Canvas常量 | 示意固定游览线 | 局部绘图坐标 | - | 绘图数组，DRAW_BASE_ROUTE=false | 没有edge_id | 当前不用 | 不作为可规划道路 |
| SCENIC_CENTER | number[2] | 前端常量 | 地理参考中心 | 经纬度式数值；精度UNKNOWN | - | [34.82065,114.34426] | 用于OSM视图中心 | 当前不用 | 来源未证；REFERENCE_ONLY |
| nodeLatLng(node) | number[2] | 前端函数生成 | 把旧x/y平移为经纬度式位置 | 角度式数值 | - | lat=center+(50-y)*0.00034；lng=center+(x-50)*0.00043 | 旧node.x/y来自algorithm坐标 | 当前不用 | 非经纬度测量或经验证坐标转换 |
| DOM data-node-id / data-poi-id / data-edge-id | string | 渲染生成 | 业务对象绑定 | - | - | 当前规范ID集合对齐45/68 | →node/poi/edge | 前端交互联调 | 装饰ID与业务ID应区分；不靠中文名匹配 |

## 16 当前协议差异与必填性结论

| 对象 | 按当前Schema关键字做的内存结构检查 | 含义 |
| --- | --- | --- |
| 原始scenic_graph | 缺scenario_id/pois/events/facilities/exits，共5项 | 它是A原始图，必须经适配，不能当B图直接提交 |
| 原始current_state | 41个crowd_level为字符串而Schema要求number | 还存在open→is_open、queue_min→current_queue_min命名差异；Schema附加字段宽松，未把所有差异都报出 |
| 原始normal_forecast | 41×7=287个crowd_level字符串类型差异 | B适配只保留38个普通POI，并转换level |
| 初始适配state | preference_weights={}缺8个Schema必填权重 | 空画像需约定省略、null或合法默认，不在本轮修改 |
| 适配graph/forecast、mock三对象、生成PlanResult、public方案样例 | 已检查的结构字段未报错 | 结构通过不等于物理、时序、业务语义正确；public样例有已证实的语义错误 |

本次用内存只读检查器覆盖现有Schema中使用的类型、required、引用、组合、条件、枚举、数值界限、字符串模式和数组约束；没有安装依赖或把检查器保存到仓库。现有运行API不加载该JSON Schema；planner.validateInputs是另一套较宽松的手写校验。`$id`含b-planner-0.2，Versioned.const仍0.1；questionnaire/rules/model标签分别是其他版本域。

## 17 缺失/待协商字段

以下仅为审计缺口，不是已经存在的业务字段，不添加到现有JSON。

| 缺口 | 当前证据/影响 | 协商方 |
| --- | --- | --- |
| graph_version、独立几何/拓扑/接口版本、ID退役/迁移清单 | 当前只有schema_version；northgate迁移只见脚本 | A+B+C |
| entrance_node_id或poi_entrances、演出与设施实际入口 | 只有业务node_id和视觉前庭坐标；现场精度UNKNOWN | A+B，C确认渲染映射 |
| source_id/source_url、采集方式、许可、采集/更新时间、置信等级、原始资料校验值 | 当前手绘标签不能替代证据链 | A+B |
| facility/exit开放状态及事件场地关闭传播规则 | REST和ATTEND_EVENT可绕过场地POI关闭 | A+B |
| 经核实营业日历、演出完整场次/容量、游览和服务时长 | live默认09:00–22:00/30分钟/效用构造；9个show节点仅1场正式事件 | A+B |
| forecast.valid_until、缺失/过期标记、预测区间、来源模式 | B查询越界和缺失会继续给值；不应把默认当观测 | A+B |
| 事件的观测/公告/生效时刻、唯一序号、结束/撤回、幂等与过时处理 | UserEvent过去事件仍可覆盖当前；全序列被改写 | A+B |
| 账号到visitor会话归属、位置/反馈使用授权作用域 | 当前单份visitor，consent开关未覆盖读取链 | A+B |
| 雨量/天气量纲、shade/capacity/fatigue标注依据和误差 | 不能从变量名填造真实物理口径 | A+B |
| 坐标系/单位/投影与精度、经核验的lat/lng及道路方向 | 当前全部参考图数据；未发现GPS测量证据 | A+C，B约束用途 |
| 训练轨迹/合法动作快照/来源标签/缺失掩码/固定切分 | 当前只有演示样例和规则输出，无独立训练数据集 | A+B |
| 独立知识条目来源、审核、生效/失效与版本 | 当前4条硬编码介绍 | 依后续模块分工待讨论 |

## 18 ID对照表阅读方式

`id_mapping.csv`按实体命名空间登记规范ID、样例ID、视觉私有ID和显式旧ID。所有graph_version为UNKNOWN，不能把schema_version=0.1偷换为图版本。ACTIVE_REFERENCE只说明当前业务文件存在；DERIVED是代码派生；MOCK_ONLY/DEMO/TEST相关项不是现场事实；VISUAL_ONLY/REFERENCE_ONLY不能进入真实导航图；REVIEW_REQUIRED表示没有充分绑定证据；EXPECTED_INVALID是故意错误样例。空alias/old_id表示本次未发现证据，不表示保证没有历史别名。referenced_in为文字引用位置，不等于所有位置都构成有效外键。具体证据和质量问题见data_audit_report.md。
