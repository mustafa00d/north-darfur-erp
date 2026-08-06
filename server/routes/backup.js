import express from 'express';
import db, { logActivity } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

// Export full backup (JSON)
router.get('/', asyncHandler(async (req, res) => {
  const [users, localities, donors, partners, supportTypes, reports, activityLog, notifications, shareLinks] = await Promise.all([
    db.all('SELECT * FROM users'),
    db.all('SELECT * FROM localities'),
    db.all('SELECT * FROM donors'),
    db.all('SELECT * FROM partners'),
    db.all('SELECT * FROM support_types'),
    db.all('SELECT * FROM reports'),
    db.all('SELECT * FROM activity_log'),
    db.all('SELECT * FROM notifications'),
    db.all('SELECT * FROM share_links')
  ]);

  const backup = {
    app: 'north-darfur-erp',
    version: 3,
    exportedAt: new Date().toISOString(),
    tables: { users, localities, donors, partners, supportTypes, reports, activityLog, notifications, shareLinks }
  };

  await logActivity(req.user, 'تصدير نسخة احتياطية', 'backup', null, `users=${users.length} reports=${reports.length}`);
  res.json(backup);
}));

// Restore from backup (replaces all data)
router.post('/restore', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const t = b.tables;
  if (!t || !Array.isArray(t.users) || !Array.isArray(t.reports) || !Array.isArray(t.localities)
      || !Array.isArray(t.donors) || !Array.isArray(t.partners) || !Array.isArray(t.supportTypes)
      || !Array.isArray(t.activityLog) || !Array.isArray(t.notifications) || !Array.isArray(t.shareLinks)) {
    return res.status(400).json({ error: 'ملف النسخة الاحتياطية غير صالح' });
  }

  await db.exec('BEGIN');
  try {
    await db.exec('DELETE FROM reports');
    await db.exec('DELETE FROM activity_log');
    await db.exec('DELETE FROM notifications');
    await db.exec('DELETE FROM share_links');
    await db.exec('DELETE FROM users');
    await db.exec('DELETE FROM localities');
    await db.exec('DELETE FROM donors');
    await db.exec('DELETE FROM partners');
    await db.exec('DELETE FROM support_types');

    for (const r of t.supportTypes) {
      await db.run('INSERT INTO support_types (id, name_ar, name_en, icon, color) VALUES (?, ?, ?, ?, ?)',
        [r.id, r.name_ar, r.name_en, r.icon || '', r.color || '#3B82F6']);
    }
    for (const r of t.partners) {
      await db.run('INSERT INTO partners (id, name) VALUES (?, ?)', [r.id, r.name]);
    }
    for (const r of t.donors) {
      await db.run('INSERT INTO donors (id, name, color) VALUES (?, ?, ?)', [r.id, r.name, r.color || '#3B82F6']);
    }
    for (const r of t.localities) {
      await db.run('INSERT INTO localities (id, name_ar, name_en, color) VALUES (?, ?, ?, ?)',
        [r.id, r.name_ar, r.name_en, r.color || '#6B2D5B']);
    }
    for (const r of t.users) {
      await db.run(`INSERT INTO users (id, email, password_hash, name, role, locality_id, active,
        failed_attempts, locked_until, must_change_password, created_at, last_login)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.email, r.password_hash, r.name, r.role || 'user', r.locality_id || null,
         r.active == null ? 1 : r.active, r.failed_attempts || 0, r.locked_until || null,
         r.must_change_password || 0, r.created_at, r.last_login || null]);
    }
    for (const r of t.reports) {
      await db.run(`INSERT INTO reports (id, created_at, updated_at, user_id, err_name, locality_id,
        donor_id, support_type_id, support_description, partner_id, month_id, year, ref_code,
        amount_received, beneficiaries_total, beneficiaries_male, beneficiaries_female,
        challenges, positive_outcomes, status, reviewed_by, reviewed_at, review_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.created_at, r.updated_at, r.user_id, r.err_name, r.locality_id,
         r.donor_id, r.support_type_id, r.support_description || '', r.partner_id, r.month_id,
         r.year || new Date().getFullYear(), r.ref_code || null,
         r.amount_received || 0, r.beneficiaries_total || 0, r.beneficiaries_male || 0,
         r.beneficiaries_female || 0, r.challenges || '', r.positive_outcomes || '',
         r.status || 'submitted', r.reviewed_by || null, r.reviewed_at || null, r.review_note || null]);
    }
    for (const r of t.activityLog) {
      await db.run(`INSERT INTO activity_log (id, user_id, user_name, action, entity_type, entity_id, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.user_id || null, r.user_name || 'نظام', r.action, r.entity_type || null,
         r.entity_id || null, r.details || '', r.created_at]);
    }
    for (const r of t.notifications) {
      await db.run(`INSERT INTO notifications (id, user_id, title, message, type, read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.user_id, r.title || '', r.message || '', r.type || 'info', r.read || 0, r.created_at]);
    }
    for (const r of t.shareLinks) {
      await db.run(`INSERT INTO share_links (id, token, name, created_by, created_at, expires_at,
        permissions, password_hash, view_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.token, r.name, r.created_by || null, r.created_at,
         r.expires_at, r.permissions, r.password_hash || null, r.view_count || 0]);
    }

    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }

  await logActivity(req.user, 'استعادة نسخة احتياطية', 'backup', null,
    `users=${t.users.length} reports=${t.reports.length}`);
  res.json({ success: true, users: t.users.length, reports: t.reports.length });
}));

export default router;
