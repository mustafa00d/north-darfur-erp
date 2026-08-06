import app from './server/app.js';
import db, { init } from './server/db.js';
import crypto from 'crypto';

const port = 3200;

await init();

// تنظيف قاعدة البيانات لاختبارات الأمان القطعية
await db.run('DELETE FROM users WHERE email != ?', ['admin@ndr.org']);
await db.run('DELETE FROM reports');
await db.run('DELETE FROM notifications');
await db.run('DELETE FROM activity_log');
await db.run('DELETE FROM share_links');
await db.run('DELETE FROM password_resets');

const server = app.listen(port, async () => {

  const base = `http://localhost:${port}`;
  let pass = 0, fail = 0;
  const results = [];

  async function api(path, method = 'GET', body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }

  function check(name, cond, extra = '') {
    if (cond) { pass++; results.push(`✔ ${name}`); }
    else { fail++; results.push(`✘ ${name} ${extra}`); }
  }

  try {
    // 1. Login admin
    const login = await api('/api/auth/login', 'POST', { email: 'admin@ndr.org', password: 'Admin@5523' });
    check('admin login', login.status === 200 && login.data.token);
    const adminToken = login.data.token;

    // 2. Create user for lockout tests
    const newUser = await api('/api/users', 'POST', {
      email: 'lock@ndr.org', password: 'lock12345', name: 'مستخدم الاختبار', localityId: 1
    }, adminToken);
    check('create lock-test user', newUser.status === 201);

    // 3. Lockout: 4 wrong attempts -> 401
    let lastStatus = 0;
    for (let i = 0; i < 4; i++) {
      const r = await api('/api/auth/login', 'POST', { email: 'lock@ndr.org', password: 'wrongpass' });
      lastStatus = r.status;
    }
    check('4 wrong attempts rejected (401)', lastStatus === 401);

    // 4. 5th wrong attempt -> locked (429)
    const fifth = await api('/api/auth/login', 'POST', { email: 'lock@ndr.org', password: 'wrongpass' });
    check('5th attempt locks account (429)', fifth.status === 429, JSON.stringify(fifth.data));
    check('lock message mentions minutes', /دقيقة/.test(fifth.data?.error || ''));

    // 5. Correct password while locked -> still 429
    const lockedGood = await api('/api/auth/login', 'POST', { email: 'lock@ndr.org', password: 'lock12345' });
    check('correct password still locked (429)', lockedGood.status === 429);

    // 6. failed_attempts reset after lock, locked_until set
    const lockedUser = await db.get('SELECT * FROM users WHERE email = ?', ['lock@ndr.org']);
    check('lock recorded in db', !!lockedUser.locked_until && (lockedUser.failed_attempts || 0) === 0, JSON.stringify(lockedUser));

    // 7. Manual unlock then login works (new user flag must_change_password = 1)
    await db.run('UPDATE users SET locked_until = NULL WHERE email = ?', ['lock@ndr.org']);
    const afterUnlock = await api('/api/auth/login', 'POST', { email: 'lock@ndr.org', password: 'lock12345' });
    check('login works after unlock', afterUnlock.status === 200);
    check('new user mustChangePassword flag', afterUnlock.data.user?.mustChangePassword === true, JSON.stringify(afterUnlock.data.user));

    // 8. Forgot-password generic response (unregistered email)
    const forgotGhost = await api('/api/auth/forgot-password', 'POST', { email: 'ghost@ndr.org' });
    check('forgot (unregistered) generic ok', forgotGhost.status === 200 && forgotGhost.data.success);

    // 9. Forgot-password registered (SMTP unconfigured -> logs only, still 200)
    const forgotReal = await api('/api/auth/forgot-password', 'POST', { email: 'lock@ndr.org' });
    check('forgot (registered) ok', forgotReal.status === 200 && forgotReal.data.success);

    // 10. Reset-password flow with valid token
    const resetToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expires = new Date(Date.now() + 3600 * 1000).toISOString();
    const row = await db.get('SELECT id FROM users WHERE email = ?', ['lock@ndr.org']);
    await db.run('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [row.id, tokenHash, expires]);

    const reset = await api('/api/auth/reset-password', 'POST', { token: resetToken, newPassword: 'newpass99' });
    check('reset-password success', reset.status === 200);

    const relogin = await api('/api/auth/login', 'POST', { email: 'lock@ndr.org', password: 'newpass99' });
    check('login with new password', relogin.status === 200);

    // 11. Token reuse rejected
    const reuse = await api('/api/auth/reset-password', 'POST', { token: resetToken, newPassword: 'another99' });
    check('reset token single use', reuse.status === 400);

    // 12. Reset with invalid token rejected
    const badReset = await api('/api/auth/reset-password', 'POST', { token: 'not-a-token', newPassword: 'another99' });
    check('invalid reset token rejected', badReset.status === 400);

    // 13. Share link with password
    const share = await api('/api/share', 'POST', {
      name: 'رابط محمي', expiryHours: 24, shareReports: true, shareAnalytics: false, shareUsers: false,
      password: 'secret123'
    }, adminToken);
    check('create protected share link', share.status === 201 && share.data.hasPassword === true, JSON.stringify(share.data));
    const token = share.data?.token;

    // 15. Public GET -> requiresPassword, no data leak
    const pub = await api(`/api/share/public/${token}`);
    check('public GET requires password', pub.status === 200 && pub.data.requiresPassword === true && !pub.data.reports, JSON.stringify(pub.data));

    // 16. Wrong password rejected
    const wrong = await api(`/api/share/public/${token}/auth`, 'POST', { password: 'nope' });
    check('share wrong password 401', wrong.status === 401);

    // 17. Correct password unlocks data
    const good = await api(`/api/share/public/${token}/auth`, 'POST', { password: 'secret123' });
    check('share correct password unlocks', good.status === 200 && Array.isArray(good.data.reports));

    // 18. view_count increments only on successful access
    const linkRow = await db.get('SELECT view_count FROM share_links WHERE token = ?', [token]);
    check('view_count counts one access', linkRow.view_count === 1, `view_count=${linkRow.view_count}`);

    // 19. Deleted link -> neutral unavailable (404)
    await db.run('DELETE FROM share_links WHERE token = ?', [token]);
    const gone = await api(`/api/share/public/${token}`);
    check('deleted link returns neutral 404', gone.status === 404 && gone.data.error.includes('الرابط غير متاح'), JSON.stringify(gone.data));

    // 20. Expired link -> neutral unavailable (410)
    const expired = await api('/api/share', 'POST', { name: 'رابط منتهي', expiryHours: 1, shareReports: true }, adminToken);
    await db.run("UPDATE share_links SET expires_at = ? WHERE token = ?",
      [new Date(Date.now() - 60000).toISOString(), expired.data.token]);
    const expPub = await api(`/api/share/public/${expired.data.token}`);
    check('expired link returns neutral 410', expPub.status === 410 && expPub.data.error.includes('الرابط غير متاح'), JSON.stringify(expPub.data));

  } catch (e) {
    fail++;
    results.push(`✘ EXCEPTION: ${e.message}`);
  }

  console.log(results.join('\n'));
  console.log(`\n===== النتيجة: ${pass} ناجح / ${fail} فشل =====`);

  await db.run('DELETE FROM users WHERE email != ?', ['admin@ndr.org']);
  await db.run('DELETE FROM reports');
  await db.run('DELETE FROM notifications');
  await db.run('DELETE FROM activity_log');
  await db.run('DELETE FROM share_links');
  await db.run('DELETE FROM password_resets');

  process.exit(fail > 0 ? 1 : 0);
});
