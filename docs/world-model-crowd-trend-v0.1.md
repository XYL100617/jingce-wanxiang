# 地图1轻量拥挤趋势模型 v0.1

## 实验目标

旧版 POI 队列人数回归在现有模拟留出集上没有胜过“全零”基线。v0.1 将预测目标改为路线避峰更直接相关的两个量：地图1开放 POI 的未来拥挤比例，以及未来拥挤比例至少上升 0.03 的概率。输入使用当前 POI 状态、一跳相邻 POI、相邻道路状态、已知节目事件窗口、时间和天气。模型是逐 POI 的梯度提升树，不预测排队人数，不生成新路线，也不估计推荐某条路线对全园客流造成的反向影响。

## 数据与切分

训练使用 B 的 `schedule-enriched-poi-events-v0.3c-stratified`，位于本地 `D:\jingxing\b-data-governance-v1-inspect\dataset_schedule_events_v0.3c`。其中有 1620 条 5 分钟环境样本，分到 42/9/9 个完整场景组；包含 11 个节目身份，节目场地按地图1名称精确映射。节目图片日期未知，节目身份用于仿真事件场景，开场时间和容量均重新随机采样，不能当成当前真实节目表。

另用 B 的模拟器生成模板外压力集 `D:\jingxing\world-model-ood-v0.2`：36 个独立种子轨迹，训练 24 组、验证 6 组、测试 6 组；测试两个场景模板完全未参与拟合，组合了未见过的天气、客流等级、道路封闭、节目延迟和观测质量条件。生成前会核对 B 模拟器与主项目地图1的 node/POI/edge 拓扑。A 与 B 的 edge 基础通行时间不同，因此特征中的边基础时间固定使用 B 训练图的值；POI 容量则要求与当前图一致。运行时还要求 `simulator_version=sim-dr-p1.1`，不接受主服务当前的其他演示状态。输出位于仓库外。所有状态标签仍是 T4 合成数据。

## 模板外结果

下表来自 OOD 测试集；MAE 越低越好，拥挤比例单位为 0–1。上升风险 AP 的随机排序基线等于测试正例比例（约 0.14）。

| 预测时距 | 持久性 MAE | 模型 MAE | 上升风险 AP | 上升风险 Brier（模型/常数基线） | Top 10% 风险点上升比例 |
|---:|---:|---:|---:|---:|---:|
| 5 分钟 | 0.0206 | 0.0114 | 0.915 | 0.035 / 0.119 | 0.922 |
| 15 分钟 | 0.0205 | 0.0114 | 0.914 | 0.035 / 0.119 | 0.921 |
| 30 分钟 | 0.0207 | 0.0116 | 0.909 | 0.036 / 0.120 | 0.912 |
| 60 分钟 | 0.0207 | 0.0115 | 0.903 | 0.038 / 0.123 | 0.909 |

验证集对融合权重的选择结果是四个时距均使用模型输出。测试有 6 个独立种子组，其中 3 个组有明显动态拥挤变化、另外 3 个组基本静止。按场景组 bootstrap 的 MAE 改善区间约为 0.0023–0.0168；这比仅按 POI-时间窗口统计更保守，但测试模板仍只有两个，不能证明更广的真实场景泛化。

此前的 0.3c 随机分组结果看起来也有较高的上升风险 AP，但按组诊断发现提升集中于少数动态组，因此单独增加了模板外测试。即便模板外测试更好，模型仍是在同一个程序化仿真器中训练和测试，测得的是“能否预测本模拟器的状态演变”，不是万岁山真实预测精度。

## 项目接入

拟合器将 scikit-learn 梯度提升树导出为 1.73 MB 的 JSON 节点数组。训练脚本会在验证样本上逐项比对 JSON 运行结果与 scikit-learn 输出，最大误差小于 `1e-16`；并对一个完整留出快照的 41 个 POI 核对 Python/Node 特征和预测，差值小于 `1e-10`。Node 运行时核对地图1 node/POI/edge 拓扑与 POI 容量，并只接受显式 `source_tier=T4`、`synthetic=true`、`simulator_version=sim-dr-p1.1` 的输入。候选路线逐 edge 检查连通性，并标记观测到的封闭路段。

- `GET /api/v1/world-model/crowd-trend`：模型版本和模拟范围说明。
- `POST /api/v1/world-model/crowd-trend`：请求 `{ "horizon_min": 30, "observation": { "source_tier": "T4", "synthetic": true, "simulator_version": "sim-dr-p1.1", "...": "其余 B 模拟器观测字段" }, "history": [], "routes": [{ "route_id": "r1", "node_ids": ["gate", "fortress"] }] }`。
- 返回每个开放 POI 的拥挤比例预测、上升概率，以及候选路线覆盖 POI 的均值风险。路线分数只用于同一请求内的相对比较；`affects_planning=false`，现有 planner 不读取它。

## 复现

需要 B 分支的模拟器源码、Node 和 Python `numpy`/`scikit-learn`。生成新数据时输出目录必须不存在：

```powershell
node scripts/generate-world-model-ood-data.cjs `
  D:\jingxing\b-data-governance-v1-inspect `
  D:\jingxing\world-model-ood-v0.2

python scripts/experiment-world-model-crowd-trend.py `
  D:\jingxing\world-model-ood-v0.2\environment `
  server\world-model\crowd-trend-experiment-ood-v0.1.json `
  server\world-model\crowd-trend-model-v0.1.json `
  D:\jingxing\b-data-governance-v1-inspect\server\data\scenic_graph.json
```

原始外部 Disneyland 等待时间数据没有 POI 图、节目事件和一致的 crowd-ratio 标签，前序实验显示其 30 分钟模型不如持久性基线，因此没有拿它直接冒充万岁山 POI 标签或混入这次训练。它可作为后续迁移先验研究来源，仍需本地模拟校准及独立验证。

## 未完成与使用边界

1. 没有万岁山现场客流、排队或拥挤度标签；不能声明“真实预测准确”或现场可用。
2. 两张节目单图片与节目身份来源日期/有效期未知；运行时必须接入核验后的当日节目表，不能沿用随机合成事件窗口。
3. 当前模型预测环境状态，不建模某个游客选择路线后对人群分布的因果影响，也没有通过端到端仿真验证“推荐路线 A 比 B 更少拥堵”。候选路线分数不能代替规划器或现场导航。
4. 地图1坐标/距离仍是示意图数据；道路与 POI 未实测核验时，模型输出仍仅可用于模拟研究。
