import app from './server/app.js';
import db, { init } from './server/db.js';

await init();

const server = app.listen(3101, async () => {
  const base = 'http://localhost:3101';
  let pass = 0, fail = 0;
  const results = [];

  async function api(path, method = 'GET', body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }

  function check(name, cond, extra = '') {
    if (cond) { pass++; results.push(`✔ ${name}`); }
    else { fail++; results.push(`✘ ${name} ${extra}`); }
  }

  try {
    const admin = await api('/api/auth/login', 'POST', { email: 'admin@ndr.org', password: 'Admin@5523' });
    const aTok = admin.data.token;

    // Meta shape check (what the form consumes)
    const meta = await api('/api/meta', 'GET', null, aTok);
    const l0 = meta.data.localities[0];
    check('locality shape', l0.id !== undefined && l0.nameAr && l0.nameEn && l0.color, JSON.stringify(l0));
    const st0 = meta.data.supportTypes[0];
    check('supportType shape', st0.nameAr && st0.nameEn && st0.icon !== undefined && st0.color);

    // Create user + report via user
    await api('/api/users', 'POST', { email: 'u2@ndr.org', password: 'pass12345', name: 'مستخدم تجريبي', localityId: 2 }, aTok);
    const u = await api('/api/auth/login', 'POST', { email: 'u2@ndr.org', password: 'pass12345' });
    const uTok = u.data.token;
    const rep = await api('/api/reports', 'POST', {
      errName: 'غرفة كتم', localityId: 2, donorId: 3, supportTypeId: 4,
      supportDescription: 'حماية وإيواء', partnerId: 2, monthId: 9,
      amountReceived: 850000, beneficiariesTotal: 3200, beneficiariesMale: 1500,
      beneficiariesFemale: 1700, challenges: 'نقص إمكانيات', positiveOutcomes: 'تحسن الوضع'
    }, uTok);

    // Report shape check (what the table consumes)
    const r = rep.data;
    check('report shape', r.id && r.errName && r.localityAr && r.donorName && r.supportAr && r.partnerName
      && r.amountReceived !== undefined && r.beneficiariesTotal !== undefined && r.status && r.userName, JSON.stringify(r));
    check('report status submitted', r.status === 'submitted');

    // Analytics stats shape
    const stats = await api('/api/analytics/stats', 'GET', null, aTok);
    const locStat = stats.data.localityStats.find(x => x.id === 2);
    check('analytics locality aggregation', locStat && locStat.count === 1 && locStat.totalAmount === 850000, JSON.stringify(locStat));
    check('month stats present', stats.data.monthStats.length === 12);
    check('status stats present', stats.data.statusStats && typeof stats.data.statusStats.submitted === 'number' && stats.data.statusStats.submitted >= 1);

    // Review + notification flow
    const rev = await api(`/api/reports/${r.id}/review`, 'POST', { status: 'rejected', note: 'مستندات ناقصة' }, aTok);
    check('reject report', rev.status === 200);
    const rep2 = await api('/api/reports', 'GET', null, aTok);
    const rejected = rep2.data.find(x => x.id === r.id);
    check('review note saved', rejected.reviewNote === 'مستندات ناقصة' && rejected.reviewerName && rejected.status === 'rejected');

    const notifs = await api('/api/notifications', 'GET', null, uTok);
    check('rejection notification', notifs.data.some(n => n.type === 'error' && (n.message.includes('رفض') || n.title.includes('رفض'))), JSON.stringify(notifs.data.map(n => n.type)));

    // User can edit rejected report (should be allowed since not approved)
    const edit = await api(`/api/reports/${r.id}`, 'PUT', { challenges: 'تم تحديث التحديات' }, uTok);
    check('edit after rejection', edit.status === 200);

    // Share link + public view
    const share = await api('/api/share', 'POST', { name: 'مشاركة عامة', expiryHours: 24, shareReports: true, shareAnalytics: true, shareUsers: false }, aTok);
    const pub = await api(`/api/share/public/${share.data.token}`);
    check('public share reports', Array.isArray(pub.data.reports));
    check('public share analytics', pub.data.totalAmount !== undefined);

    // Activity entries exist
    const act = await api('/api/activity', 'GET', null, aTok);
    check('activity has review action', act.data.some(a => a.action.includes('رفض')), JSON.stringify(act.data.map(a => a.action)));

    // Password change flow
    const cp = await api('/api/auth/change-password', 'POST', { currentPassword: 'pass12345', newPassword: 'newpass99' }, uTok);
    check('change password', cp.status === 200);
    const relogin = await api('/api/auth/login', 'POST', { email: 'u2@ndr.org', password: 'newpass99' });
    check('relogin with new password', relogin.status === 200);

  } catch (e) {
    fail++;
    results.push(`✘ EXCEPTION: ${e.message}`);
  }

  console.log(results.join('\n'));
  console.log(`\n===== E2E: ${pass} ناجح / ${fail} فشل =====`);

  // Cleanup
  await db.run('DELETE FROM users WHERE email != ?', ['admin@ndr.org']);
  await db.run('DELETE FROM reports');
  await db.run('DELETE FROM notifications');
  await db.run('DELETE FROM activity_log');
  await db.run('DELETE FROM share_links');
  process.exit(fail > 0 ? 1 : 0);
});
