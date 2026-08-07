import express from 'express';
import db, { logActivity, createNotification } from '../db.js';
import { requireAuth } from '../auth.js';
import { sendNewReportEmail, sendReportStatusEmail } from '../mailer.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();
router.use(requireAuth);

const REPORT_SELECT = `
  SELECT r.*, u.name AS user_name, u.email AS user_email,
    l.name_ar AS locality_ar, l.name_en AS locality_en, l.color AS locality_color,
    d.name AS donor_name, d.color AS donor_color,
    s.name_ar AS support_ar, s.name_en AS support_en, s.icon AS support_icon,
    p.name AS partner_name,
    ru.name AS reviewer_name
  FROM reports r
  LEFT JOIN users u ON u.id = r.user_id
  LEFT JOIN localities l ON l.id = r.locality_id
  LEFT JOIN donors d ON d.id = r.donor_id
  LEFT JOIN support_types s ON s.id = r.support_type_id
  LEFT JOIN partners p ON p.id = r.partner_id
  LEFT JOIN users ru ON ru.id = r.reviewed_by
`;

function serialize(row) {
  return {
    id: row.id,
    refCode: row.ref_code,
    year: row.year,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    errName: row.err_name,
    localityId: row.locality_id,
    localityAr: row.locality_ar,
    localityEn: row.locality_en,
    localityColor: row.locality_color,
    donorId: row.donor_id,
    donorName: row.donor_name,
    donorColor: row.donor_color,
    supportTypeId: row.support_type_id,
    supportAr: row.support_ar,
    supportEn: row.support_en,
    supportIcon: row.support_icon,
    supportDescription: row.support_description,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    monthId: row.month_id,
    amountReceived: row.amount_received,
    beneficiariesTotal: row.beneficiaries_total,
    beneficiariesMale: row.beneficiaries_male,
    beneficiariesFemale: row.beneficiaries_female,
    challenges: row.challenges,
    positiveOutcomes: row.positive_outcomes,
    status: row.status,
    reviewStartedAt: row.review_started_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewerName: row.reviewer_name,
    reviewNote: row.review_note
  };
}

function scopeWhere(req) {
  if (req.user.role === 'admin') return { where: [], params: {} };
  if (req.user.role === 'locality_admin') {
    return { where: ['r.locality_id = @loc'], params: { loc: req.user.locality_id } };
  }
  return { where: ['r.user_id = @uid'], params: { uid: req.user.id } };
}

async function generateRefCode(layer, year) {
  const row = await layer.get(
    "SELECT ref_code FROM reports WHERE ref_code LIKE ? ORDER BY ref_code DESC LIMIT 1",
    [`ND-${year}-%`]
  );
  let next = 1;
  if (row && row.ref_code) {
    const m = row.ref_code.match(/(\d+)$/);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `ND-${year}-${String(next).padStart(4, '0')}`;
}

// GET reports (admin: all; locality_admin: own locality; user: own) with filters
router.get('/', asyncHandler(async (req, res) => {
  const { localityId, donorId, sectorId, monthId, status, search, year, from, to } = req.query;
  const sc = scopeWhere(req);
  const where = sc.where.slice();
  const params = { ...sc.params };

  if (localityId) { where.push('r.locality_id = @loc'); params.loc = localityId; }
  if (donorId) { where.push('r.donor_id = @don'); params.don = donorId; }
  if (sectorId) { where.push('r.support_type_id = @sect'); params.sect = sectorId; }
  if (monthId) { where.push('r.month_id = @mon'); params.mon = monthId; }
  if (year) { where.push('r.year = @yr'); params.yr = year; }
  if (from) { where.push('r.created_at >= @from'); params.from = new Date(from).toISOString(); }
  if (to) {
    const toEnd = new Date(to);
    toEnd.setDate(toEnd.getDate() + 1);
    where.push('r.created_at < @to');
    params.to = toEnd.toISOString();
  }
  if (status) { where.push('r.status = @st'); params.st = status; }
  if (search) {
    where.push('(r.err_name LIKE @q OR l.name_ar LIKE @q OR d.name LIKE @q)');
    params.q = `%${search}%`;
  }

  const sql = `${REPORT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC, r.id DESC`;
  const rows = await db.all(sql, params);
  res.json(rows.map(serialize));
}));

// GET single report (admin: all; locality_admin: own locality; user: own)
router.get('/:id', asyncHandler(async (req, res) => {
  const row = await db.get(`${REPORT_SELECT} WHERE r.id = ?`, [req.params.id]);
  if (!row) {
    return res.status(404).json({ error: 'التقرير غير موجود' });
  }
  const allowed = req.user.role === 'admin'
    || (req.user.role === 'locality_admin' && req.user.locality_id === row.locality_id)
    || row.user_id === req.user.id;
  if (!allowed) {
    return res.status(403).json({ error: 'غير مصرح' });
  }
  res.json(serialize(row));
}));

// POST start review: يعلّم بداية المراجعة (يقفل التعديل على المالك) — للمراجع فقط
router.post('/:id/start-review', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
  if (!row) {
    return res.status(404).json({ error: 'التقرير غير موجود' });
  }
  const canReview = req.user.role === 'admin'
    || (req.user.role === 'locality_admin' && req.user.locality_id === row.locality_id);
  if (!canReview) {
    return res.status(403).json({ error: 'غير مصرح' });
  }
  if (row.status === 'submitted' && !row.review_started_at) {
    await db.run('UPDATE reports SET review_started_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
  }
  res.json({ success: true });
}));

