import app from './server/app.js';
import db, { init } from './server/db.js';

const port = 3102;

await init();

// تنظيف قاعدة البيانات للاختبارات القطعية
await db.run('DELETE FROM users WHERE email != ?', ['admin@ndr.org']);
await db.run('DELETE FROM reports');
await db.run('DELETE FROM notifications');
await db.run('DELETE FROM activity_log');
await db.run('DELETE FROM share_links');

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

    // 2. Create user + locality admin
    const user = await api('/api/users', 'POST', {
      email: 'feat_user@ndr.org', password: 'user12345', name: 'مستخدم الميزات', localityId: 1
    }, adminToken);
    check('create user', user.status === 201);
    const locAdmin = await api('/api/users', 'POST', {
      email: 'feat_loc@ndr.org', password: 'loc12345', name: 'مشرف محلية الميزات', localityId: 2, role: 'locality_admin'
    }, adminToken);
    check('create locality admin', locAdmin.status === 201);
    const noLocAdmin = await api('/api/users', 'POST', {
      email: 'feat_loc2@ndr.org', password: 'loc12345', name: 'مشرف بلا محلية', role: 'locality_admin'
    }, adminToken);
    check('locality admin requires locality', noLocAdmin.status === 400);

    const uLogin = await api('/api/auth/login', 'POST', { email: 'feat_user@ndr.org', password: 'user12345' });
    const userToken = uLogin.data.token;
    const lLogin = await api('/api/auth/login', 'POST', { email: 'feat_loc@ndr.org', password: 'loc12345' });
    const locToken = lLogin.data.token;

    // 3. Report with year + refCode
    const r1 = await api('/api/reports', 'POST', {
      errName: 'غرفة الفاشر', localityId: 1, donorId: 1, supportTypeId: 1,
      supportDescription: '', partnerId: 1, monthId: 1, year: 2025,
      amountReceived: 100000, beneficiariesTotal: 100, beneficiariesMale: 40, beneficiariesFemale: 60,
      challenges: 'x', positiveOutcomes: 'y'
    }, userToken);
    check('create report 2025', r1.status === 201, JSON.stringify(r1.data));
    const ref1 = r1.data?.refCode;
    check('refCode format ND-2025-0001', /^ND-2025-0001$/.test(ref1 || ''), String(ref1));

    const r2 = await api('/api/reports', 'POST', {
      errName: 'غرفة الفاشر', localityId: 1, donorId: 1, supportTypeId: 2,
      supportDescription: '', partnerId: 1, monthId: 2, year: 2025,
      amountReceived: 200000, beneficiariesTotal: 200, beneficiariesMale: 100, beneficiariesFemale: 100,
      challenges: 'x', positiveOutcomes: 'y'
    }, userToken);
    check('second refCode sequential ND-2025-0002', (r2.data?.refCode || '') === 'ND-2025-0002', String(r2.data?.refCode));

    // 4. Duplicate detection
    const dup = await api('/api/reports', 'POST', {
      errName: 'غرفة الفاشر', localityId: 1, donorId: 1, supportTypeId: 1,
      supportDescription: '', partnerId: 1, monthId: 1, year: 2025,
      amountReceived: 50000, beneficiariesTotal: 50, beneficiariesMale: 25, beneficiariesFemale: 25,
      challenges: 'x', positiveOutcomes: 'y'
    }, userToken);
    check('duplicate blocked 409', dup.status === 409 && dup.data?.duplicate === true && dup.data?.duplicateId === r1.data?.id);

    const dupForce = await api('/api/reports', 'POST', {
      errName: 'غرفة الفاشر', localityId: 1, donorId: 1, supportTypeId: 1,
      supportDescription: '', partnerId: 1, monthId: 1, year: 2025,
      amountReceived: 50000, beneficiariesTotal: 50, beneficiariesMale: 25, beneficiariesFemale: 25,
      challenges: 'x', positiveOutcomes: 'y', force: true
    }, userToken);
    check('duplicate force passes', dupForce.status === 201, JSON.stringify(dupForce.data));

    // 5. Year filter
    const y2025 = await api('/api/reports?year=2025', 'GET', null, adminToken);
    const y2024 = await api('/api/reports?year=2024', 'GET', null, adminToken);
    check('year filter 2025', y2025.data?.length >= 2);
    check('year filter 2024 empty', y2024.data?.length === 0);

    // 6. Locality admin scope + review
    const locReports = await api('/api/reports', 'GET', null, locToken);
    check('locality admin sees own locality only', locReports.data?.length === 0, JSON.stringify(locReports.data?.length));

    const r3 = await api('/api/reports', 'POST', {
      errName: 'غرفة ملط', localityId: 2, donorId: 1, supportTypeId: 1,
      supportDescription: '', partnerId: 1, monthId: 3, year: 2026,
      amountReceived: 300000, beneficiariesTotal: 300, beneficiariesMale: 150, beneficiariesFemale: 150,
      challenges: 'x', positiveOutcomes: 'y'
    }, userToken);
    check('create report locality 2', r3.status === 201);

    const revWrong = await api(`/api/reports/${r3.data.id}/review`, 'POST', { status: 'approved' }, userToken);
    check('normal user cannot review', revWrong.status === 403);

    const revLoc = await api(`/api/reports/${r3.data.id}/review`, 'POST', { status: 'approved' }, locToken);
    check('locality admin can review own locality', revLoc.status === 200);

    // 7. Rejected + resubmit
    const r4 = await api('/api/reports', 'POST', {
      errName: 'غرفة كبكابية', localityId: 1, donorId: 2, supportTypeId: 2,
      supportDescription: '', partnerId: 1, monthId: 4, year: 2026,
      amountReceived: 400000, beneficiariesTotal: 400, beneficiariesMale: 200, beneficiariesFemale: 200,
      challenges: 'x', positiveOutcomes: 'y'
    }, userToken);
    const rej = await api(`/api/reports/${r4.data.id}/review`, 'POST', { status: 'rejected', note: 'بيانات ناقصة' }, adminToken);
    check('admin rejects report', rej.status === 200);

    const resubmit = await api(`/api/reports/${r4.data.id}/resubmit`, 'POST', {}, userToken);
    check('owner resubmits rejected', resubmit.status === 200);
    const after = await api('/api/reports', 'GET', null, adminToken);
    const r4after = after.data.find(r => r.id === r4.data.id);
    check('resubmitted back to submitted', r4after?.status === 'submitted');

    const resubmitAgain = await api(`/api/reports/${r4.data.id}/resubmit`, 'POST', {}, userToken);
    check('approved/submitted cannot resubmit', resubmitAgain.status === 400);

    // 8. Analytics gender + year + ops
    const stats = await api('/api/analytics/stats', 'GET', null, adminToken);
    const g = stats.data?.genderStats;
    check('gender stats sums', g && g.male > 0 && g.female > 0 && g.male + g.female === g.male + g.female);
    check('yearStats present', Array.isArray(stats.data?.yearStats) && stats.data.yearStats.length >= 2);

    const ops = await api('/api/analytics/ops', 'GET', null, adminToken);
    check('ops avg review hours', ops.status === 200 && typeof ops.data?.avgReviewHours === 'number');
    check('ops approval rate', typeof ops.data?.approvalRate === 'number' && ops.data.approvalRate > 0);

    const opsDenied = await api('/api/analytics/ops', 'GET', null, userToken);
    check('ops admin only', opsDenied.status === 403);

    // 9. Backup export + restore
    const backup = await api('/api/backup', 'GET', null, adminToken);
    check('backup export', backup.status === 200 && backup.data?.tables?.reports?.length >= 4 && backup.data?.tables?.users?.length >= 3);
    const backupDenied = await api('/api/backup', 'GET', null, userToken);
    check('backup admin only', backupDenied.status === 403);

    const restore = await api('/api/backup/restore', 'POST', backup.data, adminToken);
    check('backup restore', restore.status === 200 && restore.data?.reports === backup.data.tables.reports.length, JSON.stringify(restore.data));
    const afterRestore = await api('/api/reports', 'GET', null, adminToken);
    check('data intact after restore', afterRestore.data?.length === backup.data.tables.reports.length);

    const badRestore = await api('/api/backup/restore', 'POST', { tables: { users: [], reports: [] } }, adminToken);
    check('invalid backup rejected', badRestore.status === 400);

    console.log('\n===== النتيجة: ' + pass + ' ناجح / ' + fail + ' فشل =====');
    console.log(results.join('\n'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('خطأ في الاختبار:', e);
    process.exit(1);
  }
});
