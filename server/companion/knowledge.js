'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CATEGORIES = Object.freeze(['official', 'facilities', 'hours', 'performances', 'guide', 'culture', 'emergency']);
const REVIEW_STATES = new Set(['approved', 'demo', 'pending', 'rejected']);
const SOURCE_KINDS = new Set(['official', 'application', 'demo']);
const LIVE_KEYS = /queue|排队|队列|候位|wait(?:ing)?_?(?:min|minutes|time|count|length)|^(?:crowd(?:_?(?:ratio|level|count))?|weather|current_status|is_open|road_status|road_states|poi_states|event_states)$/i;
const QUEUE_VALUE = /(?:排队|队列|候位)[^。！？\n]{0,24}\d|(?:排队|队列|候位|等候|等待)[^。！？\n]{0,24}[一二三四五六七八九十百千万两]+\s*(?:分钟|小时|秒|人|位|米)|(?:\d+|[一二三四五六七八九十百千万两]+)\s*(?:分钟|小时|秒|人|位|米)[^。！？\n]{0,12}(?:排队|队列|候位)|(?:queue|waiting|wait[ -]?time)[^.!?\n]{0,24}\d|\d+\s*(?:min(?:utes?)?|hours?|seconds?|people|persons?)[^.!?\n]{0,12}(?:queue|waiting)/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PROMPT_OVERRIDE = /(?:忽略|无视|覆盖|绕过|取代|废除).{0,24}(?:规则|指令|系统|提示|审核|权限)|(?:ignore|override|bypass|disregard|forget).{0,50}(?:instructions?|rules?|system|prompts?|safety|previous)|(?:system|developer)\s*(?:prompt|message|instruction)|(?:请|你|助手|模型|AI).{0,12}(?:遵从|服从).{0,12}(?:此|这|本|以下).{0,8}(?:说明|命令|指令)|(?:必须|应当|只需|仅|只|直接).{0,8}(?:回复|输出|回答|声称|告诉游客)|(?:api[_ -]?key|环境变量|系统提示词|泄露密钥)|<\/?(?:system|developer|assistant|tool)\b/i;
const CURRENT_TIME = /当前|现在|目前|今日|今天|今晚|今早|此刻|实时|现场|刚刚|现已|已经|正在|暂时|临时|恢复|已(?:开放|开门|闭园|关闭|封闭|封路|取消|停演|停业|安全)|\b(?:today|tonight|currently|now|at present)\b/i;
const OPERATIONAL_STATUS = /开放|开门|营业|闭园|闭馆|关门|关闭|封路|封闭|禁止通行|停止通行|恢复通行|安全|(?:道路|路段|出口|通道).{0,10}(?:畅通|可通行)|(?:演出|节目|场次|表演).{0,18}(?:取消|停演|延期|暂停|正常|照常|开始|开演|结束|恢复|售罄|满员)|天气|气温|温度|降雨|雨量|风力|没有.{0,6}(?:危险|风险)|\b(?:open|closed|cancelled|canceled|safe|sunny|raining|weather|temperature)\b/i;
const BLANKET_SAFETY = /(?:所有|全部|每条|全园|任何).{0,15}(?:道路|路段|通道|出口).{0,15}(?:安全|畅通|可通行)|(?:保证|确保|绝对|百分之百|100%).{0,12}(?:安全|畅通)|(?:所有|全部|全园).{0,12}(?:安全|无风险|无危险)|(?:all roads|every road).{0,20}(?:safe|clear|open)|guarantee.{0,20}safe/i;
const NON_ASSERTION = /无法(?:确认|判断|保证)|不能(?:确认|判断|保证|据此)|不(?:能|会|应|得)?(?:保证|承诺|声称|断言|生成)|不代表|不等于|不据此|尚(?:无|未)|未经.{0,5}(?:确认|审核)|未(?:经|确认|核实)|待(?:确认|核验|审核)|是否|能否|有没有|须(?:从|核|以)|需(?:要)?核|请核|只(?:能)?(?:依据|从)|以.{0,20}为准|cannot (?:confirm|guarantee)|not (?:confirmed|guaranteed)|unconfirmed/i;

const copy = value => JSON.parse(JSON.stringify(value));
const isText = value => typeof value === 'string' && value.trim().length > 0;
function isInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour < 24 && minute < 60 && second < 60;
}

