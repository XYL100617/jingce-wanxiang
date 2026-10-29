const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

test('账号资料隔离、管理员边界和审计记录', async () => {
  const directory = fs.mkdtempSync(path.join(__dirname, '../data/.account-test-'));
  process.env.ACCOUNTS_FILE = path.join(directory, 'accounts.json');
  process.env.AUDIT_FILE = path.join(directory, 'audit.jsonl');
  process.env.COMMUNITY_FILE = path.join(directory, 'community.json');
  process.env.OPERATIONS_FILE = path.join(directory, 'operations.json');
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
    const sharing = await request('PATCH', '/api/account/profile', { consent: { sharing: true } }, visitorCookie);
    assert.equal(sharing.status, 200);
    const sharedProfile = await request('GET', '/api/community/profiles/visitor_one');
    assert.equal(sharedProfile.status, 200, 'sharing-consented profile must pass the public profile endpoint authorization check');
    assert.deepEqual(sharedProfile.body.stats, { published_routes: 0, likes_received: 0, favorites_received: 0 });
    const dnaListing = await request('GET', '/api/route-dna', undefined, visitorCookie);
    assert.equal(dnaListing.body.seeds.length, 8, 'DNA endpoint serves all eight checked seed routes');
    const seedId = dnaListing.body.seeds[0].id;
    assert.equal((await request('POST', `/api/community/dna-seeds/${seedId}/like`, { liked: true }, visitorCookie)).status, 200, 'a visitor can like a built-in DNA route');
    assert.equal((await request('POST', `/api/community/dna-seeds/${seedId}/favorite`, { saved: true }, visitorCookie)).status, 200, 'a visitor can save a built-in DNA route');
    const interactedDna = await request('GET', '/api/route-dna', undefined, visitorCookie);
    assert.equal(interactedDna.body.seeds[0].liked, true);
    assert.equal(interactedDna.body.seeds[0].saved, true);
    assert.equal(interactedDna.body.seeds[0].likes, 1);
    assert.equal(interactedDna.body.seeds[0].favorites, 1);
    assert.equal((await request('GET', '/api/route-dna', undefined, secondCookie)).body.seeds[0].liked, false, 'interactions are account-specific');
    assert.equal((await request('PATCH', '/api/account/profile', { consent: { sharing: false } }, visitorCookie)).status, 200);
    assert.equal((await request('GET', '/api/community/profiles/visitor_one')).status, 404, 'revoked sharing consent must hide the public profile');
    assert.equal((await request('POST', '/api/simulate-road-closure', { edge_id: 'edge_001' }, visitorCookie)).status, 403);
    assert.equal((await request('GET', '/api/admin/users', undefined, visitorCookie)).status, 403);
    const login = await request('POST', '/api/account/login', { username: 'manager_test', password: 'test-manager-pass-2026' });
    assert.equal(login.status, 200);
    const managerCookie = login.cookie.split(';')[0];
    const managerSharing = await request('PATCH', '/api/account/profile', { consent: { sharing: true } }, managerCookie);
    assert.equal(managerSharing.status, 200);
    const managerDna = await request('GET', '/api/route-dna', undefined, managerCookie);
    const managerSeed = managerDna.body.seeds[0];
    const managerRoute = await request('POST', '/api/community/routes', { title: '管理者分享路线测试', description: '接口权限验证', stops: managerSeed.stops, tags: managerSeed.tags.slice(0, 3) }, managerCookie);
    assert.equal(managerRoute.status, 201, 'a sharing-consented manager can publish a route recommendation');
    assert.equal(managerRoute.body.route.author_username, 'manager_test');
    assert.equal((await request('GET', '/api/community/me', undefined, managerCookie)).status, 403, 'manager route publishing does not grant visitor personal interaction access');
    assert.equal((await request('POST', `/api/community/routes/${managerRoute.body.route.id}/like`, {}, managerCookie)).status, 403, 'manager accounts still cannot use visitor route likes');
    assert.equal((await request('GET', '/api/community/me', undefined, managerCookie)).status, 403);
    assert.equal((await request('POST', '/api/admin/announcements', {}, visitorCookie)).status, 403);
    const users = await request('GET', '/api/admin/users', undefined, managerCookie);
    assert.equal(users.status, 200);
    assert.equal(users.body.users.length, 3);
    assert.ok(users.body.users.every(user => !('passwordHash' in user)));
    assert.equal((await request('POST', '/api/simulate-road-closure', { edge_id: 'edge_001' }, managerCookie)).status, 200);
    const announcement = await request('POST', '/api/admin/announcements', { title: '集成测试公告', content: '只用于接口验证', source: 'test fixture', effective_from: new Date(Date.now() - 1000).toISOString(), effective_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(), review_status: 'pending' }, managerCookie);
    assert.equal(announcement.status, 201);
    assert.equal((await request('GET', '/api/operations')).body.announcements.length, 0);
    assert.equal((await request('PATCH', `/api/admin/announcements/${announcement.body.announcement.id}`, { review_status: 'approved' }, managerCookie)).status, 200);
    assert.equal((await request('GET', '/api/operations')).body.announcements.length, 1);
    assert.equal((await request('DELETE', `/api/admin/announcements/${announcement.body.announcement.id}`, undefined, managerCookie)).status, 200);
    const audit = await request('GET', '/api/admin/audit', undefined, managerCookie);
    assert.equal(audit.status, 200);
    assert.ok(audit.body.entries.some(entry => entry.action === 'scenic.road_close' && entry.target === 'edge_001'));
    assert.ok(audit.body.entries.some(entry => entry.action === 'permission.denied'));
    const exportData = await request('GET', '/api/account/export', undefined, visitorCookie);
    assert.equal(exportData.status, 200);
    assert.equal(exportData.body.account.username, 'visitor_one');
    assert.ok('community' in exportData.body);
    const deleteAccount = await request('DELETE', '/api/account/me', { password: 'wrong-password' }, secondCookie);
    assert.equal(deleteAccount.status, 401);
    assert.equal((await request('GET', '/api/account/me', undefined, secondCookie)).body.user.role, 'visitor');
    const deleted = await request('DELETE', '/api/account/me', { password: 'visitor-pass-2027' }, secondCookie);
    assert.equal(deleted.status, 200);
    assert.equal((await request('GET', '/api/account/me', undefined, secondCookie)).body.user.role, 'guest');
    assert.equal((await request('DELETE', '/api/account/me', { password: 'test-manager-pass-2026' }, managerCookie)).status, 403);
    assert.equal((await request('POST', '/api/account/logout', {}, visitorCookie)).status, 200);
    assert.equal((await request('GET', '/api/account/me', undefined, visitorCookie)).body.user.role, 'guest');
  } finally {
    delete process.env.ACCOUNTS_FILE;
    delete process.env.AUDIT_FILE;
    delete process.env.COMMUNITY_FILE;
    delete process.env.OPERATIONS_FILE;
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
