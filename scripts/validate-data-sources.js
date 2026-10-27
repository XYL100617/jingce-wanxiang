#!/usr/bin/env node
'use strict';

// Read-only governance validation. Every filesystem read is confined to
// docs/data-sources; this script never reads business data or writes files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = path.resolve(__dirname, '..', 'docs', 'data-sources');
const errors = [];
const warnings = [];
const conflicts = [];
const error = message => errors.push(message);
const warn = message => warnings.push(message);

function localPath(relative) {
  const file = path.resolve(dataDir, relative);
  if (!file.startsWith(dataDir + path.sep)) throw new Error('Path escapes docs/data-sources');
  return file;
}

function readLocal(relative) {
  return fs.readFileSync(localPath(relative), 'utf8');
}

function parseCsv(text, name) {
  const lines = [];
  let line = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { line.push(value); value = ''; }
    else if (char === '\n') {
      line.push(value);
      if (line.some(cell => cell !== '')) lines.push(line);
      line = []; value = '';
    } else if (char !== '\r') value += char;
  }
  if (quoted) throw new Error(`${name}: unclosed CSV quote`);
  if (line.length || value !== '') { line.push(value); lines.push(line); }
  if (!lines.length) throw new Error(`${name}: empty CSV`);
  const header = lines.shift();
  if (new Set(header).size !== header.length) throw new Error(`${name}: duplicate columns`);
  lines.forEach((cells, index) => {
    if (cells.length !== header.length) throw new Error(`${name}: row ${index + 2} has ${cells.length} cells, expected ${header.length}`);
  });
  return {header, rows: lines.map(cells => Object.fromEntries(header.map((key, index) => [key, cells[index]])))};
}

function readCsv(name, required) {
  try {
    const table = parseCsv(readLocal(name), name);
    for (const column of required) if (!table.header.includes(column)) error(`${name}: missing column ${column}`);
    return table;
  } catch (cause) {
    error(`${name}: ${cause.message}`);
    return {header: [], rows: []};
  }
}

function unique(rows, key, name) {
  const seen = new Set();
  for (const row of rows) {
    const value = row[key];
    if (!value || value === 'UNKNOWN') { error(`${name}: empty ${key}`); continue; }
    if (seen.has(value)) error(`${name}: duplicate ${key}=${value}`);
    seen.add(value);
  }
  return seen;
}

let governance = null;
try { governance = JSON.parse(readLocal('governance.json')); }
catch (cause) { error(`governance.json: ${cause.message}`); }
if (governance) {
  if (governance.graph_version !== '1.0') error('governance.graph_version must be 1.0');
  if (governance.operation_mode !== 'DEMO') error('Current operation_mode must be DEMO');
  if (governance.real_mode_enabled !== false) error('REAL mode must remain disabled');
  if (governance.site_verification?.enabled !== false || governance.site_verification?.source_tier !== 'T3') error('Current T3 policy mismatch');
  if (governance.operator_data?.available !== false || governance.operator_data?.source_tier !== 'T1') error('Current T1 policy mismatch');
  const gates = ['gate','southgate','westgate','eastgate'];
  if (Object.keys(governance.gates || {}).length !== 4) error('governance.gates must contain exactly four current DEMO gates');
  for (const id of gates) {
    const gate = governance.gates?.[id];
    if (gate?.entry_allowed !== true || gate?.exit_allowed !== true || gate?.evidence !== 'DEMO_RULE') error(`DEMO gate policy mismatch: ${id}`);
  }
  if (governance.poi_arrival_policy?.demo_target_field !== 'node_id' || governance.poi_arrival_policy?.real_entrance_verified !== false || governance.poi_arrival_policy?.entrance_node_id_enabled !== false) error('POI arrival proxy policy mismatch');
  if (governance.navigation_policy?.demo_allowed !== true || governance.navigation_policy?.real_allowed !== false) error('Navigation mode policy mismatch');
  const minimum = new Set(governance.navigation_policy?.real_minimum_evidence || []);
  if (!minimum.has('operator_confirmed') || !minimum.has('verified_on_site')) error('REAL minimum evidence policy incomplete');
}

