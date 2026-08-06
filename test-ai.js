// اختبارات ميزات الذكاء الاصطناعي (تعمل بلا مفتاح حقيقي — منطق القواعد مضمون دائماً)
import app from './server/app.js';
import db, { init } from './server/db.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const port = 3103;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

await init();

// حفظ مفتاح الذكاء الأصلي إن وُجد لاستعادته بعد الاختبارات (لا نفسد إعدادات المستخدم الحقيقية)
let originalKey = null;
try {
  const file = path.join(__dirname, 'data', 'emergency.db');
  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === 'sqlite') {
    const sqlite = new DatabaseSync(file, { readOnly: true });
    const row = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?').get('gemini_api_key');
    originalKey = row ? row.value : null;
    sqlite.close();
  }
} catch (e) { /* لا بأس */ }

// تنظيف البيانات للاختبارات القطعية
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
    // 1. دخول المدير وإنشاء مستخدم عادي
    const login = await api('/api/auth/login', 'POST', { email: 'admin@ndr.org', password: 'Admin@5523' });
    check('admin login', login.status === 200 && login.data.token);
    const adminToken = login.data.token;

    const user = await api('/api/users', 'POST', {
      email: 'ai_user@ndr.org', password: 'user12345', name: 'مستخدم AI', localityId: 1
    }, adminToken);
    check('create user', user.status === 201);
    const uLogin = await api('/api/auth/login', 'POST', { email: 'ai_user@ndr.org', password: 'user12345' });
    const userToken = uLogin.data.token;

    const locAdmin = await api('/api/users', 'POST', {
      email: 'ai_loc@ndr.org', password: 'loc12345', name: 'مشرف AI', localityId: 2, role: 'locality_admin'
    }, adminToken);
    check('create locality admin', locAdmin.status === 201);
    const lLogin = await api('/api/auth/login', 'POST', { email: 'ai_loc@ndr.org', password: 'loc12345' });
    const locToken = lLogin.data.token;

    // 2. حالة الذكاء الافتراضية + صلاحيات الإعدادات
    const st0 = await api('/api/ai/status', 'GET', null, userToken);
    check('status accessible for user', st0.status === 200 && typeof st0.data.enabled === 'boolean');

    const settingsForbidden = await api('/api/ai/settings', 'GET', null, userToken);
    check('settings admin only', settingsForbidden.status === 403);

    // 3. إدخال مفتاح وهمي صالح الصيغة (يختبر التخزين والتحقق فقط — لا ندعو Gemini الحقيقي)
    const putKey = await api('/api/ai/settings', 'PUT', { apiKey: 'AQ.TestKey1234567890AbcDef' }, adminToken);
    check('save fake valid key', putKey.status === 200 && putKey.data.enabled === true && /^AQ\./.test(putKey.data.keyMasked), JSON.stringify(putKey.data));

    const st1 = await api('/api/ai/status', 'GET', null, adminToken);
    check('status enabled after key', st1.data.enabled === true);

    const badKey = await api('/api/ai/settings', 'PUT', { apiKey: 'not-a-key' }, adminToken);
    check('invalid key rejected', badKey.status === 400);

    const putEmpty = await api('/api/ai/settings', 'PUT', { apiKey: '' }, adminToken);
    check('clear key disables', putEmpty.status === 200 && putEmpty.data.enabled === false);

    // 4. تقرير + مساعدة المراجعة (منطق القواعد)
    const rep = await api('/api/reports', 'POST', {
      errName: 'غرفة AI', localityId: 1, donorId: 1, supportTypeId: 1,
      supportDescription: '', partnerId: 1, monthId: 1, year: 2026,
      amountReceived: 500000, beneficiariesTotal: 100, beneficiariesMale: 40, beneficiariesFemale: 60,
      challenges: 'نقص الوقود صعوبة الوصول للطرق غير الممهدة وارتفاع تكاليف النقل المستمر', positiveOutcomes: 'تم توزيع المساعدات على الأسر المستهدفة في الموقع المحدد'
    }, userToken);
    check('create report', rep.status === 201, JSON.stringify(rep.data));
    const repId = rep.data?.id;

    const badRep = await api('/api/reports', 'POST', {
      errName: 'غرفة AI معيبة', localityId: 1, donorId: 1, supportTypeId: 1,
      supportDescription: '', partnerId: 1, monthId: 2, year: 2026,
      amountReceived: 0, beneficiariesTotal: 50, beneficiariesMale: 40, beneficiariesFemale: 20,
      challenges: 'x', positiveOutcomes: 'y'
    }, userToken);
    check('create defective report', badRep.status === 201);
    const badRepId = badRep.data?.id;

    const rev = await api(`/api/ai/review/${repId}`, 'POST', null, adminToken);
    check('review assist ok', rev.status === 200 && ['approve', 'reject', 'needs_review'].includes(rev.data.verdict)
      && Array.isArray(rev.data.checks) && typeof rev.data.summary === 'string', JSON.stringify(rev.data));

    const revBad = await api(`/api/ai/review/${badRepId}`, 'POST', null, adminToken);
    const errorChecks = (revBad.data.checks || []).filter(c => c.level === 'error');
    check('defective report flagged', revBad.data.verdict === 'reject' && errorChecks.length >= 1,
      `verdict=${revBad.data.verdict} errors=${errorChecks.map(c => c.label).join(',')}`);

    // 5. صلاحيات مساعدة المراجعة
    const revByLoc = await api(`/api/ai/review/${repId}`, 'POST', null, locToken);
    check('locality admin cannot assist own-locality? (outside own locality = 403)',
      revByLoc.status === 403, JSON.stringify(revByLoc.data));

    const locRep = await api('/api/reports', 'POST', {
      errName: 'غرفة محلية 2', localityId: 2, donorId: 1, supportTypeId: 1,
      supportDescription: '', partnerId: 1, monthId: 3, year: 2026,
      amountReceived: 10000, beneficiariesTotal: 30, beneficiariesMale: 10, beneficiariesFemale: 20,
      challenges: 'تحديات لوجستية في المنطقة البعيدة تستوجب حلولاً عاجلة من الجهات المختصة', positiveOutcomes: 'اكتمل التوزيع وانخفضت الشكاوى'
    }, adminToken);
    const revLocOk = await api(`/api/ai/review/${locRep.data.id}`, 'POST', null, locToken);
    check('locality admin assists own locality', revLocOk.status === 200, JSON.stringify(revLocOk.data));

    const revByUser = await api(`/api/ai/review/${repId}`, 'POST', null, userToken);
    check('normal user cannot assist', revByUser.status === 403);

    // 6. مساعد المحادثة
    const chat1 = await api('/api/ai/chat', 'POST', { message: 'كيف أضيف تقريرا؟' }, userToken);
    check('chat answers how-to', chat1.status === 200 && chat1.data.reply.length > 20, JSON.stringify(chat1.data));

    const chat2 = await api('/api/ai/chat', 'POST', { message: 'كم تقريرا سجلت؟' }, userToken);
    check('chat answers stats', chat2.status === 200 && chat2.data.reply.includes('1'), JSON.stringify(chat2.data));

    const chatEmpty = await api('/api/ai/chat', 'POST', { message: '   ' }, userToken);
    check('empty chat rejected', chatEmpty.status === 400);

    const chatNoAuth = await api('/api/ai/chat', 'POST', { message: 'سؤال' });
    check('chat requires auth', chatNoAuth.status === 401);

    // 7. التحليل التلقائي
    const analysisForbidden = await api('/api/ai/analysis?year=2026', 'GET', null, userToken);
    check('analysis admin only', analysisForbidden.status === 403);

    const an = await api('/api/ai/analysis?year=2026', 'GET', null, adminToken);
    check('analysis stats', an.status === 200 && an.data.stats.total >= 3 && typeof an.data.stats.approvalRate === 'number');
    check('analysis narrative', typeof an.data.narrative === 'string' && an.data.narrative.length > 20);
    check('analysis period filter', Array.isArray(an.data.byLocality) && an.data.byLocality.length >= 1);

    // 8. تقرير سليم جوهرياً → ينصح بالموافقة
    const goodRep = await api('/api/reports', 'POST', {
      errName: 'غرفة AI سليمة', localityId: 1, donorId: 1, supportTypeId: 1,
      supportDescription: 'مواد غذائية أساسية', partnerId: 1, monthId: 4, year: 2026,
      amountReceived: 150000, beneficiariesTotal: 200, beneficiariesMale: 90, beneficiariesFemale: 110,
      challenges: 'ارتفاع أسعار المواد الغذائية في الأسواق المحلية بسبب الظروف الاقتصادية الراهنة', positiveOutcomes: 'تمت التغطية الكاملة للأسر المستهدفة وتلقت شكر الجهات المحلية'
    }, userToken);
    const revGood = await api(`/api/ai/review/${goodRep.data.id}`, 'POST', null, adminToken);
    check('healthy report recommended approve', revGood.data.verdict === 'approve' && revGood.data.confidence >= 70,
      `verdict=${revGood.data.verdict} conf=${revGood.data.confidence}`);

    // 9. استعادة المفتاح الأصلي
    if (originalKey !== null) {
      const restore = await api('/api/ai/settings', 'PUT', { apiKey: originalKey }, adminToken);
      check('original key restored', restore.status === 200, JSON.stringify(restore.data));
    } else {
      await api('/api/ai/settings', 'PUT', { apiKey: '' }, adminToken);
    }
  } catch (e) {
    fail++;
    results.push(`✘ استثناء غير متوقع: ${e.message}`);
  }

  console.log(`النتيجة: ${pass} ناجح / ${fail} فشل`);
  results.forEach(r => console.log(r));
  server.close();
  process.exit(fail ? 1 : 0);
});
