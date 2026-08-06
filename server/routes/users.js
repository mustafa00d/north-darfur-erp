import express from 'express';
import bcrypt from 'bcryptjs';
import db, { logActivity, createNotification } from '../db.js';
import { requireAuth, requireAdmin, publicUser } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get('/', asyncHandler(async (req, res) => {
  const users = await db.all('SELECT * FROM users ORDER BY created_at DESC, id DESC');
  res.json(users.map(publicUser));
}));

router.post('/', asyncHandler(async (req, res) => {
  const { email, password, name, localityId, role } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'أدخل الاسم والبريد وكلمة المرور' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  }

  const finalRole = role === 'admin' ? 'admin' : role === 'locality_admin' ? 'locality_admin' : 'user';
  if (finalRole === 'locality_admin' && !localityId) {
    return res.status(400).json({ error: 'مشرف المحلية يجب أن يكون مرتبطاً بمحلية' });
  }

  const exists = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (exists) {
    return res.status(409).json({ error: 'البريد الإلكتروني مسجل مسبقاً' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = await db.run(`
    INSERT INTO users (email, password_hash, name, role, locality_id, active, must_change_password)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `, [email.toLowerCase(), hash, name, finalRole, localityId || null]);

  const user = await db.get('SELECT * FROM users WHERE id = ?', [result.lastInsertRowid]);
  await logActivity(req.user, 'إضافة مستخدم', 'user', user.id, `${name} (${email})`);
  await createNotification(user.id, 'مرحباً بك 👋', 'تم إنشاء حسابك بنجاح. ستحتاج إلى تغيير كلمة المرور عند أول تسجيل دخول.', 'success');

  res.status(201).json({ user: publicUser(user) });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) {
    return res.status(404).json({ error: 'المستخدم غير موجود' });
  }

  const { name, localityId, role, active, password } = req.body || {};
  const sets = [];
  const values = [];

  if (name !== undefined) { sets.push('name = ?'); values.push(name); }
  if (localityId !== undefined) { sets.push('locality_id = ?'); values.push(localityId); }
  if (role !== undefined && role === 'admin') { sets.push("role = 'admin'"); }
  if (role !== undefined && role === 'user') { sets.push("role = 'user'"); }
  if (role !== undefined && role === 'locality_admin') { sets.push("role = 'locality_admin'"); }
  if (active !== undefined) { sets.push('active = ?'); values.push(active ? 1 : 0); }
  if (password) {
    sets.push('password_hash = ?');
    values.push(bcrypt.hashSync(password, 10));
    sets.push('must_change_password = 1');
    sets.push('failed_attempts = 0');
    sets.push('locked_until = NULL');
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: 'لا توجد تغييرات' });
  }

  values.push(user.id);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values);

  const updated = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  await logActivity(req.user, 'تحديث مستخدم', 'user', user.id, updated.name);

  if (active !== undefined && !active) {
    await createNotification(user.id, 'إيقاف الحساب', 'تم إيقاف حسابك من قبل مسؤول النظام. تواصل مع الإدارة.', 'warning');
  }

  res.json({ user: publicUser(updated) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) {
    return res.status(404).json({ error: 'المستخدم غير موجود' });
  }
  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
  }
  const ref = await db.get('SELECT COUNT(*) AS c FROM reports WHERE user_id = ?', [user.id]);
  if (ref.c > 0) {
    return res.status(409).json({ error: `لا يمكن الحذف: لدى المستخدم ${ref.c} تقرير مرتبط. احذف تقاريره أو اترك حسابه معطلاً` });
  }

  await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  await logActivity(req.user, 'حذف مستخدم', 'user', user.id, user.name);
  res.json({ success: true });
}));

export default router;