const sources = readCsv('source_registry.csv', ['source_id','source_tier','source_url_or_path','query_or_collection_date','confidence','verification_status','entity_id','field_name','structured_value','graph_version','last_review_date','next_review_date','review_status']);
const edges = readCsv('edge_evidence.csv', ['edge_id','from_node_id','to_node_id','source_id','source_tier','evidence_level','verified_walkable','graph_version']);
const pois = readCsv('poi_facts.csv', ['poi_id','node_id','source_id','graph_version']);
const events = readCsv('schedule_events.csv', ['event_id','source_id','start_time','verification_status','record_kind','graph_version']);
const snapshots = readCsv('source_snapshot_manifest.csv', ['snapshot_id','source_id','source_url','page_title','publisher','query_date','captured_at','snapshot_type','local_snapshot_path','content_checksum','review_status','last_review_date','next_review_date']);

const sourceIds = unique(sources.rows, 'source_id', 'source_registry.csv');
const tiers = Object.fromEntries(['T1','T2','T3','T4','UNKNOWN_SOURCE'].map(tier => [tier, 0]));
const allowedTiers = new Set(Object.keys(tiers));
const graphBoundTypes = new Set(['NODE','EDGE','POI','POI_STATE','EVENT']);
const t2 = [];
for (const row of sources.rows) {
  if (!allowedTiers.has(row.source_tier)) error(`Invalid source_tier at ${row.source_id}`);
  else tiers[row.source_tier]++;
  if (graphBoundTypes.has(row.entity_type) && row.graph_version !== '1.0') error(`${row.source_id}: current graph entity needs graph_version 1.0`);
  if (row.source_tier === 'T2') {
    t2.push(row);
    for (const field of ['source_url_or_path','query_or_collection_date','confidence','verification_status']) {
      if (!row[field] || row[field] === 'UNKNOWN') error(`${row.source_id}: T2 ${field} missing`);
    }
    try {
      const url = new URL(row.source_url_or_path);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') error(`${row.source_id}: invalid T2 URL scheme`);
    } catch { error(`${row.source_id}: invalid T2 URL`); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.query_or_collection_date || '')) error(`${row.source_id}: invalid query date`);
    if (!['ACTIVE_REVIEW_REQUIRED','PERIODIC_REVIEW'].includes(row.review_status)) error(`${row.source_id}: review_status missing`);
    if (row.last_review_date !== row.query_or_collection_date) warn(`${row.source_id}: last review date differs from current recorded query date`);
    if (row.graph_version !== 'N/A') error(`${row.source_id}: unbound web source must use graph_version N/A`);
  }
}
if (tiers.T1 || tiers.T3) warn('发现新的 T1/T3 记录，请确认是否已经完成授权/现场核验并更新 governance.json。');

const sourceById = new Map(sources.rows.map(row => [row.source_id, row]));
function checkSourceReference(rows, table) {
  for (const row of rows) if (row.source_id && row.source_id !== 'UNKNOWN' && !sourceIds.has(row.source_id)) error(`${table}: missing source_id ${row.source_id}`);
}
checkSourceReference(edges.rows, 'edge_evidence.csv');
checkSourceReference(pois.rows, 'poi_facts.csv');
checkSourceReference(events.rows, 'schedule_events.csv');

