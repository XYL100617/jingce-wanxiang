const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_FILE = process.env.ACCOUNTS_FILE || path.join(__dirname, 'data', 'accounts.local.json');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
let users = [];
try { users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).users || []; } catch (error) { if (error.code !== 'ENOENT') throw error; }

function persist() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, users }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
// Rename the shipped demo manager without changing its ID or password hash.
// Existing sessions remain associated with the same account ID.
const legacyManager = users.find(user => user.role === 'manager' && user.username === 'scenic_admin');
if (legacyManager && !users.some(user => user.username === 'admin' && user.id !== legacyManager.id)) {
  legacyManager.username = 'admin';
  persist();
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function validPassword(user, password) {
  if (!user || typeof password !== 'string') return false;
  const actual = crypto.scryptSync(password, user.passwordSalt, 64);
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function publicUser(user) {
  if (!user) return { id: null, username: null, displayName: '游客', role: 'guest', permissions: ['scenic:read', 'route:plan'] };
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role,
    permissions: user.role === 'manager'
      ? ['scenic:read', 'route:plan', 'profile:write', 'scenic:manage', 'audit:read', 'community:moderate', 'community:publish']
      : ['scenic:read', 'route:plan', 'profile:write', 'community:interact', 'community:publish'] };
}
function createUser(username, password, displayName, role = 'visitor') {
  const normalized = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(normalized)) throw Object.assign(new Error('账号只能使用 3–32 位小写字母、数字或下划线'), { statusCode: 400 });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw Object.assign(new Error('密码长度须为 8–128 位'), { statusCode: 400 });
  if (users.some(item => item.username === normalized)) throw Object.assign(new Error('账号已存在'), { statusCode: 409 });
  const name = String(displayName || normalized).trim();
  if (!name || name.length > 30) throw Object.assign(new Error('昵称长度须为 1–30 字'), { statusCode: 400 });
  const credential = hashPassword(password);
  const user = { id: crypto.randomUUID(), username: normalized, displayName: name, role,
    passwordSalt: credential.salt, passwordHash: credential.hash, createdAt: new Date().toISOString(),
    consent: { location: false, feedback: false, sharing: false }, preferences: null, routeHistory: [] };
  users.push(user); persist();
  return user;
}
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && !users.some(user => user.role === 'manager')) {
  createUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, process.env.ADMIN_DISPLAY_NAME || '景区管理员', 'manager');
}
function login(username, password) {
  const user = users.find(item => item.username === String(username || '').trim().toLowerCase());
  if (!validPassword(user, password)) throw Object.assign(new Error('账号或密码错误'), { statusCode: 401 });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, expires: Date.now() + SESSION_MS });
  return { user, token };
}
function sessionUser(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('jw_session='));
  const token = cookie?.slice('jw_session='.length);
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expires <= Date.now()) { sessions.delete(token); return null; }
  return users.find(user => user.id === session.userId) || null;
}
function logout(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('jw_session='));
  if (cookie) sessions.delete(cookie.slice('jw_session='.length));
}
function cookie(token, req) { return `jw_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${req.socket.encrypted ? '; Secure' : ''}`; }
function clearCookie() { return 'jw_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'; }
function updateProfile(user, input) {
  if (input.displayName !== undefined) {
    const name = String(input.displayName).trim();
    if (!name || name.length > 30) throw Object.assign(new Error('昵称长度须为 1–30 字'), { statusCode: 400 });
    user.displayName = name;
  }
  if (input.consent !== undefined) {
    if (!input.consent || typeof input.consent !== 'object' || Array.isArray(input.consent) ||
      Object.keys(input.consent).some(key => !['location', 'feedback', 'sharing'].includes(key) || typeof input.consent[key] !== 'boolean'))
      throw Object.assign(new Error('consent 只能包含 location、feedback、sharing 三个布尔值'), { statusCode: 400 });
    user.consent = { ...user.consent, ...input.consent };
  }
  persist();
  return profile(user);
}
function profile(user) { return { ...publicUser(user), consent: user.consent, preferences: user.preferences, routeHistory: user.routeHistory }; }
function saveRoute(user, plan, preferences) {
  if (!user) return;
  if (preferences) user.preferences = preferences;
  const stops = [...new Set((plan?.itinerary || []).map(step => step.target_node_id || step.target_id).filter(Boolean))].slice(0, 30);
  user.routeHistory.unshift({ planId: plan?.plan_id || null, createdAt: new Date().toISOString(), stops });
  user.routeHistory = user.routeHistory.slice(0, 30);
  persist();
}
function listUsers() { return users.map(user => ({ ...publicUser(user), createdAt: user.createdAt })); }
function findShareableProfile(username) {
  const normalized = String(username || '').trim().toLowerCase();
  const user = users.find(item => item.username === normalized && item.consent?.sharing === true);
  return user ? { id: user.id, username: user.username, displayName: user.displayName, consent: { sharing: true } } : null;
}
function getUserById(id) { return users.find(user => user.id === id) || null; }
function deleteUser(user, password, beforeDelete = () => {}) {
  if (!user || user.role !== 'visitor') throw Object.assign(new Error('仅普通游客账号可自行删除；管理者账号需由组织管理员处理'), { statusCode: 403 });
  if (!validPassword(user, password)) throw Object.assign(new Error('密码验证失败，未删除账号'), { statusCode: 401 });
  beforeDelete();
  const index = users.findIndex(item => item.id === user.id);
  if (index < 0) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
  users.splice(index, 1);
  for (const [token, session] of sessions) if (session.userId === user.id) sessions.delete(token);
  persist();
  return { id: user.id, username: user.username };
}
module.exports = { createUser, login, logout, sessionUser, cookie, clearCookie, publicUser, profile, updateProfile, saveRoute, listUsers, findShareableProfile, getUserById, deleteUser };
