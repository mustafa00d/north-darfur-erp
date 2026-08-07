import app from './server/app.js';
import db, { init } from './server/db.js';

const port = 3111;
process.env.CRON_SECRET = 'test-cron-secret';

await init();

await db.run('DELETE FROM users WHERE email != ?', ['admin@ndr.org']);
await db.run('DELETE FROM reports');
await db.run('DELETE FROM notifications');
await db.run('DELETE FROM activity_log');
await db.run('DELETE FROM cron_log');
await db.run('DELETE FROM localities WHERE name_ar = ?', ['محلية تجريبية']);

const server = app.listen(port, async () => {

  const base = `http://localhost:${port}`;
  let pass = 0, fail = 0;
  const results = [];

  async function api(path, method = 'GET', body = null, token = null, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
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
    const { runMondayJob } = await import('./server/cron.js');
    const login = await api('/api/auth/login', 'POST', { email: 'admin@ndr.org', password: 'Admin@5523' });
    const adminToken = login.data.token;

    const la = await api('/api/users', 'POST', {
      email: 'locadmin1@ndr.org', password: 'locadmin123', name: 'مشرف النهود', role: 'locality_admin', localityId: 2
    }, adminToken);
    check('create locality admin', la.status === 201, JSON.stringify(la.data));

    const u1 = await api('/api/users', 'POST', {
      email: 'cronuser@ndr.org', password: 'user12345', name: 'فريق النهود', localityId: 2
    }, adminToken);
    const u1Tok = u1.data?.token ? null : (await api('/api/auth/login', 'POST', { email: 'cronuser@ndr.org', password: 'user12345' })).data.token;

    const rep = await api('/api/reports', 'POST', {
      errName: 'تقرير اختبار كرون',
      localityId: 2,
      donorId: 1,
      supportTypeId: 1,
      partnerId: 1,
      monthId: 6,
      year: 2026,
      amountReceived: 5000,
      beneficiariesTotal: 120,
      beneficiariesMale: 50,
      beneficiariesFemale: 70,
      challenges: 'صعوبة في الوصول',
      positiveOutcomes: 'تحسن ملحوظ'
    }, u1Tok);
    check('report created', rep.status === 201, JSON.stringify(rep.data));

    const skipNotMonday = await runMondayJob({ now: new Date('2026-08-05T10:00:00Z') });
    check('skips non-Monday', skipNotMonday.skipped === true);

    const monday = new Date('2026-08-03T08:00:00Z');
    const job1 = await runMondayJob({ now: monday, force: true });
    check('job runs (forced Monday)', job1.ok === true, JSON.stringify(job1));

    const rejected = await db.get(
      `SELECT r.id, r.user_id FROM reports r JOIN users u ON u.id = r.user_id
       WHERE u.email = 'cronuser@ndr.org'`
    );
    await db.run(`UPDATE reports SET status = 'rejected' WHERE id = ?`, [rejected.id]);
    await db.run(`UPDATE reports SET created_at = ? WHERE id = ?`, [new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(), rejected.id]);

    const job2 = await runMondayJob({ now: new Date('2026-08-10T08:00:00Z'), force: true });
    check('rejected reminder sent', job2.rejectedReminded === 1, JSON.stringify(job2));
    const notifOwner = await db.get(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = 'تذكير بتقرير مرفوض'`,
      [rejected.user_id]
    );
    check('owner notified in-app', notifOwner.c === 1);

    await db.run(`UPDATE reports SET status = 'submitted', review_started_at = NULL WHERE id = ?`, [rejected.id]);
    const job3 = await runMondayJob({ now: new Date('2026-08-17T08:00:00Z'), force: true });
    check('pending reminder found old report', job3.pendingReminded === 1, JSON.stringify(job3));
    const notifReviewers = await db.get(
      `SELECT COUNT(*) AS c FROM notifications WHERE title = 'تقرير بانتظار المراجعة منذ فترة'`
    );
    check('reviewers notified (admin + locality admin)', notifReviewers.c === 2, `c=${notifReviewers.c}`);

    const job4 = await runMondayJob({ now: new Date('2026-08-17T12:00:00Z') });
    check('dedupe same week', job4.skipped === true && job4.reason === 'already-run', JSON.stringify(job4));

    const noSecret = await api('/api/cron/monday', 'POST');
    check('cron endpoint rejects without secret', noSecret.status === 401);

    const wrongSecret = await api('/api/cron/monday', 'POST', null, null, { 'x-cron-secret': 'wrong' });
    check('cron endpoint rejects wrong secret', wrongSecret.status === 401);

    const okSecret = await api('/api/cron/monday', 'POST', null, null, { 'x-cron-secret': 'test-cron-secret' });
    check('cron endpoint ok with secret', okSecret.status === 200 && (okSecret.data.skipped === true || okSecret.data.ok === true), JSON.stringify(okSecret.data));
  } catch (err) {
    fail++; results.push(`✘ استثناء غير متوقع: ${err.stack || err.message}`);
  }

  console.log(`\n=== CRON: ${pass} ✔ / ${fail} ✘ ===\n` + results.join('\n'));
  await new Promise(r => server.close(r));
  process.exit(fail ? 1 : 0);
});
