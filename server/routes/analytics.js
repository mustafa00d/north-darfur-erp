import express from 'express';
import db, { MONTHS } from '../db.js';
import { requireAuth } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();

// Public summary (no auth) - for landing page stats
router.get('/summary', asyncHandler(async (req, res) => {
  const [totalReports, totalLocalities, totalDonors, totalAmount, totalBeneficiaries, approvedCount] = await Promise.all([
    db.get('SELECT COUNT(*) AS c FROM reports'),
    db.get('SELECT COUNT(*) AS c FROM localities'),
    db.get('SELECT COUNT(*) AS c FROM donors'),
    db.get('SELECT COALESCE(SUM(amount_received), 0) AS s FROM reports'),
    db.get('SELECT COALESCE(SUM(beneficiaries_total), 0) AS s FROM reports'),
    db.get("SELECT COUNT(*) AS c FROM reports WHERE status = 'approved'")
  ]);

  res.json({
    totalReports: totalReports.c,
    totalLocalities: totalLocalities.c,
    totalDonors: totalDonors.c,
    totalAmount: totalAmount.s,
    totalBeneficiaries: totalBeneficiaries.s,
    approvedCount: approvedCount.c
  });
}));

// Detailed stats (authenticated)
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
  const [localities, donors, sectors] = await Promise.all([
    db.all('SELECT id, name_ar AS nameAr, name_en AS nameEn, color FROM localities ORDER BY id'),
    db.all('SELECT id, name, color FROM donors ORDER BY id'),
    db.all('SELECT id, name_ar AS nameAr, name_en AS nameEn, icon, color FROM support_types ORDER BY id')
  ]);

  // Build stats maps seeded with zeros
  const localityStats = localities.map(l => ({ ...l, count: 0, totalAmount: 0, totalBeneficiaries: 0 }));
  const donorStats = donors.map(d => ({ ...d, count: 0, totalAmount: 0 }));
  const sectorStats = sectors.map(s => ({ ...s, count: 0, totalAmount: 0 }));
  const monthStats = MONTHS.map(m => ({ ...m, count: 0, totalAmount: 0, totalBeneficiaries: 0 }));

  let sql = `
    SELECT locality_id, donor_id, support_type_id, month_id, amount_received, beneficiaries_total
    FROM reports
  `;
  const params = [];
  if (req.user.role !== 'admin') {
    sql += 'WHERE user_id = ?';
    params.push(req.user.id);
  }
  const reports = await db.all(sql, params);

  for (const r of reports) {
    const l = localityStats.find(x => x.id === r.locality_id);
    if (l) { l.count++; l.totalAmount += r.amount_received || 0; l.totalBeneficiaries += r.beneficiaries_total || 0; }
    const d = donorStats.find(x => x.id === r.donor_id);
    if (d) { d.count++; d.totalAmount += r.amount_received || 0; }
    const s = sectorStats.find(x => x.id === r.support_type_id);
    if (s) { s.count++; s.totalAmount += r.amount_received || 0; }
    const m = monthStats.find(x => x.id === r.month_id);
    if (m) { m.count++; m.totalAmount += r.amount_received || 0; m.totalBeneficiaries += r.beneficiaries_total || 0; }
  }

  let statusSql = `
    SELECT status, COUNT(*) AS count FROM reports
  `;
  const statusParams = [];
  if (req.user.role !== 'admin') {
    statusSql += 'WHERE user_id = ?';
    statusParams.push(req.user.id);
  }
  statusSql += ' GROUP BY status';
  const statusStats = await db.all(statusSql, statusParams);

  res.json({ localityStats, donorStats, sectorStats, monthStats, statusStats });
}));

export default router;