const edgeIds = unique(edges.rows, 'edge_id', 'edge_evidence.csv');
if (edges.rows.length !== 68) error(`edge_evidence.csv: expected 68 edges, got ${edges.rows.length}`);
for (let number = 1; number <= 68; number++) {
  const id = `edge_${String(number).padStart(3, '0')}`;
  if (!edgeIds.has(id)) error(`edge_evidence.csv: missing ${id}`);
}
const mapEvidence = new Set(['operator_confirmed','verified_on_site','public_inferred','visual_only','synthetic']);
const approved = new Set(['operator_confirmed','verified_on_site']);
const nodeIds = new Set();
for (const row of edges.rows) {
  nodeIds.add(row.from_node_id); nodeIds.add(row.to_node_id);
  if (row.graph_version !== '1.0') error(`${row.edge_id}: graph_version must be 1.0`);
  if (!mapEvidence.has(row.evidence_level)) error(`${row.edge_id}: unknown evidence_level`);
  if (row.verified_walkable === 'true' && !approved.has(row.evidence_level)) error(`${row.edge_id}: verified_walkable=true lacks operator/site evidence`);
  if (approved.has(row.evidence_level) && !['T1','T3'].includes(row.source_tier)) error(`${row.edge_id}: strong map evidence needs T1 or T3 source tier`);
  if (row.verified_walkable === 'true' && !['T1','T3'].includes(sourceById.get(row.source_id)?.source_tier)) error(`${row.edge_id}: verified road is not linked to a T1/T3 source`);
}
if (governance?.operation_mode === 'REAL') {
  if (governance.real_mode_enabled !== true || governance.navigation_policy?.real_allowed !== true) error('REAL mode not explicitly enabled');
  if (governance.navigation_policy?.real_safety_review_passed !== true) error('REAL mode lacks safety review');
  if (governance.poi_arrival_policy?.real_entrance_verified !== true) error('REAL mode lacks verified POI entrances');
  for (const row of edges.rows) if (!approved.has(row.evidence_level) || row.verified_walkable !== 'true') error(`REAL mode road not approved: ${row.edge_id}`);
  for (const [id, gate] of Object.entries(governance.gates || {})) if (gate.evidence === 'DEMO_RULE') error(`REAL mode gate remains DEMO only: ${id}`);
}

const poiIds = new Set();
let entranceWarning = false;
for (const row of pois.rows) {
  if (!row.poi_id || row.poi_id === 'UNKNOWN') error('poi_facts.csv: poi_id empty');
  else poiIds.add(row.poi_id);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(row.node_id || '') || !nodeIds.has(row.node_id)) error(`poi_facts.csv: bad node_id for ${row.poi_id}`);
  if (row.graph_version !== '1.0') error(`poi_facts.csv: graph_version mismatch for ${row.poi_id}`);
  if (pois.header.includes('entrance_node_id') && row.entrance_node_id && !['UNKNOWN','N/A','REVIEW_REQUIRED'].includes(row.entrance_node_id) && governance?.poi_arrival_policy?.entrance_node_id_enabled === false) entranceWarning = true;
}
if (poiIds.size !== 41) error(`poi_facts.csv: expected 41 distinct POIs, got ${poiIds.size}`);
if (entranceWarning) warn('治理配置尚未启用真实入口，请确认图版本和入口证据。');