function validateKnowledgeText(value) {
  if (typeof value !== 'string') return { valid: true, errors: [] };
  const text = value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  const errors = [];
  if (PROMPT_OVERRIDE.test(text)) errors.push('contains a prompt override or protected system reference');
  // A current assertion cannot become a static fact merely by marking a source
  // approved. Split clauses so an earlier disclaimer cannot bless a later claim.
  const clauses = text.split(/[。！？!?；;\n，,]|但是|不过|然而|但|事实上|实际上|其实|同时|并且/);
  if (clauses.some(clause => !NON_ASSERTION.test(clause) && (BLANKET_SAFETY.test(clause) || (CURRENT_TIME.test(clause) && OPERATIONAL_STATUS.test(clause))))) {
    errors.push('contains a realtime operational or blanket safety assertion');
  }
  return { valid: errors.length === 0, errors };
}

function validateKnowledgeRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { valid: false, errors: ['record must be an object'] };
  for (const key of ['id', 'title', 'content']) if (!isText(record[key])) errors.push(`${key} must be non-empty text`);
  if (typeof record.content === 'string' && record.content.length > 8000) errors.push('content exceeds 8000 characters');
  if (!CATEGORIES.includes(record.category)) errors.push('unknown category');
  if (!Array.isArray(record.node_ids) || !record.node_ids.every(isText)) errors.push('node_ids must be an array of node identifiers');
  if (!Array.isArray(record.keywords) || !record.keywords.every(isText)) errors.push('keywords must be an array of text');
  for (const key of ['title', 'content']) {
    for (const error of validateKnowledgeText(record[key]).errors) errors.push(`${key} ${error}`);
  }
  if (!REVIEW_STATES.has(record.review_status)) errors.push('unknown review_status');
  if (!isInstant(record.effective_from)) errors.push('effective_from must include an explicit timezone');
  if (record.effective_until !== null && !isInstant(record.effective_until)) errors.push('effective_until must be null or a timestamp with timezone');
  if (isInstant(record.effective_from) && isInstant(record.effective_until) && Date.parse(record.effective_until) <= Date.parse(record.effective_from)) errors.push('effective_until must be later than effective_from');
  const source = record.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) errors.push('source is required');
  else {
    for (const key of ['id', 'title', 'locator']) if (!isText(source[key])) errors.push(`source.${key} is required`);
    if (!SOURCE_KINDS.has(source.kind)) errors.push('unknown source.kind');
    if (typeof source.verified !== 'boolean') errors.push('source.verified must be boolean');
    if (source.kind === 'demo' && record.review_status !== 'demo') errors.push('demo sources require demo review status');
    if (record.review_status === 'demo' && source.kind !== 'demo') errors.push('demo records require a demo source');
    if (record.review_status === 'approved' && source.verified !== true) errors.push('approved records require a verified source');
    if (record.category === 'official' && source.kind !== 'official') errors.push('official facts require an official source');
  }
  // Live queues and operational state belong to the state/operations APIs, even
  // when someone tries to hide a value in nested metadata or a prose snippet.
  function inspect(value, location) {
    if (typeof value === 'string' && QUEUE_VALUE.test(value)) errors.push(`${location} contains a queue value`);
    else if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (LIVE_KEYS.test(key)) errors.push(`${location}.${key} is a realtime field`);
        inspect(nested, `${location}.${key}`);
      }
    }
  }
  inspect(record, 'record');
  return { valid: errors.length === 0, errors };
}

function loadKnowledgeRecords(directory = path.join(__dirname, '..', 'data', 'companion')) {
  const collections = CATEGORIES.flatMap(category => {
    const file = path.join(directory, `${category}.json`);
    const document = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (document.category !== category || !Array.isArray(document.records)) throw new Error(`Invalid companion knowledge collection: ${category}`);
    if (document.records.some(record => record.category !== category)) throw new Error(`Companion record is in the wrong category: ${category}`);
    return document.records;
  });
  const scenicGuideFile = path.join(directory, 'scenic-guide.json');
  if (fs.existsSync(scenicGuideFile)) {
    const document = JSON.parse(fs.readFileSync(scenicGuideFile, 'utf8').replace(/^\uFEFF/, ''));
    if (document.schema_version !== '1.0' || !Array.isArray(document.records)
      || document.records.some(record => !['culture', 'facilities', 'guide'].includes(record.category))) {
      throw new Error('Invalid supplemental scenic guide collection');
    }
    collections.push(...document.records);
  }
  return collections;
}

function timeValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return isInstant(value) ? Date.parse(value) : Number.NaN;
}

function normalized(value) {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(value) {
  const text = normalized(value);
  return new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
}

function basis(record) {
  return {
    source_id: record.source.id, source_title: record.source.title,
    source_kind: record.source.kind, locator: record.source.locator,
    review_status: record.review_status, verified: record.source.verified,
    effective_from: record.effective_from, effective_until: record.effective_until,
    demo: record.source.kind === 'demo',
  };
}

function createKnowledgeBase({ now = () => new Date(), records = loadKnowledgeRecords() } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const valid = [];
  const rejected = [];
  const ids = new Set();
  for (const input of records) {
    const validation = validateKnowledgeRecord(input);
    if (ids.has(input?.id)) validation.errors.push('duplicate record id');
    if (validation.errors.length) rejected.push({ id: typeof input?.id === 'string' ? input.id : null, errors: validation.errors });
    else { ids.add(input.id); valid.push(copy(input)); }
  }
  const instant = options => timeValue(options.now === undefined ? (typeof now === 'function' ? now() : now) : options.now);
  function eligible(record, options, at) {
    if (!Number.isFinite(at) || Date.parse(record.effective_from) > at || (record.effective_until !== null && Date.parse(record.effective_until) <= at)) return false;
    if (record.review_status !== 'approved' && !(options.mode === 'demo' && record.review_status === 'demo')) return false;
    if (options.categories && (!Array.isArray(options.categories) || !options.categories.includes(record.category))) return false;
    const nodeId = options.nodeId || options.poiId;
    return !nodeId || record.node_ids.length === 0 || record.node_ids.includes(nodeId);
  }
  function list(options = {}) {
    const at = instant(options);
    return valid.filter(record => eligible(record, options, at)).map(record => ({ ...copy(record), basis: basis(record) }));
  }
  function search(query, options = {}) {
    const question = normalized(query);
    const grams = bigrams(question);
    const nodeId = options.nodeId || options.poiId;
    const genericIntroduction = /^(?:介绍|讲解|这里|当前景点|这个景点|说说|看看|tellmeabout|introduce)/i.test(question);
    const ranked = list(options).map(record => {
      let score = 0;
      if (question && normalized(record.title).includes(question)) score += 12;
      for (const keyword of record.keywords) {
        const word = normalized(keyword);
        if (word.length >= 2 && question.includes(word)) score += Math.min(8, word.length + 2);
      }
      const recordGrams = bigrams([record.title, ...record.keywords].join(' '));
      const overlap = [...grams].filter(gram => recordGrams.has(gram)).length;
      if (overlap >= 2) score += Math.min(6, overlap);
      const nodeMatch = Boolean(nodeId && record.node_ids.includes(nodeId));
      if (!question || (nodeMatch && genericIntroduction)) score += 1;
      if (score > 0 && nodeMatch) score += 5;
      return { ...record, score };
    }).filter(record => record.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const limit = Number.isInteger(options.limit) ? Math.min(20, Math.max(0, options.limit)) : 4;
    return ranked.slice(0, limit);
  }
  function status(options = {}) {
    const available = list(options);
    return {
      total: records.length, valid: valid.length, rejected: rejected.length,
      available: available.length, mode: options.mode === 'demo' ? 'demo' : 'reviewed',
      categories: Object.fromEntries(CATEGORIES.map(category => [category, {
        total: valid.filter(record => record.category === category).length,
        available: available.filter(record => record.category === category).length,
      }])),
      review_status: Object.fromEntries([...REVIEW_STATES].map(state => [state, valid.filter(record => record.review_status === state).length])),
      validation_errors: copy(rejected),
    };
  }
  return Object.freeze({ search, list, status, get: (id, options = {}) => list(options).find(record => record.id === id) || null });
}

module.exports = { CATEGORIES, createKnowledgeBase, loadKnowledgeRecords, validateKnowledgeRecord, validateKnowledgeText };
