import express from 'express';
import db, { logActivity, createNotification } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
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
  JOIN users u ON u.id = r.user_id
  JOIN localities l ON l.id = r.locality_id
  JOIN donors d ON d.id = r.donor_id
  JOIN support_types s ON s.id = r.support_type_id
  JOIN partners p ON p.id = r.partner_id
  LEFT JOIN users ru ON ru.id = r.reviewed_by
`;

function serialize(row) {
  return {
    id: row.id,
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
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewerName: row.reviewer_name,
    reviewNote: row.review_note
  };
}

// GET reports (admin: all; user: own) with filters
router.get('/', asyncHandler(async (req, res) => {
  const { localityId, donorId, sectorId, monthId, status, search } = req.query;
  const where = [];
  const params = {};

  if (req.user.role !== 'admin') {
    where.push('r.user_id = @uid');
    params.uid = req.user.id;
  }
  if (localityId) { where.push('r.locality_id = @loc'); params.loc = localityId; }
  if (donorId) { where.push('r.donor_id = @don'); params.don = donorId; }
  if (sectorId) { where.push('r.support_type_id = @sect'); params.sect = sectorId; }
  if (monthId) { where.push('r.month_id = @mon'); params.mon = monthId; }
  if (status) { where.push('r.status = @st'); params.st = status; }
  if (search) {
    where.push('(r.err_name LIKE @q OR l.name_ar LIKE @q OR d.name LIKE @q)');
    params.q = `%${search}%`;
  }

  const sql = `${REPORT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC, r.id DESC`;
  const rows = await db.all(sql, params);
  res.json(rows.map(serialize));
}));

// GET single report
router.get('/:id', asyncHandler(async (req, res) => {
  const row = await db.get(`${REPORT_SELECT} WHERE r.id = ?`, [req.params.id]);
  if (!row) {
    return res.status(404).json({ error: 'التقرير غير موجود' });
  }
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'غير مصرح' });
  }
  res.json(serialize(row));
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

  const result = await db.run(`
    INSERT INTO reports (
      user_id, err_name, locality_id, donor_id, support_type_id, support_description,
      partner_id, month_id, amount_received, beneficiaries_total, beneficiaries_male,
      beneficiaries_female, challenges, positive_outcomes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
  `, [
    req.user.id, b.errName, b.localityId, b.donorId, b.supportTypeId,
    b.supportDescription || '', b.partnerId, b.monthId,
    parseFloat(b.amountReceived) || 0, parseInt(b.beneficiariesTotal) || 0,
    parseInt(b.beneficiariesMale) || 0, parseInt(b.beneficiariesFemale) || 0,
    b.challenges, b.positiveOutcomes
  ]);

  await logActivity(req.user, 'إضافة تقرير', 'report', result.lastInsertRowid, `${b.errName}`);
  await notifyAdmins('تقرير جديد', `أضاف ${req.user.name} تقريراً جديداً: ${b.errName}`);

  const row = await db.get(`${REPORT_SELECT} WHERE r.id = ?`, [result.lastInsertRowid]);
  res.status(201).json(serialize(row));
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

  const b = req.body || {};
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

// POST review (admin only) - approve/reject
router.post('/:id/review', requireAdmin, asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
  if (!row) {
    return res.status(404).json({ error: 'التقرير غير موجود' });
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

  res.json({ success: true, status });
}));

async function notifyAdmins(title, message) {
  const admins = await db.all("SELECT id FROM users WHERE role = 'admin'");
  for (const a of admins) {
    await createNotification(a.id, title, message, 'info');
  }
}

export default router;
