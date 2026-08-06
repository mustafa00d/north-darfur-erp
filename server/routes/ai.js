import express from 'express';
import db, { logActivity } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import asyncHandler from '../asyncHandler.js';
import { isAiEnabled, maskKey, setSetting, getSetting, reviewAssist, chatAnswer, analysisSummary } from '../ai.js';

const router = express.Router();
router.use(requireAuth);

// حالة ميزات الذكاء
router.get('/status', asyncHandler(async (req, res) => {
  res.json({ enabled: await isAiEnabled(), provider: 'gemini', features: ['review', 'chat', 'analysis'] });
}));

// إعدادات الذكاء (admin فقط)
router.get('/settings', requireAdmin, asyncHandler(async (req, res) => {
  res.json({ provider: 'gemini', keyMasked: await maskKey(await getSetting('gemini_api_key')) });
}));

router.put('/settings', requireAdmin, asyncHandler(async (req, res) => {
  const key = String(req.body.apiKey || '').trim();
  if (!key) {
    await setSetting('gemini_api_key', '');
    await logActivity(req.user, 'تعطيل الذكاء الاصطناعي', 'ai', null, '');
    return res.json({ success: true, enabled: false });
  }
  if (!/^(AIza|AQ\.)[0-9A-Za-z_\-]{15,}$/.test(key)) {
    return res.status(400).json({ error: 'صيغة مفتاح Gemini غير صحيحة (يبدأ بـ AIza أو AQ.)' });
  }
  await setSetting('gemini_api_key', key);
  await logActivity(req.user, 'تفعيل الذكاء الاصطناعي', 'ai', null, '');
  res.json({ success: true, enabled: true, keyMasked: await maskKey(key) });
}));

// مساعدة المراجعة (admin أو مشرف المحلية ضمن نطاقه)
router.post('/review/:id', asyncHandler(async (req, res) => {
  const row = await db.get(
    `SELECT r.*, l.name_ar AS locality_ar, d.name AS donor_name, p.name AS partner_name
     FROM reports r
     LEFT JOIN localities l ON l.id = r.locality_id
     LEFT JOIN donors d ON d.id = r.donor_id
     LEFT JOIN partners p ON p.id = r.partner_id
     WHERE r.id = ?`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'التقرير غير موجود' });
  const allowed = req.user.role === 'admin'
    || (req.user.role === 'locality_admin' && req.user.locality_id === row.locality_id);
  if (!allowed) return res.status(403).json({ error: 'غير مصرح' });
  if (row.status === 'approved') return res.status(400).json({ error: 'التقرير معتمد بالفعل' });

  const result = await reviewAssist(row);
  await logActivity(req.user, 'مساعدة ذكاء للمراجعة', 'report', row.id, `${result.verdict} (${result.source})`);
  res.json(result);
}));

// مساعد المحادثة (أي مستخدم مسجل)
router.post('/chat', asyncHandler(async (req, res) => {
  const message = String(req.body.message || '').slice(0, 500);
  if (!message.trim()) return res.status(400).json({ error: 'اكتب رسالة أولاً' });
  const result = await chatAnswer(req.user, message);
  res.json(result);
}));

// التحليل التلقائي (admin فقط)
router.get('/analysis', requireAdmin, asyncHandler(async (req, res) => {
  const result = await analysisSummary({ year: req.query.year, monthId: req.query.monthId });
  res.json(result);
}));

export default router;
