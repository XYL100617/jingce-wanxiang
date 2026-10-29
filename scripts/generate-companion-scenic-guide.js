'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const graph = JSON.parse(fs.readFileSync(path.join(root, 'server/data/scenic_graph.json'), 'utf8'));
const contextRecord = {
  id: 'park-context-map-boundary',
  category: 'guide',
  node_ids: [],
  title: '万岁山景区背景与地图1改绘边界',
  content: '项目景区背景是河南开封的现实景区“万岁山·大宋武侠城”，整体以大宋文化和武侠江湖为主题语境。地图1是在真实景区导览资料基础上进行的项目化改绘，不是原始测绘地图。景区背景、地图1的示意布局和规划器使用的节点/道路数据属于不同层次：地图1中调整过的节点名、示意坐标、道路折线、支路、分区入口和规划连通，未经景区或实地核验不能当作现场位置、可达性或运营事实。回答景区文化背景应依据可追溯资料；回答路线和现场问题要明确地图与现场之间的核实边界。',
  keywords: ['万岁山', '万岁山武侠城', '景区背景', '真实景区', '地图1', '地图一', '导览图改绘', '项目地图', '地图边界'],
  source: {
    id: 'project-scope-map-source-audit',
    title: '用户确认的景区背景与项目地图来源核对记录',
    kind: 'application',
    locator: 'docs/map-source-audit.md#项目背景与地图边界',
    verified: true
  },
  review_status: 'approved',
  effective_from: '2026-01-01T00:00:00+08:00',
  effective_until: null
};
const records = graph.nodes.map(node => {
  const tags = Array.isArray(node.tags) ? node.tags : [];
  const category = node.type === 'service' ? 'facilities' : 'culture';
  const name = String(node.name || node.node_id);
  const tagText = tags.length ? tags.join('、') : '暂无项目标签';
  return {
    id: `scenic-demo-${node.node_id}`,
    category,
    node_ids: [node.node_id],
    title: `${name}：项目示意图资料`,
    content: `演示资料：景区背景为现实中的“万岁山·大宋武侠城”（河南开封），整体以大宋文化和武侠江湖为主题语境。本条地图资料来自地图1的项目化改绘：项目图使用节点名“${name}”，节点标签为“${tagText}”。这些图面字段不证明现场对应名称、建筑位置、服务情况或道路可达性；地图1并非测绘底图。若问及营业、演出、通行、安全或设施可用性，现有资料不足以确认，请依据景区公告或工作人员答复。`,
    keywords: [...new Set([name, ...tags, '景区介绍', '导览', '景点', '推荐', '游玩'])],
    source: {
      id: `scenic-graph-${node.node_id}`,
      title: '景策万象项目示意路网（未实地核验）',
      kind: 'demo',
      locator: `server/data/scenic_graph.json#nodes/${node.node_id}`,
      verified: false
    },
    review_status: 'demo',
    effective_from: '2026-01-01T00:00:00+08:00',
    effective_until: null
  };
});
const output = {
  schema_version: '1.0',
  dataset_status: 'project_context_plus_unverified_map_records',
  park_context: {
    canonical_name: '万岁山·大宋武侠城',
    aliases: ['大宋万岁山武侠城', '万岁山武侠城'],
    location: '河南开封',
    map_relationship: '地图1依据真实景区导览资料项目化改绘；示意节点与路网不是测绘结果'
  },
  source_graph: 'server/data/scenic_graph.json',
  generated_at: new Date().toISOString(),
  record_count: records.length + 1,
  records: [contextRecord, ...records]
};
fs.writeFileSync(path.join(root, 'server/data/companion/scenic-guide.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`Generated one park-context record and ${records.length} demo map-node records.\n`);
