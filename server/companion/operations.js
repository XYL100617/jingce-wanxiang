'use strict';

// Operational messages live outside the knowledge base and expire explicitly.
const fs = require('node:fs');
const path = require('node:path');
function createOperations({ now = () => Date.now(), readIncidents = () => [], file = process.env.OPERATIONS_FILE || path.join(__dirname, '..', 'data', 'operations.local.json') } = {}) {
  let loaded = [];
  try { loaded = JSON.parse(fs.readFileSync(file, 'utf8')).announcements || []; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const announcements = new Map(loaded.map(item => [item.id, item]));
  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schema_version: 1, announcements: [...announcements.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  function publish(input) {
    const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('公告必须是对象');
    for (const key of ['title', 'content', 'source']) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > (key === 'content' ? 1000 : 160)) invalid(`${key} 必须是有效文本`);
    }
    const from = Date.parse(input.effective_from), until = Date.parse(input.effective_until);
    if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) invalid('公告必须具有有效且递增的生效、失效时间');
    if (!['approved', 'pending'].includes(input.review_status)) invalid('review_status 须为 approved 或 pending');
    if (announcements.size >= 200) invalid('公告已达到 200 条上限，请清理旧公告');
    const entry = {
      id: require('node:crypto').randomUUID(), title: input.title.trim(), content: input.content.trim(),
      source: input.source.trim(), effective_from: new Date(from).toISOString(), effective_until: new Date(until).toISOString(),
      review_status: input.review_status, updated_at: new Date(now()).toISOString(), mode: 'demo',
    };
    announcements.set(entry.id, entry);
    persist();
    return structuredClone(entry);
  }
  function setReviewStatus(id, status) {
    if (!['approved', 'pending'].includes(status)) throw Object.assign(new Error('review_status 须为 approved 或 pending'), { statusCode: 400 });
    const entry = announcements.get(id);
    if (!entry) throw Object.assign(new Error('没有找到这条公告'), { statusCode: 404 });
    entry.review_status = status;
    entry.updated_at = new Date(now()).toISOString();
    persist();
    return structuredClone(entry);
  }
  function read() {
    const time = now();
    return {
      announcements: [...announcements.values()].filter(item => item.review_status === 'approved' && Date.parse(item.effective_from) <= time && time < Date.parse(item.effective_until)),
      incidents: readIncidents().filter(item => item.status === 'active').map(item => ({
        incident_id: item.incident_id, incident_type: item.incident_type, severity: item.severity,
        scope: item.scope, status: item.status, source: item.source, started_at: item.started_at,
      })),
      as_of: new Date(time).toISOString(), mode: 'demo',
    };
  }
  function remove(id) { const changed = announcements.delete(id); if (changed) persist(); return changed; }
  return { publish, read, list: () => [...announcements.values()].map(item => structuredClone(item)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), setReviewStatus, remove };
}

module.exports = { createOperations };