const mappings = readCsv('public_entity_mapping.csv', ['mapping_id','public_entity_name','public_entity_type','source_id','candidate_poi_id','candidate_node_id','candidate_event_id','match_basis','match_confidence','mapping_status','graph_version','notes']);
unique(mappings.rows, 'mapping_id', 'public_entity_mapping.csv');
const allowedMappingStatuses = new Set(['CONFIRMED','REVIEW_REQUIRED','NO_MATCH']);
const eventIds = new Set(events.rows.map(row => row.event_id).filter(id => id && id !== 'UNKNOWN'));
for (const row of mappings.rows) {
  if (!row.public_entity_name || !row.public_entity_type || !row.match_basis || !row.match_confidence) error('public_entity_mapping.csv: required field missing at ' + row.mapping_id);
  if (!allowedMappingStatuses.has(row.mapping_status)) error('public_entity_mapping.csv: invalid status at ' + row.mapping_id);
  if (row.graph_version !== governance?.graph_version) error('public_entity_mapping.csv: graph_version mismatch at ' + row.mapping_id);
  if (!sourceIds.has(row.source_id) || sourceById.get(row.source_id)?.source_tier !== 'T2') error('public_entity_mapping.csv: source_id is not registered T2 at ' + row.mapping_id);
  if (row.candidate_poi_id && !poiIds.has(row.candidate_poi_id)) error('public_entity_mapping.csv: unknown candidate_poi_id at ' + row.mapping_id);
  if (row.candidate_node_id && !nodeIds.has(row.candidate_node_id)) error('public_entity_mapping.csv: unknown candidate_node_id at ' + row.mapping_id);
  if (row.candidate_event_id && !eventIds.has(row.candidate_event_id)) error('public_entity_mapping.csv: unknown candidate_event_id at ' + row.mapping_id);
  if (row.mapping_status === 'CONFIRMED' && (!row.candidate_poi_id && !row.candidate_node_id && !row.candidate_event_id || /名称|同名/.test(row.match_basis))) error('public_entity_mapping.csv: CONFIRMED lacks explicit ID evidence at ' + row.mapping_id);
}


for (const row of events.rows) {
  if (row.source_tier === 'T2' && row.graph_version !== 'N/A') error(`Public event without internal binding needs graph_version N/A: ${row.source_id}`);
  if (row.verification_status === 'DYNAMIC_SCHEDULE_REQUIRED' && ['UNKNOWN','UNKNOWN_DYNAMIC',''].includes(row.start_time)) continue;
  if (row.record_kind === 'DYNAMIC_SCHEDULE_POLICY' && !['UNKNOWN','UNKNOWN_DYNAMIC'].includes(row.start_time)) warn(`Dynamic schedule has a concrete start_time: ${row.source_id}`);
}

const snapshotIds = unique(snapshots.rows, 'snapshot_id', 'source_snapshot_manifest.csv');
const snapshotSources = unique(snapshots.rows, 'source_id', 'source_snapshot_manifest.csv');
const t2ById = new Map(t2.map(row => [row.source_id, row]));
for (const row of t2) if (!snapshotSources.has(row.source_id)) error(`Missing T2 snapshot manifest row: ${row.source_id}`);
const missingSnapshotUrls = new Set();
const missingLocalEvidence = new Set();
const allowedSnapshotTypes = new Set(['NOT_CAPTURED','SCREENSHOT','HTML','PDF','TEXT_EXCERPT','MANUAL_RECORD']);
for (const row of snapshots.rows) {
  const source = t2ById.get(row.source_id);
  if (!source) { error(`Snapshot source_id is not T2: ${row.source_id}`); continue; }
  if (row.source_url !== source.source_url_or_path || row.query_date !== source.query_or_collection_date) error(`Snapshot lineage mismatch: ${row.source_id}`);
  if (!allowedSnapshotTypes.has(row.snapshot_type)) error(`Invalid snapshot_type: ${row.snapshot_id}`);
  if (row.snapshot_type === 'NOT_CAPTURED') {
    missingSnapshotUrls.add(row.source_url);
    if (row.local_snapshot_path !== 'NOT_CAPTURED' || row.captured_at !== 'NOT_CAPTURED' || row.review_status !== 'SNAPSHOT_REQUIRED' || row.content_checksum !== 'UNKNOWN') error(`Missing snapshot must be explicitly marked: ${row.snapshot_id}`);
  } else {
    if (!row.local_snapshot_path || row.local_snapshot_path === 'NOT_CAPTURED') error(`Captured snapshot lacks local path: ${row.snapshot_id}`);
    else try {
      const file = localPath(row.local_snapshot_path);
      const localOnly = row.snapshot_type === 'TEXT_EXCERPT' && ['LOCAL_EVIDENCE_ONLY','NOT_REPO_TRACKED','LICENSE_REVIEW_REQUIRED'].every(flag => row.notes.includes(flag));
      if (!/^[a-f0-9]{64}$/i.test(row.content_checksum || '') || !row.captured_at || row.captured_at === 'NOT_CAPTURED') error(`Captured evidence metadata incomplete: ${row.snapshot_id}`);
      if (!fs.existsSync(file)) {
        if (localOnly) missingLocalEvidence.add(row.local_snapshot_path);
        else error(`Snapshot file missing without local-only declaration: ${row.snapshot_id}`);
      } else {
        const buffer = fs.readFileSync(file);
        const actual = crypto.createHash('sha256').update(buffer).digest('hex');
        if (actual.toLowerCase() !== (row.content_checksum || '').toLowerCase()) error(`Snapshot checksum mismatch: ${row.snapshot_id}`);
      }
    } catch (cause) { error(`Snapshot cannot be checked: ${row.snapshot_id}: ${cause.message}`); }
  }
}
if (missingSnapshotUrls.size) warn(`${missingSnapshotUrls.size} independent T2 web pages have no local snapshot; snapshot capture/review remains required.`);
if (missingLocalEvidence.size) warn(`${missingLocalEvidence.size} locally retained excerpts are not present in this checkout; hashes cannot be checked here. See manifest notes.`);