// POST new report
router.post('/', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const required = ['errName', 'localityId', 'donorId', 'supportTypeId', 'partnerId', 'monthId',
    'amountReceived', 'beneficiariesTotal', 'beneficiariesMale', 'beneficiariesFemale',
    'challenges', 'positiveOutcomes'];
  for (const field of required) {
    if (b[field] === undefined || b[field] === null || b[field] === '') {
      return res.status(400).json({ error: `حقل مطلوب ناقص: ${field}` });
    }
  }

  // التحقق من صحة الأرقام
  const nums = {
    amountReceived: parseFloat(b.amountReceived),
    beneficiariesTotal: parseInt(b.beneficiariesTotal),
    beneficiariesMale: parseInt(b.beneficiariesMale),
    beneficiariesFemale: parseInt(b.beneficiariesFemale)
  };
  for (const [k, v] of Object.entries(nums)) {
    if (!isFinite(v) || v < 0) {
      return res.status(400).json({ error: `قيمة غير صالحة للحقل: ${k}` });
    }
  }
  const monthNum = parseInt(b.monthId);
  if (!monthNum || monthNum < 1 || monthNum > 12) {
    return res.status(400).json({ error: 'الشهر غير صالح (1-12)' });
  }
  if (nums.amountReceived > 1000000000) {
    return res.status(400).json({ error: 'المبلغ أكبر من الحد المسموح (مليار)' });
  }

  // غير المدير يجب أن يرسل لمحليته فقط
  if (req.user.role !== 'admin' && Number(b.localityId) !== Number(req.user.locality_id)) {
    return res.status(403).json({ error: 'يمكنك إرسال التقارير لمحليتك فقط' });
  }

  // التحقق من التكرار (نفس الغرفة + الشهر + المانح + السنة)
  if (!b.force) {
    const dup = await db.get(
      `SELECT id FROM reports WHERE LOWER(TRIM(err_name)) = LOWER(TRIM(@n))
       AND month_id = @m AND donor_id = @d AND year = @yr`,
      { n: String(b.errName), m: b.monthId, d: b.donorId, yr: parseInt(b.year) || new Date().getFullYear() }
    );
    if (dup) {
      return res.status(409).json({
        error: 'يوجد تقرير مطابق مسبقاً (نفس الغرفة والشهر والمانح والسنة). أرسل القوة لمواصلة الإرسال.',
        duplicate: true, duplicateId: dup.id
      });
    }
  }

  const year = parseInt(b.year) || new Date().getFullYear();
  const refCode = await generateRefCode(db, year);

  const result = await db.run(`
    INSERT INTO reports (
      user_id, err_name, locality_id, donor_id, support_type_id, support_description,
      partner_id, month_id, year, ref_code, amount_received, beneficiaries_total,
      beneficiaries_male, beneficiaries_female, challenges, positive_outcomes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
  `, [
    req.user.id, b.errName, Number(b.localityId), b.donorId, b.supportTypeId,
    b.supportDescription || '', b.partnerId, monthNum, year, refCode,
    nums.amountReceived, nums.beneficiariesTotal,
    nums.beneficiariesMale, nums.beneficiariesFemale,
    b.challenges, b.positiveOutcomes
  ]);

  await logActivity(req.user, 'إضافة تقرير', 'report', result.lastInsertRowid, `${b.errName} (${refCode})`);
  await notifyAdmins('تقرير جديد', `أضاف ${req.user.name} تقريراً جديداً: ${b.errName} (${refCode})`);

  // إشعار فوري لمشرف المحلية صاحب التقرير
  try {
    const locName = (await db.get('SELECT name_ar AS n FROM localities WHERE id = ?', [Number(b.localityId)]))?.n || '';
    const locAdmins = await db.all(
      "SELECT id FROM users WHERE role = 'locality_admin' AND locality_id = ? AND active = 1",
      [Number(b.localityId)]
    );
    for (const la of locAdmins) {
      if (la.id === req.user.id) continue;
      await createNotification(la.id, 'تقرير جديد في محليتك', `أرسل ${req.user.name} تقريراً جديداً لمحلية ${locName}: ${b.errName} (${refCode})`, 'info');
    }
  } catch (e) { /* فشل الإشعار لا يمنع الإرسال */ }

  const admins = await db.all("SELECT email FROM users WHERE role = 'admin' AND active = 1");
  if (admins.length) {
    await sendNewReportEmail(admins, req.user.name, b.errName, refCode);
  }

  const row = await db.get(`${REPORT_SELECT} WHERE r.id = ?`, [result.lastInsertRowid]);
  res.status(201).json(serialize(row));
}));

