import app from './server/app.js';
import db, { init } from './server/db.js';

const port = 3100;

await init();

// تنظيف قاعدة البيانات للاختبارات القطعية
await db.run('DELETE FROM users WHERE email != ?', ['admin@ndr.org']);
await db.run('DELETE FROM reports');
await db.run('DELETE FROM notifications');
await db.run('DELETE FROM activity_log');
await db.run('DELETE FROM share_links');
await db.run('DELETE FROM localities WHERE name_ar = ?', ['محلية تجريبية']);

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
    check('admin login', login.status === 200 && login.data.token, JSON.stringify(login.data));
    const adminToken = login.data.token;

    // 2. Wrong password
    const badLogin = await api('/api/auth/login', 'POST', { email: 'admin@ndr.org', password: 'wrong' });
    check('wrong password rejected', badLogin.status === 401);

    // 3. Meta
    const meta = await api('/api/meta', 'GET', null, adminToken);
    check('meta (16 localities)', meta.status === 200 && meta.data.localities.length === 16, JSON.stringify(meta.data?.localities?.length));
    check('meta donors (6)', meta.data?.donors?.length === 6);
    check('meta sectors (8)', meta.data?.supportTypes?.length === 8);

    // 4. Create user
    const newUser = await api('/api/users', 'POST', {
      email: 'user1@ndr.org', password: 'user12345', name: 'فريق الفاشر', localityId: 1
    }, adminToken);
    check('create user', newUser.status === 201, JSON.stringify(newUser.data));

    // 5. Login new user
    const userLogin = await api('/api/auth/login', 'POST', { email: 'user1@ndr.org', password: 'user12345' });
    check('user login', userLogin.status === 200);
    const userToken = userLogin.data.token;

    // 6. Unauthorized access
    const noAuth = await api('/api/reports');
    check('no-token rejected', noAuth.status === 401);

    // 7. User creates report
    const report = await api('/api/reports', 'POST', {
      errName: 'غرفة طوارئ الفاشر', localityId: 1, donorId: 1, supportTypeId: 1,
      supportDescription: 'توزيع سلال غذائية', partnerId: 1, monthId: 8,
      amountReceived: 1500000, beneficiariesTotal: 5000,
      beneficiariesMale: 2300, beneficiariesFemale: 2700,
      challenges: 'صعوبة الوصول', positiveOutcomes: 'استفادة واسعة'
    }, userToken);
    check('create report', report.status === 201, JSON.stringify(report.data));
    const reportId = report.data?.id;

    // 8. User sees own report
    const myReports = await api('/api/reports', 'GET', null, userToken);
    check('user sees own report', myReports.data?.length === 1);

    // 9. Admin sees report
    const adminReports = await api('/api/reports', 'GET', null, adminToken);
    check('admin sees all reports', adminReports.data?.length === 1);

    // 10. Analytics stats
    const stats = await api('/api/analytics/stats', 'GET', null, adminToken);
    check('analytics stats', stats.status === 200 && stats.data.localityStats.length === 16);
    check('analytics totals', stats.data.localityStats[0].count === 1 && stats.data.localityStats[0].totalAmount === 1500000);

    // 11. Public summary
    const summary = await api('/api/analytics/summary');
    check('public summary', summary.data?.totalReports === 1 && summary.data?.totalAmount === 1500000);

    // 12. Update report (owner)
    const upd = await api(`/api/reports/${reportId}`, 'PUT', { supportDescription: 'تعديل التفاصيل' }, userToken);
    check('owner edit report', upd.status === 200);

    // 13. Admin reviews report
    const review = await api(`/api/reports/${reportId}/review`, 'POST', { status: 'approved', note: 'تم التحقق' }, adminToken);
    check('review approve', review.status === 200);

    // 14. Notification created for user
    const notifs = await api('/api/notifications', 'GET', null, userToken);
    check('user got notification', notifs.data?.some(n => n.type === 'success'));

    // 15. Activity log
    const activity = await api('/api/activity', 'GET', null, adminToken);
    check('activity log entries', activity.data?.length >= 3);

    // 16. Create share link
    const share = await api('/api/share', 'POST', { name: 'تقرير شهري', expiryHours: 24, shareReports: true, shareAnalytics: true, shareUsers: false }, adminToken);
    check('create share link', share.status === 201, JSON.stringify(share.data));
    const token = share.data?.token;

    // 17. Public share access
    const sharePublic = await api(`/api/share/public/${token}`);
    check('public share access', sharePublic.status === 200 && Array.isArray(sharePublic.data.reports));

    // 18. User cannot access users list (admin only)
    const usersAsUser = await api('/api/users', 'GET', null, userToken);
    check('user blocked from admin users', usersAsUser.status === 403);

    // 19. User cannot delete settings
    const donorAsUser = await api('/api/settings/donors', 'POST', { name: 'X' }, userToken);
    check('user blocked from settings', donorAsUser.status === 403);

    // 20. Add locality via admin
    const addLoc = await api('/api/settings/localities', 'POST', { nameAr: 'محلية تجريبية', nameEn: 'Test', color: '#123456' }, adminToken);
    check('admin add locality', addLoc.status === 201);

    // 21. Export check - reports count as admin
    check('final report count', adminReports.data?.length >= 1);

  } catch (e) {
    fail++;
    results.push(`✘ EXCEPTION: ${e.message}`);
  }

  console.log(results.join('\n'));
  console.log(`\n===== النتيجة: ${pass} ناجح / ${fail} فشل =====`);

  const countUsers = await db.get('SELECT COUNT(*) AS c FROM users WHERE email != ?', ['admin@ndr.org']);
  if (countUsers.c > 0) {
    await db.run('DELETE FROM users WHERE email != ?', ['admin@ndr.org']);
  }
  await db.run('DELETE FROM reports');
  await db.run('DELETE FROM notifications');
  await db.run('DELETE FROM activity_log');
  await db.run('DELETE FROM share_links');
  await db.run('DELETE FROM localities WHERE name_ar = ?', ['محلية تجريبية']);

  process.exit(fail > 0 ? 1 : 0);
});