const groups = new Map();
for (const row of sources.rows) {
  if (!row.entity_id || !row.field_name || !row.structured_value || ['MULTIPLE','record','node_record','edge_record','event_record'].includes(row.field_name)) continue;
  const key = `${row.entity_id}\u0000${row.field_name}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
for (const [key, rows] of groups) {
  const values = new Set(rows.map(row => row.structured_value));
  if (rows.length > 1 && values.size > 1) {
    const governed = rows.some(row => row.verification_status === 'CONFLICT_REVIEW_REQUIRED');
    const label = `${key.replace('\u0000',' + ')}: ${rows.map(row => row.source_id).join(', ')}`;
    conflicts.push({label, governed});
    if (!governed) warn(`Unreviewed source conflict: ${label}`);
  }
}

console.log('Data Source Governance Validation');
console.log(`Graph version: ${governance?.graph_version ?? 'UNKNOWN'}`);
console.log(`Operation mode: ${governance?.operation_mode ?? 'UNKNOWN'}`);
console.log('\nSources:');
for (const tier of ['T1','T2','T3','T4','UNKNOWN_SOURCE']) console.log(`${tier}: ${tiers[tier]}`);
console.log(`Independent T2 URLs: ${new Set(t2.map(row => row.source_url_or_path)).size}`);
console.log(`Edges checked: ${edges.rows.length}`);
console.log(`POIs checked: ${poiIds.size} distinct IDs / ${pois.rows.length} fact rows`);
console.log(`Events checked: ${events.rows.length}`);
console.log(`Snapshot manifest rows: ${snapshots.rows.length}`);
console.log(`Entity mappings: ${mappings.rows.length} (CONFIRMED=${mappings.rows.filter(row => row.mapping_status === 'CONFIRMED').length}, REVIEW_REQUIRED=${mappings.rows.filter(row => row.mapping_status === 'REVIEW_REQUIRED').length}, NO_MATCH=${mappings.rows.filter(row => row.mapping_status === 'NO_MATCH').length})`);
for (const item of conflicts) console.log(`CONFLICT${item.governed ? ' [governed]' : ' [review required]'}: ${item.label}`);
for (const message of warnings) console.log(`WARNING: ${message}`);
for (const message of errors) console.log(`ERROR: ${message}`);
console.log(`\nErrors: ${errors.length}`);
console.log(`Warnings: ${warnings.length}`);
console.log(`Conflicts: ${conflicts.length}`);
console.log(`Validation: ${errors.length ? 'FAIL' : 'PASS'}`);
process.exitCode = errors.length ? 1 : 0;
