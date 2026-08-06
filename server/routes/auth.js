import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db, { logActivity } from '../db.js';
import { signToken, publicUser, requireAuth } from '../auth.js';
import { sendResetEmail } from '../mailer.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = parseInt(process.env.AUTH_LOCK_MINUTES || '15', 10);

function lockStatus(user) {
  if (!user.locked_until) return null;
  const until = new Date(user.locked_until);
  if (until > new Date()) {
    return Math.ceil((until - new Date()) / 60000);
  }
  return null;
}

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'أدخل البريد الإلكتروني وكلمة المرور' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  if (!user || !user.active) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }

  const remaining = lockStatus(user);
  if (remaining !== null) {
    return res.status(429).json({ error: `تم قفل الحساب مؤقتاً بسبب محاولات فاشلة متكررة. أعد المحاولة بعد ${remaining} دقيقة.` });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    const attempts = (user.failed_attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      await db.run('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?', [until, user.id]);
      await logActivity(user, 'قفل الحساب بعد محاولات فاشلة', 'user', user.id, user.email);
      return res.status(429).json({ error: `تم قفل الحساب مؤقتاً. أعد المحاولة بعد ${LOCK_MINUTES} دقيقة.` });
    }
    await db.run('UPDATE users SET failed_attempts = ? WHERE id = ?', [attempts, user.id]);
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }

  await db.run(
    'UPDATE users SET last_login = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    [new Date().toISOString(), user.id]
  );
  await logActivity(user, 'تسجيل دخول', 'user', user.id, user.email);

  const token = signToken(user);
  res.json({ token, user: publicUser({ ...user, failed_attempts: 0, locked_until: null }) });
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
  await db.run(
    'UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    [hash, req.user.id]
  );
  await logActivity(req.user, 'تغيير كلمة المرور', 'user', req.user.id);
  res.json({ success: true });
}));

router.post('/forgot-password', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'أدخل البريد الإلكتروني' });
  }

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  if (user && user.active) {
    const token = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 3600 * 1000).toISOString();
    await db.run(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [user.id, tokenHash, expires]
    );
    await db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0 AND expires_at < ?',
      [user.id, new Date().toISOString()]);
    const link = `${req.protocol}://${req.get('host')}/?reset=${token}`;
    await sendResetEmail(user.email, user.name, link);
    await logActivity(user, 'طلب استعادة كلمة المرور', 'user', user.id, user.email);
  }

  res.json({ success: true, message: 'إذا كان البريد الإلكتروني مسجلاً، ستصلك رسالة بكيفية استعادة كلمة المرور.' });
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0', [tokenHash]);
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: 'رابط الاستعادة غير صالح أو منتهي الصلاحية' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await db.run(
    'UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    [hash, row.user_id]
  );
  await db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [row.id]);
  res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح، يمكنك الآن تسجيل الدخول.' });
}));

export default router;
