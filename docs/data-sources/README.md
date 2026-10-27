# 第二阶段：数据来源与证据治理

本目录承接 [第一阶段数据审计](../data-audit/data_audit_report.md)。第一阶段记录现状和问题；本阶段管理来源证据、使用边界与后续获取路线。当前业务图版本为 DEMO `1.0`，本目录配置不接入业务运行代码。

## 文件

| 文件 | 用途 |
| --- | --- |
| `governance_policy.md` / `governance.json` | 负责人冻结的 DEMO 治理规则及机器配置 |
| `source_tiers.md` | T1–T4 与地图证据等级 |
| `source_registry.csv` | 来源和字段级登记；一个 `source_id` 是一行来源声明，不一定是独立网页 |
| `source_snapshot_manifest.csv` | T2 证据元数据、校验和与复核状态；纳入 Git |
| `snapshots/*.txt` | 7 份最小文字片段仅保留在采集者本地；许可待核实，暂不纳入 Git |
| `public_entity_mapping.csv` | 公开名称到内部 POI/节点/事件的候选映射与待复核状态 |
| `poi_facts.csv` | 41 个嵌入 POI 的字段级事实与来源 |
| `edge_evidence.csv` | 68 条道路的参考几何、估算成本与核验状态 |
| `schedule_events.csv` | DEMO 事件、T4 假设和未绑定的 T2 公共节目引用 |
| `license_manifest.md` | 已确认与待核实的许可/用途权 |
| `acquisition_gap_list.md` | 保留的 P0/P1/P2 真值缺口和后续获取路线 |
| `scripts/validate-data-sources.js` | 只读检查以上结构；运行 `node scripts/validate-data-sources.js` |

当前来源总表共 276 行：T1=0、T2=24、T3=0、T4=20、UNKNOWN_SOURCE=232。T2 的 24 行对应 7 个独立公开页面，不能当作 24 份独立资料。当前 T1 为 `CURRENTLY_UNAVAILABLE`，T3 为 `CURRENT_STAGE_NOT_PLANNED`；T4 与参考图只供演示/仿真。

## 证据和版本边界

- 仅当前 45 node / 68 edge 图及明确绑定它的字段记录标 `graph_version=1.0`。无图绑定网页、独立 mock 等标 `N/A`。此版本不是实测图版本证明。
- `REFERENCE_ONLY` / `visual_only` 是手绘和渲染参考；`DEMO` 是演示状态；`MOCK_ONLY` 是独立小图；`RULE_GENERATED`、`RULE_CONFIG`、`ASSUMPTION` 是规则构造；`UNVERIFIED_CONTENT` 是未核验文案。
- 所有 68 条当前道路 `verified_walkable=UNKNOWN`。POI `node_id` 仅为 DEMO 到达代理，四个园门可进出也仅为 `DEMO_RULE`。REAL 当前禁用。
- `UNKNOWN` 不得自动填 0、false、true 或默认时间。原始网页使用权、真实入口、道路方向、单 POI 时窗和当日演出仍有缺口。
- T2 的 7 个网页已在采集者本地各保存一份最小文字片段，24 条字段来源共用对应文件及 SHA-256；这些文件暂不纳入 Git，新检出的仓库只有 manifest，校验器会提示本地证据缺席；未保存完整网页、图片或正式授权副本。部分检索工具内容存在缓存延迟，不能证明当天运营状态。许可仍为 `UNKNOWN`，网页可见不代表可训练或再分发。

## 后续录入

发现资料 → 保存有权留存的原始网页/授权副本或摘录 → 登记 `source_registry.csv` → 按来源 ID 登记快照状态 → 绑定业务 ID 或保留 `REVIEW_REQUIRED` → 判 T1/T2/T3/T4 → 人工核验冲突、有效期和许可 → 写入事实表 → A/B 签收 → 再评估业务图或训练准入。
更新事实时新增来源和有效期，不删除旧行。当前不开展 T3 走查；A 当前无仓库外 T1 资料。P0/P1 缺口继续保留，待条件具备后再采集。

公开资料人工复核按静态、半动态、高动态三类触发，详见 `governance_policy.md`；本阶段不运行定时爬虫。
