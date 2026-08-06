import express from 'express';
import db, { MONTHS } from '../db.js';
import { requireAuth } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const [localities, donors, partners, supportTypes] = await Promise.all([
    db.all('SELECT id, name_ar AS nameAr, name_en AS nameEn, color FROM localities ORDER BY id'),
    db.all('SELECT id, name, color FROM donors ORDER BY id'),
    db.all('SELECT id, name FROM partners ORDER BY id'),
    db.all('SELECT id, name_ar AS nameAr, name_en AS nameEn, icon, color FROM support_types ORDER BY id')
  ]);
  res.json({ localities, donors, partners, supportTypes, months: MONTHS });
}));

export default router;
