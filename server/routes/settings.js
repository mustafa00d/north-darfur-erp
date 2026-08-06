import express from 'express';
import db, { logActivity } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

// ==================== Localities ====================

router.get('/localities', asyncHandler(async (req, res) => {
  res.json(await db.all('SELECT id, name_ar AS nameAr, name_en AS nameEn, color FROM localities ORDER BY id'));
}));

router.post('/localities', asyncHandler(async (req, res) => {
  const { nameAr, nameEn, color } = req.body || {};
  if (!nameAr || !nameEn) {
    return res.status(400).json({ error: 'أدخل الاسم العربي والإنجليزي' });
  }
  const result = await db.run('INSERT INTO localities (name_ar, name_en, color) VALUES (?, ?, ?)',
    [nameAr, nameEn, color || '#6B2D5B']);
  await logActivity(req.user, 'إضافة محلية', 'locality', result.lastInsertRowid, nameAr);
  res.status(201).json({ id: result.lastInsertRowid, nameAr, nameEn, color: color || '#6B2D5B' });
}));

router.put('/localities/:id', asyncHandler(async (req, res) => {
  const { nameAr, nameEn, color } = req.body || {};
  await db.run('UPDATE localities SET name_ar = ?, name_en = ?, color = ? WHERE id = ?',
    [nameAr || '', nameEn || '', color || '#6B2D5B', req.params.id]);
  await logActivity(req.user, 'تعديل محلية', 'locality', Number(req.params.id));
  res.json({ success: true });
}));

router.delete('/localities/:id', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM localities WHERE id = ?', [req.params.id]);
  await logActivity(req.user, 'حذف محلية', 'locality', Number(req.params.id));
  res.json({ success: true });
}));

// ==================== Donors ====================

router.get('/donors', asyncHandler(async (req, res) => {
  res.json(await db.all('SELECT id, name, color FROM donors ORDER BY id'));
}));

router.post('/donors', asyncHandler(async (req, res) => {
  const { name, color } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'أدخل اسم المانح' });
  }
  const result = await db.run('INSERT INTO donors (name, color) VALUES (?, ?)', [name, color || '#3B82F6']);
  await logActivity(req.user, 'إضافة مانح', 'donor', result.lastInsertRowid, name);
  res.status(201).json({ id: result.lastInsertRowid, name, color: color || '#3B82F6' });
}));

router.put('/donors/:id', asyncHandler(async (req, res) => {
  const { name, color } = req.body || {};
  await db.run('UPDATE donors SET name = ?, color = ? WHERE id = ?', [name || '', color || '#3B82F6', req.params.id]);
  await logActivity(req.user, 'تعديل مانح', 'donor', Number(req.params.id));
  res.json({ success: true });
}));

router.delete('/donors/:id', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM donors WHERE id = ?', [req.params.id]);
  await logActivity(req.user, 'حذف مانح', 'donor', Number(req.params.id));
  res.json({ success: true });
}));

// ==================== Partners ====================

router.get('/partners', asyncHandler(async (req, res) => {
  res.json(await db.all('SELECT id, name FROM partners ORDER BY id'));
}));

router.post('/partners', asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'أدخل اسم الشريك' });
  }
  const result = await db.run('INSERT INTO partners (name) VALUES (?)', [name]);
  await logActivity(req.user, 'إضافة شريك', 'partner', result.lastInsertRowid, name);
  res.status(201).json({ id: result.lastInsertRowid, name });
}));

router.delete('/partners/:id', asyncHandler(async (req, res) => {
  await db.run('DELETE FROM partners WHERE id = ?', [req.params.id]);
  await logActivity(req.user, 'حذف شريك', 'partner', Number(req.params.id));
  res.json({ success: true });
}));

export default router;
