import jwt from 'jsonwebtoken';
import db from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'north-darfur-emergency-secret-change-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

export function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    localityId: row.locality_id,
    active: !!row.active,
    failedAttempts: row.failed_attempts || 0,
    lockedUntil: row.locked_until || null,
    mustChangePassword: !!row.must_change_password,
    createdAt: row.created_at,
    lastLogin: row.last_login
  };
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'غير مصرح | Unauthorized' });
    }
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.get('SELECT * FROM users WHERE id = ? AND active = 1', [payload.id]);
    if (!user) {
      return res.status(401).json({ error: 'المستخدم غير موجود أو غير نشط' });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'جلسة منتهية | Session expired' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'صلاحيات غير كافية | Forbidden' });
  }
  next();
}