// POST resubmit rejected report (owner)
router.post('/:id/resubmit', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
  if (!row) {
    return res.status(404).json({ error: 'التقرير غير موجود' });
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'غير مصرح' });
  }
  if (row.status !== 'rejected') {
    return res.status(400).json({ error: 'يمكن إعادة إرسال التقارير المرفوضة فقط' });
  }

  await db.run(
    "UPDATE reports SET status = 'submitted', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, review_started_at = NULL, updated_at = ? WHERE id = ?",
    [new Date().toISOString(), row.id]
  );
  await logActivity(req.user, 'إعادة إرسال تقرير', 'report', row.id, row.err_name);
  await notifyAdmins('إعادة إرسال تقرير', `أعاد ${req.user.name} إرسال التقرير: ${row.err_name} (${row.ref_code || ''})`);
  res.json({ success: true, status: 'submitted' });
}));

// PUT update report (owner or admin)
router.put('/:id', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
  if (!row) {
    return res.status(404).json({ error: 'التقرير غير موجود' });
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'غير مصرح' });
  }
  if (row.status === 'approved') {
    return res.status(400).json({ error: 'لا يمكن تعديل تقرير تمت الموافقة عليه' });
  }
  if (row.status === 'submitted' && row.review_started_at && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'التقرير قيد المراجعة من المشرف — لا يمكن التعديل الآن' });
  }

  const b = req.body || {};

  // غير المدير لا يغير المحلية خارج نطاقه
  if (req.user.role !== 'admin' && b.localityId !== undefined && Number(b.localityId) !== Number(req.user.locality_id)) {
    return res.status(403).json({ error: 'يمكنك تعديل تقارير محليتك فقط' });
  }

  // التحقق من صحة الأرقام عند التعديل
  for (const [k, v] of [['amountReceived', b.amountReceived], ['beneficiariesTotal', b.beneficiariesTotal],
    ['beneficiariesMale', b.beneficiariesMale], ['beneficiariesFemale', b.beneficiariesFemale]]) {
    if (v !== undefined) {
      const n = parseFloat(v);
      if (!isFinite(n) || n < 0) {
        return res.status(400).json({ error: `قيمة غير صالحة للحقل: ${k}` });
      }
    }
  }
  if (b.monthId !== undefined) {
    const m = parseInt(b.monthId);
    if (!m || m < 1 || m > 12) {
      return res.status(400).json({ error: 'الشهر غير صالح (1-12)' });
    }
  }

  // فحص التكرار عند التعديل (نفس الغرفة + الشهر + المانح + السنة) باستثناء التقرير نفسه
  const finalErr = b.errName !== undefined ? b.errName : row.err_name;
  const finalMonth = b.monthId !== undefined ? parseInt(b.monthId) : row.month_id;
  const finalDonor = b.donorId !== undefined ? b.donorId : row.donor_id;
  const finalYear = b.year !== undefined ? (parseInt(b.year) || row.year) : row.year;
  const dup = await db.get(
    `SELECT id FROM reports WHERE LOWER(TRIM(err_name)) = LOWER(TRIM(@n))
     AND month_id = @m AND donor_id = @d AND year = @yr AND id != @id`,
    { n: String(finalErr), m: finalMonth, d: finalDonor, yr: finalYear, id: row.id }
  );
  if (dup) {
    return res.status(409).json({
      error: 'يوجد تقرير مطابق مسبقاً (نفس الغرفة والشهر والمانح والسنة).',
      duplicate: true, duplicateId: dup.id
    });
  }

  // تغيير السنة يولد رقماً مرجعياً جديداً
  if (finalYear !== row.year) {
    await db.run('UPDATE reports SET ref_code = ?, year = ? WHERE id = ?',
      [await generateRefCode(db, finalYear), finalYear, row.id]);
  }

  const fields = {
    err_name: b.errName, locality_id: b.localityId, donor_id: b.donorId,
    support_type_id: b.supportTypeId, support_description: b.supportDescription,
    partner_id: b.partnerId, month_id: b.monthId, amount_received: b.amountReceived,
    beneficiaries_total: b.beneficiariesTotal, beneficiaries_male: b.beneficiariesMale,
    beneficiaries_female: b.beneficiariesFemale, challenges: b.challenges,
    positive_outcomes: b.positiveOutcomes
  };

  const sets = ['updated_at = ?'];
  const values = [new Date().toISOString()];
  for (const [col, val] of Object.entries(fields)) {
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      values.push(val);
    }
  }
  values.push(row.id);
  await db.run(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`, values);

  await logActivity(req.user, 'تعديل تقرير', 'report', row.id, row.err_name);
  res.json({ success: true });
}));

// DELETE report
router.delete('/:id', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
  if (!row) {
    return res.status(404).json({ error: 'التقرير غير موجود' });
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'غير مصرح' });
  }

  await db.run('DELETE FROM reports WHERE id = ?', [row.id]);
  await logActivity(req.user, 'حذف تقرير', 'report', row.id, row.err_name);
  res.json({ success: true });
}));

// POST review (admin or locality_admin of that locality)
router.post('/:id/review', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
  if (!row) {
    return res.status(404).json({ error: 'التقرير غير موجود' });
  }

  const canReview = req.user.role === 'admin'
    || (req.user.role === 'locality_admin' && req.user.locality_id === row.locality_id);
  if (!canReview) {
    return res.status(403).json({ error: 'غير مصرح' });
  }

  const { status, note } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'حالة المراجعة غير صالحة' });
  }

  await db.run(
    'UPDATE reports SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?',
    [status, req.user.id, new Date().toISOString(), note || '', row.id]
  );

  await logActivity(req.user, status === 'approved' ? 'الموافقة على تقرير' : 'رفض تقرير', 'report', row.id, note || '');

  const resultTitle = status === 'approved' ? 'تمت الموافقة على تقريرك ✅' : 'تم رفض تقريرك ❌';
  const resultMessage = status === 'approved'
    ? `تقريرك "${row.err_name}" تمت الموافقة عليه.`
    : `تقريرك "${row.err_name}" تم رفضه.${note ? ' السبب: ' + note : ''}`;
  await createNotification(row.user_id, resultTitle, resultMessage, status === 'approved' ? 'success' : 'error');

  const owner = await db.get('SELECT email, name FROM users WHERE id = ?', [row.user_id]);
  if (owner && owner.email) {
    await sendReportStatusEmail(owner.email, owner.name, row.err_name, status, note || '', row.ref_code);
  }

  res.json({ success: true, status });
}));

async function notifyAdmins(title, message) {
  const admins = await db.all("SELECT id FROM users WHERE role = 'admin'");
  for (const a of admins) {
    await createNotification(a.id, title, message, 'info');
  }
}

export default router;
