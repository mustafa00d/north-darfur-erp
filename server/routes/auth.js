import express from 'express';
import bcrypt from 'bcryptjs';
import db, { logActivity } from '../db.js';
import { signToken, publicUser, requireAuth } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'أدخل البريد الإلكتروني وكلمة المرور' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  if (!user || !user.active) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }

  await db.run('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString(), user.id]);
  await logActivity(user, 'تسجيل دخول', 'user', user.id, user.email);

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
  }

  const valid = bcrypt.compareSync(currentPassword, req.user.password_hash);
  if (!valid) {
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
  await logActivity(req.user, 'تغيير كلمة المرور', 'user', req.user.id);
  res.json({ success: true });
}));

export default router;
