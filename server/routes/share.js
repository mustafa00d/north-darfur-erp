import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db, { logActivity } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function serializeLink(row) {
  return {
    id: row.id,
    token: row.token,
    name: row.name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    permissions: JSON.parse(row.permissions),
    hasPassword: !!row.password_hash,
    viewCount: row.view_count
  };
}

async function buildShareData(row) {
  const permissions = JSON.parse(row.permissions);
  const data = { link: serializeLink(row), permissions };

  if (permissions.reports) {
    data.reports = await db.all(`
      SELECT r.id, r.created_at, r.err_name, r.amount_received, r.beneficiaries_total,
        l.name_ar AS locality_ar, d.name AS donor_name, s.name_ar AS support_ar
      FROM reports r
      JOIN localities l ON l.id = r.locality_id
      JOIN donors d ON d.id = r.donor_id
      JOIN support_types s ON s.id = r.support_type_id
      WHERE r.status = 'approved'
      ORDER BY r.created_at DESC
    `);
  }

  if (permissions.analytics) {
    const c = await db.get("SELECT COUNT(*) AS c FROM reports WHERE status = 'approved'");
    const a = await db.get("SELECT COALESCE(SUM(amount_received), 0) AS s FROM reports WHERE status = 'approved'");
    const b = await db.get("SELECT COALESCE(SUM(beneficiaries_total), 0) AS s FROM reports WHERE status = 'approved'");
    const g = await db.get(`SELECT COALESCE(SUM(beneficiaries_male), 0) AS m, COALESCE(SUM(beneficiaries_female), 0) AS f
      FROM reports WHERE status = 'approved'`);
    data.summary = c.c;
    data.totalAmount = a.s;
    data.totalBeneficiaries = b.s;
    data.totalMale = g.m;
    data.totalFemale = g.f;
  }

  if (permissions.users) {
    data.users = await db.all('SELECT id, name, email FROM users WHERE active = 1');
  }

  return data;
}

async function deliverPublic(req, res, row) {
  if (!row) {
    return res.status(404).json({ error: 'الرابط غير متاح | Link unavailable' });
  }
  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'الرابط غير متاح | Link unavailable' });
  }
  if (row.password_hash) {
    return res.json({ requiresPassword: true, link: serializeLink(row) });
  }
  await db.run('UPDATE share_links SET view_count = view_count + 1 WHERE id = ?', [row.id]);
  return res.json(await buildShareData(row));
}

// Create share link (admin)
router.post('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { name, expiryHours, shareReports, shareAnalytics, shareUsers, password } = req.body || {};

  const hours = Math.min(Math.max(parseInt(expiryHours) || 24, 1), 720);
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);

  const permissions = {
    reports: !!shareReports,
    analytics: !!shareAnalytics,
    users: !!shareUsers
  };
  if (!permissions.reports && !permissions.analytics && !permissions.users) {
    return res.status(400).json({ error: 'اختر محتوى للمشاركة' });
  }

  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;

  const result = await db.run(
    'INSERT INTO share_links (token, name, created_by, expires_at, permissions, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
    [generateToken(), name || 'رابط مشاركة', req.user.id, expiresAt.toISOString(), JSON.stringify(permissions), passwordHash]
  );

  const row = await db.get('SELECT * FROM share_links WHERE id = ?', [result.lastInsertRowid]);
  await logActivity(req.user, 'إنشاء رابط مشاركة', 'share', row.id, name);

  const link = serializeLink(row);
  res.status(201).json({
    ...link,
    url: `${req.protocol}://${req.get('host')}/admin.html?share=${link.token}`
  });
}));

// List active links (admin)
router.get('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.all(
    'SELECT * FROM share_links WHERE expires_at > ? ORDER BY created_at DESC',
    [new Date().toISOString()]
  );
  res.json(rows.map(serializeLink));
}));

// Delete share link (admin)
router.delete('/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM share_links WHERE id = ?', [req.params.id]);
  await logActivity(req.user, 'حذف رابط مشاركة', 'share', Number(req.params.id));
  res.json({ success: true });
}));

// Public access via token (no auth)
router.get('/public/:token', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM share_links WHERE token = ?', [req.params.token]);
  await deliverPublic(req, res, row);
}));

// Public unlock with password (no auth)
router.post('/public/:token/auth', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM share_links WHERE token = ?', [req.params.token]);
  if (!row) {
    return res.status(404).json({ error: 'الرابط غير متاح | Link unavailable' });
  }
  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'الرابط غير متاح | Link unavailable' });
  }

  if (!row.password_hash) {
    await db.run('UPDATE share_links SET view_count = view_count + 1 WHERE id = ?', [row.id]);
    return res.json(await buildShareData(row));
  }

  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة | Incorrect password' });
  }

  await db.run('UPDATE share_links SET view_count = view_count + 1 WHERE id = ?', [row.id]);
  res.json(await buildShareData(row));
}));

export default router;
