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
      ? ['scenic:read', 'route:plan', 'profile:write', 'scenic:manage', 'audit:read']
      : ['scenic:read', 'route:plan', 'profile:write'] };
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
  user.preferences = preferences;
  user.routeHistory.unshift({ planId: plan?.plan_id || null, createdAt: new Date().toISOString(),
    stops: (plan?.itinerary || []).map(step => step.target_node_id || step.target_id).filter(Boolean).slice(0, 30) });
  user.routeHistory = user.routeHistory.slice(0, 30);
  persist();
}
function listUsers() { return users.map(user => ({ ...publicUser(user), createdAt: user.createdAt })); }
module.exports = { createUser, login, logout, sessionUser, cookie, clearCookie, publicUser, profile, updateProfile, saveRoute, listUsers };
