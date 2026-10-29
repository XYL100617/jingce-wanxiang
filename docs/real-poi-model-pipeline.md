# 万岁山 POI 真实观测训练与启用门槛

这是把轻量化世界模型从仿真实验推进到本地真实校准的入口。训练脚本只接受 `source_tier=REAL`、`synthetic=false`、有来源编号且明确获准用于建模的观测；它不会把规则演示状态或模拟器输出算作实测数据。

## 观测格式

每行一个完整时间快照，保存为 JSONL。时间建议每 5 分钟采一次，至少覆盖 14 个营业日；尽可能同时记录所有开放 POI。使用地图1 POI ID，时间必须带时区。

```json
{"timestamp":"2026-10-29T10:00:00+08:00","source_tier":"REAL","synthetic":false,"graph_version":"1.0","graph_fingerprint":"2320dbb2b9c9cfde3fd248d521f4784c939dc248c73beeea2e4bda8e0f27f052","source_kind":"manual_queue_measurement","source_id":"field-log-2026-10-29-am","authorized_for_modeling":true,"poi_states":{"theater":{"queue_min":12,"crowd_ratio":0.58,"open":true}},"events":[],"weather":{"temperature_c":24,"rain_mm":0}}
```

`queue_min` 应为实测排队分钟；`crowd_ratio` 应使用事先固定的计数/分级规则转换到 0–1。不要把排队分钟当人数，也不要填入推算值并标成 REAL。`source_id` 应指向采集批次或来源说明，不应写游客姓名、手机号、设备 ID 等个人信息。只有获得相应用途授权的数据才能设置 `authorized_for_modeling=true`。

## 训练和验收

```powershell
node scripts/train-local-real-poi-model.js D:\jingxing\real-observations\poi-snapshots.jsonl D:\jingxing\real-observations\real-poi-model.json
```

训练按完整营业日做时间顺序 60/20/20 切分，边界上的跨集合预测样本会丢弃；使用当前值持久性作为基线，在验证集选 ridge 正则，再以最后时间段做留出评估。10/20/30/60 分钟分别评估 `queue_min` 和 `crowd_ratio`，与项目现有 10 分钟规划采样网格对齐，并按 POI 输出样本量与 MAE/RMSE。特征包含当前 POI 状态、一跳相邻 POI、时段/星期、开放状态、已知事件窗口和天气；不依赖服务端还未提供的历史缓存。

预测模拟器已有模型适配器：默认关闭，需设置 `WORLD_MODEL_REAL_ACTIVE=true` 才尝试加载；还要求工件 `eligible_for_planning=true`、模型图指纹与地图1一致、当前状态明确包含 `source_tier=REAL`、`synthetic=false` 和相同图指纹。任一条件不满足都回到规则预测。模型只覆盖 POI 的 `queue_min`/`crowd_ratio`，道路关闭与通行仍由现有规则处理。当前仓库尚无面向游客/管理端的真实采集接口，实测快照需由授权的现场记录或合法数据连接器提供；演示状态不会被自动标成 REAL。

只有每个预测目标/时距在测试集至少有 100 个样本，且整体 MAE 比持久性基线至少低 5%，工件才标记 `eligible_for_planning=true`。否则训练工件仍可用于对照，但规则预测必须继续作为主路径。此门槛只是最低接入门槛，不代表所有旺季、天气或活动场景都已验证；还应核对分场景误差、区间覆盖和数据漂移。

目前仓库没有这类真实快照，所以不能生成合格的万岁山模型，也不能声称已达成准确预测。公共主题乐园数据仅可用作外域先验，不能代替本地盲测标签。预测模拟器预留了真实工件适配器；只有显式启用、工件通过门槛、图指纹吻合且当前状态也明确标记为 REAL 时，模型预测才覆盖 POI 队列/拥挤度，否则继续走规则回退。收集和授权数据之前，该适配器不会影响现有规划。
