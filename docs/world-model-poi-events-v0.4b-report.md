# 节目事件扩充实验 v0.4b

## 做了什么

- 把 11 个节目场地严格映射到现有地图1节点，保留 `EXACT` 匹配与来源。未将“王婆舞台”“水浒街擂台”“神舟广场”“仙侠奇境”等名称相近但地图1无同名节点的场地硬配到其他 POI。
- 调整 B 分支隔离副本中的 T4 场景生成：每条轨迹选 2–4 个参考节目，错开随机开演时间；事件名单在多个场景中轮转覆盖。文化类 POI 只有在节目目录明确声明 exact venue match 时才作为模拟演出事件进入观测，没有改地图1节点/edge/POI ID。
- 基于 1080 条既有环境样本加 540 条节目场景样本，共 1620 条；按 60 个独立场景组切分为 42/9/9，验证无场景组泄漏。11/11 节目 ID 均出现在样本观测中。
- 用同一训练代码得到 `synthetic-world-model-v0.4b`。工件仅供实验比较，运行服务继续使用 v0.3 影子模型，不影响规划。

训练数据保存在仓库外的 `D:\jingxing\b-data-governance-v1-inspect\dataset_schedule_events_v0.3b\environment`；文件数量、SHA256、场景切分和来源边界见 [`training-data-manifest-v0.3.json`](../server/world-model/training-data-manifest-v0.3.json)。目录未进入 Git。

## 测试集对比

| 预测时距 | v0.3 POI 队列 MAE | v0.4b POI 队列 MAE | v0.4b 全零 MAE | v0.3 非零 AP | v0.4b 非零 AP | v0.3 道路 MAE | v0.4b 道路 MAE |
|---|---:|---:|---:|---:|---:|---:|---:|
| 5 分钟 | 0.2666 | 0.2673 | 0.1461 | 0.1587 | 0.1484 | 0.2128 | 0.1990 |
| 15 分钟 | 0.2835 | 0.2845 | 0.1552 | 0.1542 | 0.1488 | 0.2312 | 0.2113 |
| 30 分钟 | 0.2992 | 0.3007 | 0.1646 | 0.1640 | 0.1553 | 0.2188 | 0.1959 |
| 60 分钟 | 0.3112 | 0.3101 | 0.1702 | 0.1617 | 0.1552 | 0.1687 | 0.1606 |

POI MAE 单位为模拟队列人数。v0.4b 四个时距都远高于全零基线，且 5/15/30 分钟比 v0.3 略差；60 分钟才有极小改善。非零风险 AP 仍高于发生率基线，但比 v0.3 低。道路耗时误差有改善，但道路也是模拟标签。由此不能说节目扩充提高了万岁山 POI 客流预测精度。

完整的 v0.4b 评估数值见 [`graph-temporal-report-v0.4b.json`](../server/world-model/graph-temporal-report-v0.4b.json)，模型参数见 [`graph-temporal-v0.4b.json`](../server/world-model/graph-temporal-v0.4b.json)。模型是图局部特征上的岭回归与非零风险逻辑回归，不是 GNN/GRU；不接入路线规划，也不作为真实客流预测。

## 数据与来源边界

- 节目图片日期未知，公开攻略是第三方攻略且发布时间为 2025-11-26。场次可能变化，本实验没有把攻略时刻当作当前排期，而是按 T4 规则随机生成事件窗口、容量与事件传播。
- 用户给出的君威、头条、百度文库链接本轮未能稳定读取。场地与节目参考另由[去哪儿演出攻略](https://travelnews.qunar.com/qa_strategy/kaifeng-wansuishan-must-see-performance-guide)交叉整理；它不是景区官方实时公告。来源本身提到热门演出预约、候场和相邻 POI，但这些描述不等价于客流计数标签。
- 外部迪士尼等待时长数据属于“ride wait minutes”，与本项目“POI queue count/road travel time”单位和图结构不同；不能直接并入此模型训练。其数据只适合单独做跨域时间序列基准或研究仿真先验，仍需单独评估和数据许可审查。
- 真实 POI 校准仍需万岁山按 POI/时间记录的客流或排队观测，以及实际节目单、实测地图与通行数据。

## 外部等待时长数据试验

另取 [Jester565/DisneylandData](https://github.com/Jester565/DisneylandData) 的历史数据独立训练一个跨域等待时长基线。原始记录含 2017-05-22 至 2018-09-15 的 66 个 ride；668,847 条记录有数值 waitMins。把同一 ride 后续 20–40 分钟内的下一个有效等待值作为标签，按日期顺序切为 train 424,058 / validation 92,957 / test 91,469 个样本。训练 Ridge 和 HistGradientBoosting，并在验证集选择融合权重。

测试集上，单独 HistGradientBoosting 的 MAE 为 4.67 分钟，低于当前等待值持久性基线的表现（持久性 MAE 4.28 分钟更低）；验证集选出的模型融合权重为 0，最终退回“下一时刻约等于当前值”。这说明该数据可以快速做跨域基准，但本次尝试没有证明学习到的部分优于简单持久性，更没有证明可迁移到万岁山 POI。

本地脚本为 [`train-external-wait-dynamics.py`](../scripts/train-external-wait-dynamics.py)，摘要报告为 [`external-wait-dynamics-report-v0.1.json`](../server/world-model/external-wait-dynamics-report-v0.1.json)。约 107 MB 原始 CSV 保存在仓库外 `D:\jingxing\external-datasets`；上游仓库页面没有展示明确许可文件，因此没有把原始数据放入项目仓库。该数据是游乐设施等待分钟，不含地图1 POI 坐标、相邻道路或开封现场反馈，故没有并入 v0.4b 或当前运行接口。
