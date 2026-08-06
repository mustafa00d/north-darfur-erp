import express from 'express';
import db, { MONTHS } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
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

// Detailed stats (authenticated; admin: all, locality_admin: own locality, user: own)
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
  const [localities, donors, sectors] = await Promise.all([
    db.all('SELECT id, name_ar AS "nameAr", name_en AS "nameEn", color FROM localities ORDER BY id'),
    db.all('SELECT id, name, color FROM donors ORDER BY id'),
    db.all('SELECT id, name_ar AS "nameAr", name_en AS "nameEn", icon, color FROM support_types ORDER BY id')
  ]);

  const { year } = req.query;

  // Build stats maps seeded with zeros
  const localityStats = localities.map(l => ({ ...l, count: 0, totalAmount: 0, totalBeneficiaries: 0 }));
  const donorStats = donors.map(d => ({ ...d, count: 0, totalAmount: 0 }));
  const sectorStats = sectors.map(s => ({ ...s, count: 0, totalAmount: 0 }));
  const monthStats = MONTHS.map(m => ({ ...m, count: 0, totalAmount: 0, totalBeneficiaries: 0 }));
  const genderStats = { male: 0, female: 0 };
  const yearStats = [];

  let sql = `
    SELECT locality_id, donor_id, support_type_id, month_id, year, amount_received,
      beneficiaries_total, beneficiaries_male, beneficiaries_female
    FROM reports
  `;
  const conditions = [];
  const params = {};
  if (req.user.role === 'locality_admin') {
    conditions.push('locality_id = @loc');
    params.loc = req.user.locality_id;
  } else if (req.user.role !== 'admin') {
    conditions.push('user_id = @uid');
    params.uid = req.user.id;
  }
  if (year) {
    conditions.push('year = @yr');
    params.yr = year;
  }
  if (conditions.length) sql += 'WHERE ' + conditions.join(' AND ');
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
    genderStats.male += r.beneficiaries_male || 0;
    genderStats.female += r.beneficiaries_female || 0;

    let y = yearStats.find(x => x.year === r.year);
    if (!y) {
      y = { year: r.year, count: 0, totalAmount: 0, totalBeneficiaries: 0 };
      yearStats.push(y);
    }
    y.count++;
    y.totalAmount += r.amount_received || 0;
    y.totalBeneficiaries += r.beneficiaries_total || 0;
  }
  yearStats.sort((a, b) => (a.year || 0) - (b.year || 0));

  let statusSql = `
    SELECT status, COUNT(*) AS count FROM reports
  `;
  const statusParams = {};
  if (req.user.role === 'locality_admin') {
    statusSql += 'WHERE locality_id = @loc';
    statusParams.loc = req.user.locality_id;
  } else if (req.user.role !== 'admin') {
    statusSql += 'WHERE user_id = @uid';
    statusParams.uid = req.user.id;
  }
  statusSql += ' GROUP BY status';
  const statusStats = await db.all(statusSql, statusParams);

  res.json({ localityStats, donorStats, sectorStats, monthStats, statusStats, genderStats, yearStats });
}));

// Operational performance stats (admin only)
router.get('/ops', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const all = await db.all(
    "SELECT r.status, r.reviewed_by, u.name AS reviewer_name, r.reviewed_at, r.created_at FROM reports r LEFT JOIN users u ON u.id = r.reviewed_by"
  );

  const reviewed = all.filter(r => r.reviewed_at);
  const avgReviewHours = reviewed.length
    ? Math.round(reviewed.reduce((s, r) => s + (new Date(r.reviewed_at) - new Date(r.created_at)), 0) / reviewed.length / 3600000)
    : null;

  const decided = all.filter(r => r.status === 'approved' || r.status === 'rejected');
  const approvalRate = decided.length ? Math.round(decided.filter(r => r.status === 'approved').length / decided.length * 100) : null;

  const pending = all.filter(r => r.status === 'submitted');
  const pendingOld = pending.filter(r => (new Date() - new Date(r.created_at)) > 7 * 86400000).length;

  const reasonCounts = {};
  for (const r of decided.filter(x => x.status === 'rejected' && x.review_note)) {
    const note = String(r.review_note).trim().slice(0, 60);
    if (note) reasonCounts[note] = (reasonCounts[note] || 0) + 1;
  }
  const rejectionReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const reviewerCounts = {};
  for (const r of reviewed) {
    const name = r.reviewer_name || '—';
    reviewerCounts[name] = (reviewerCounts[name] || 0) + 1;
  }
  const reviewers = Object.entries(reviewerCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  res.json({
    avgReviewHours,
    approvalRate,
    pendingCount: pending.length,
    pendingOldCount: pendingOld,
    rejectionReasons,
    reviewers,
    reviewedCount: reviewed.length
  });
}));

export default router;
