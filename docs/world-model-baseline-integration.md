# 轻量化世界模型实验基线接入

## 当前接入范围

`server/world-model/synthetic-baseline.js` 加载 `server/world-model/synthetic-baseline-v0.1.json`，为 B 分支数据契约中的 POI `queue_count` 观测提供 5/15/30/60 分钟逐景点实验预测。请求必须显式带 `synthetic: true` 和 `source_tier: "T4"`。输出包含训练/测试来源说明、逐点预测及 validation 绝对误差 P90 区间。

这一路径是 shadow/实验通道，不写入 A 的 `EnvironmentForecast`，不替换规则模拟器，不参与路线规划。当前 A 状态保存 `queue_min`（排队时间，单位分钟）和 `crowd_ratio`，没有同契约的 `queue_count` 真实观测。将等待分钟换算为排队人数会改变字段含义，因此不做这种映射。

HTTP 接口：

```text
GET  /api/v1/world-model/experimental
POST /api/v1/world-model/experimental
```

POST body 形状为 `{ "observation": { "synthetic": true, "source_tier": "T4", "timestamp": "...", "pois": { "lake": { "queue_count": 1 } } } }`。缺失 POI 会返回 `available: false`；REAL 或未标记来源的输入会返回 400。

## 模型与验证

- 数据版本：`dataset_v0.1` / `dataset-p1.1`，图版本 `1.0`，模拟器 `sim-dr-p1.1`。
- 训练集/验证集/测试集按场景组切分；环境样本为 744/168/168。
- 每个 POI、每个预测时距拟合一元线性回归：同一 POI 当前观测 `queue_count` → 未来 `queue_count`；非负截断。共覆盖 41 个 POI。
- 测试集逐 POI 样本合并 MAE：5/15/30/60 分钟为 0.315/0.335/0.354/0.367；持久性基线为 0.860/0.878/0.883/0.938。目标单位是合成队列人数，不是客流量。
- Validation 绝对误差 P90 区间半宽约 0.81 人；这是经验残差分位数，尚无真实覆盖率校准。

## 限制

全部数据是 T4 模拟值，尚无景区真实观测训练或外部验证。当前主工作区与 B 分支图的 ID 集合相同，但节点/边属性存在差异。模型暂时不能直接代替 A 的规则预测或规划输入。地图、路径和其他生产链路继续使用现有规则模拟与回退。
