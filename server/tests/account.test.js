const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

test('账号资料隔离、管理员边界和审计记录', async () => {
  const directory = fs.mkdtempSync(path.join(__dirname, '../data/.account-test-'));
  process.env.ACCOUNTS_FILE = path.join(directory, 'accounts.json');
  process.env.AUDIT_FILE = path.join(directory, 'audit.jsonl');
  process.env.ADMIN_USERNAME = 'manager_test';
  process.env.ADMIN_PASSWORD = 'test-manager-pass-2026';
  const { server } = require('../index');
  async function request(method, url, body, session = '') {
    return new Promise(resolve => {
      const req = new EventEmitter();
      Object.assign(req, { method, url, headers: { host: 'localhost', cookie: session }, socket: { encrypted: false } });
      const headers = {};
      let status;
      server.emit('request', req, {
        setHeader(name, value) { headers[name.toLowerCase()] = value; },
        writeHead(code) { status = code; },
        end(value) { resolve({ status, body: JSON.parse(value), cookie: headers['set-cookie'] }); }
      });
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  try {
    const guest = await request('GET', '/api/account/me');
    assert.equal(guest.body.user.role, 'guest');
    const register = await request('POST', '/api/account/register', { username: 'visitor_one', password: 'visitor-pass-2026', displayName: '测试游客' });
    assert.equal(register.status, 201);
    assert.equal(register.body.user.role, 'visitor');
    assert.ok(register.cookie.includes('HttpOnly'));
    const visitorCookie = register.cookie.split(';')[0];
    const second = await request('POST', '/api/account/register', { username: 'visitor_two', password: 'visitor-pass-2027' });
    const secondCookie = second.cookie.split(';')[0];
    const profile = await request('PATCH', '/api/account/profile', { consent: { location: true } }, visitorCookie);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.consent.location, true);
    assert.equal((await request('GET', '/api/account/me', undefined, secondCookie)).body.profile.consent.location, false);
    assert.equal((await request('POST', '/api/simulate-road-closure', { edge_id: 'edge_001' }, visitorCookie)).status, 403);
    assert.equal((await request('GET', '/api/admin/users', undefined, visitorCookie)).status, 403);
    const login = await request('POST', '/api/account/login', { username: 'manager_test', password: 'test-manager-pass-2026' });
    assert.equal(login.status, 200);
    const managerCookie = login.cookie.split(';')[0];
    const users = await request('GET', '/api/admin/users', undefined, managerCookie);
    assert.equal(users.status, 200);
    assert.equal(users.body.users.length, 3);
    assert.ok(users.body.users.every(user => !('passwordHash' in user)));
    assert.equal((await request('POST', '/api/simulate-road-closure', { edge_id: 'edge_001' }, managerCookie)).status, 200);
    const audit = await request('GET', '/api/admin/audit', undefined, managerCookie);
    assert.equal(audit.status, 200);
    assert.ok(audit.body.entries.some(entry => entry.action === 'scenic.road_close' && entry.target === 'edge_001'));
    assert.ok(audit.body.entries.some(entry => entry.action === 'permission.denied'));
    assert.equal((await request('POST', '/api/account/logout', {}, visitorCookie)).status, 200);
    assert.equal((await request('GET', '/api/account/me', undefined, visitorCookie)).body.user.role, 'guest');
  } finally {
    delete process.env.ACCOUNTS_FILE;
    delete process.env.AUDIT_FILE;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
