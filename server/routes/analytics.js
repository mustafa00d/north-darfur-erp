import express from 'express';
import ExcelJS from 'exceljs';
import db, { MONTHS } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import asyncHandler from '../asyncHandler.js';

const router = express.Router();

// Build WHERE from role scope + query filters
function buildFilters(req) {
  const where = [];
  const params = {};
  if (req.user.role === 'locality_admin') {
    where.push('locality_id = @loc');
    params.loc = req.user.locality_id;
  } else if (req.user.role !== 'admin') {
    where.push('user_id = @uid');
    params.uid = req.user.id;
  }
  const q = req.query;
  if (q.year) { where.push('year = @yr'); params.yr = Number(q.year); }
  if (q.month) { where.push('month_id = @mo'); params.mo = Number(q.month); }
  if (q.localityId) { where.push('locality_id = @lid'); params.lid = Number(q.localityId); }
  if (q.donorId) { where.push('donor_id = @did'); params.did = Number(q.donorId); }
  if (q.sectorId) { where.push('support_type_id = @sid'); params.sid = Number(q.sectorId); }
  if (q.status) { where.push('status = @st'); params.st = String(q.status); }
  return { where, params };
}

function whereSql(filters) {
  return filters.where.length ? 'WHERE ' + filters.where.join(' AND ') : '';
}

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
// Filters: year, month, localityId, donorId, sectorId, status
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
  const [localities, donors, sectors] = await Promise.all([
    db.all('SELECT id, name_ar AS "nameAr", name_en AS "nameEn", color FROM localities ORDER BY id'),
    db.all('SELECT id, name, color FROM donors ORDER BY id'),
    db.all('SELECT id, name_ar AS "nameAr", name_en AS "nameEn", icon, color FROM support_types ORDER BY id')
  ]);

  const filters = buildFilters(req);
  const sql = `
    SELECT locality_id, donor_id, support_type_id, month_id, year, status, amount_received,
      beneficiaries_total, beneficiaries_male, beneficiaries_female
    FROM reports ${whereSql(filters)}
  `;
  const reports = await db.all(sql, filters.params);

  // Stats maps seeded with zeros
  const localityStats = localities.map(l => ({ ...l, count: 0, totalAmount: 0, totalBeneficiaries: 0 }));
  const donorStats = donors.map(d => ({ ...d, count: 0, totalAmount: 0 }));
  const sectorStats = sectors.map(s => ({ ...s, count: 0, totalAmount: 0 }));
  const monthStats = MONTHS.map(m => ({ ...m, count: 0, totalAmount: 0, totalBeneficiaries: 0 }));
  const genderStats = { male: 0, female: 0 };
  const yearStats = [];
  const statusStats = { submitted: 0, approved: 0, rejected: 0 };
  const activeLocalities = new Set();

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
    if (r.status === 'submitted' || r.status === 'approved' || r.status === 'rejected') statusStats[r.status]++;
    if (r.locality_id) activeLocalities.add(r.locality_id);

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

  // Monthly series keyed by year*12+month for comparison
  const series = {};
  for (const r of reports) {
    const key = (r.year || 0) * 12 + (r.month_id || 0);
    if (!series[key]) series[key] = { count: 0, amount: 0, beneficiaries: 0 };
    series[key].count++;
    series[key].amount += r.amount_received || 0;
    series[key].beneficiaries += r.beneficiaries_total || 0;
  }
  const keys = Object.keys(series).map(Number).sort((a, b) => a - b);

  // Month comparison: selected month (if any) or latest month with data, vs the month before it
  const reqMonth = Number(req.query.month);
  const reqYear = Number(req.query.year);
  let currentKey = reqMonth ? reqYear * 12 + reqMonth : (keys.length ? keys[keys.length - 1] : 0);
  let prevKey = currentKey - 1;
  const emptyPoint = { count: 0, amount: 0, beneficiaries: 0 };
  const cur = series[currentKey] || emptyPoint;
  const prev = series[prevKey] || emptyPoint;

  // Approval rate of decided reports
  const decided = statusStats.approved + statusStats.rejected;
  const approvalRate = decided > 0 ? Math.round(statusStats.approved / decided * 100) : null;

  res.json({
    localityStats, donorStats, sectorStats, monthStats, statusStats, genderStats, yearStats,
    activeLocalityCount: activeLocalities.size,
    totalLocalities: localities.length,
    approvalRate,
    approvedCount: statusStats.approved,
    rejectedCount: statusStats.rejected,
    pendingCount: statusStats.submitted,
    monthCompare: {
      currentKey, prevKey,
      current: cur, previous: prev,
      deltaCount: cur.count - prev.count,
      deltaAmount: cur.amount - prev.amount,
      deltaBeneficiaries: cur.beneficiaries - prev.beneficiaries
    }
  });
}));

// Achievement vs auto target (admin only)
// Rule: the target for a period = the sum of the trailing 12 months before it.
//   Monthly view: target = average of trailing 12 months; Yearly view: target = previous year total.
router.get('/targets', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const localities = await db.all('SELECT id, name_ar AS "nameAr", name_en AS "nameEn", color FROM localities ORDER BY id');
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = Number(req.query.month);

  const rows = await db.all(
    `SELECT locality_id, month_id, year, SUM(amount_received) AS amount, SUM(beneficiaries_total) AS ben
     FROM reports GROUP BY locality_id, month_id, year`
  );

  const byKey = {};
  for (const r of rows) {
    const key = (r.year || 0) * 12 + (r.month_id || 0);
    const bKey = `${r.locality_id}:${key}`;
    byKey[bKey] = byKey[bKey] || { amount: 0, ben: 0 };
    byKey[bKey].amount += r.amount || 0;
    byKey[bKey].ben += r.ben || 0;
  }

  const results = localities.map(loc => {
    const actual = { amount: 0, ben: 0 };
    let target = { amount: 0, ben: 0 };
    const pre = `${loc.id}:`;
    if (month) {
      // Monthly view: window = one month; target = trailing 12-month average
      const a = byKey[pre + (year * 12 + month)];
      if (a) { actual.amount = a.amount; actual.ben = a.ben; }
      for (let k = year * 12 + month - 12; k < year * 12 + month; k++) {
        const t = byKey[pre + k];
        if (t) { target.amount += t.amount; target.ben += t.ben; }
      }
      target.amount = Math.round(target.amount / 12);
      target.ben = Math.round(target.ben / 12);
    } else {
      // Yearly view: actual = whole year; target = previous year total
      const start = year * 12 + 1, end = year * 12 + 12;
      for (let k = start; k <= end; k++) {
        const a = byKey[pre + k];
        if (a) { actual.amount += a.amount; actual.ben += a.ben; }
      }
      const pStart = (year - 1) * 12 + 1, pEnd = (year - 1) * 12 + 12;
      for (let k = pStart; k <= pEnd; k++) {
        const t = byKey[pre + k];
        if (t) { target.amount += t.amount; target.ben += t.ben; }
      }
    }
    return {
      localityId: loc.id,
      nameAr: loc.nameAr,
      nameEn: loc.nameEn,
      color: loc.color,
      actualAmount: actual.amount,
      targetAmount: target.amount,
      pctAmount: target.amount > 0 ? Math.round(actual.amount / target.amount * 100) : null,
      actualBen: actual.ben,
      targetBen: target.ben,
      pctBen: target.ben > 0 ? Math.round(actual.ben / target.ben * 100) : null
    };
  });

  const totals = results.reduce((t, r) => {
    t.actualAmount += r.actualAmount;
    t.targetAmount += r.targetAmount;
    t.actualBen += r.actualBen;
    t.targetBen += r.targetBen;
    return t;
  }, { actualAmount: 0, targetAmount: 0, actualBen: 0, targetBen: 0 });
  totals.pctAmount = totals.targetAmount > 0 ? Math.round(totals.actualAmount / totals.targetAmount * 100) : null;
  totals.pctBen = totals.targetBen > 0 ? Math.round(totals.actualBen / totals.targetBen * 100) : null;

  res.json({ year, month: month || null, targets: results, totals });
}));

// Excel export (admin only) - filtered same as /stats
router.get('/export', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const filters = buildFilters(req);
  const where = whereSql(filters);
  const reports = await db.all(`
    SELECT r.*, u.name AS user_name,
      l.name_ar AS locality_ar, l.name_en AS locality_en,
      d.name AS donor_name,
      s.name_ar AS support_ar, s.name_en AS support_en,
      p.name AS partner_name
    FROM reports r
    LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN localities l ON l.id = r.locality_id
    LEFT JOIN donors d ON d.id = r.donor_id
    LEFT JOIN support_types s ON s.id = r.support_type_id
    LEFT JOIN partners p ON p.id = r.partner_id
    ${where}
    ORDER BY r.year DESC, r.month_id DESC, r.id DESC
  `, filters.params);

  const localityAgg = {};
  const donorAgg = {};
  const statusAgg = {};
  const monthName = m => (MONTHS.find(x => x.id === m) || {}).name_ar || String(m || '');
  const statusLabel = s => s === 'approved' ? 'معتمد' : s === 'rejected' ? 'مرفوض' : 'قيد المراجعة';

  for (const r of reports) {
    const locName = r.locality_ar || r.locality_en || '—';
    localityAgg[locName] = localityAgg[locName] || { count: 0, amount: 0, ben: 0 };
    localityAgg[locName].count++;
    localityAgg[locName].amount += r.amount_received || 0;
    localityAgg[locName].ben += r.beneficiaries_total || 0;

    const donName = r.donor_name || '—';
    donorAgg[donName] = donorAgg[donName] || { count: 0, amount: 0 };
    donorAgg[donName].count++;
    donorAgg[donName].amount += r.amount_received || 0;

    const stLabel = statusLabel(r.status);
    statusAgg[stLabel] = statusAgg[stLabel] || { count: 0, amount: 0, ben: 0 };
    statusAgg[stLabel].count++;
    statusAgg[stLabel].amount += r.amount_received || 0;
    statusAgg[stLabel].ben += r.beneficiaries_total || 0;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'North Darfur ERP';
  wb.created = new Date();

  const headerStyle = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4A148C' } }, alignment: { vertical: 'middle', horizontal: 'center' } };

  const ws1 = wb.addWorksheet('التقارير');
  ws1.columns = [
    { header: 'الرقم المرجعي', key: 'refCode', width: 16 },
    { header: 'اسم الغرفة', key: 'err', width: 22 },
    { header: 'المحلية', key: 'locality', width: 20 },
    { header: 'الممول', key: 'donor', width: 20 },
    { header: 'القطاع', key: 'sector', width: 18 },
    { header: 'الشريك', key: 'partner', width: 18 },
    { header: 'الشهر', key: 'month', width: 14 },
    { header: 'السنة', key: 'year', width: 8 },
    { header: 'المبلغ (جنيه)', key: 'amount', width: 16 },
    { header: 'المستفيدون', key: 'ben', width: 14 },
    { header: 'ذكور', key: 'male', width: 10 },
    { header: 'إناث', key: 'female', width: 10 },
    { header: 'الحالة', key: 'status', width: 14 },
    { header: 'تاريخ الإرسال', key: 'created', width: 20 },
    { header: 'تاريخ المراجعة', key: 'reviewed', width: 20 },
    { header: 'ملاحظة المراجعة', key: 'note', width: 30 },
    { header: 'المستخدم', key: 'user', width: 18 }
  ];
  ws1.getRow(1).eachCell(c => { c.style = headerStyle; });
  for (const r of reports) {
    ws1.addRow({
      refCode: r.ref_code || '',
      err: r.err_name || '',
      locality: r.locality_ar || r.locality_en || '',
      donor: r.donor_name || '',
      sector: r.support_ar || r.support_en || '',
      partner: r.partner_name || '',
      month: monthName(r.month_id),
      year: r.year || '',
      amount: r.amount_received || 0,
      ben: r.beneficiaries_total || 0,
      male: r.beneficiaries_male || 0,
      female: r.beneficiaries_female || 0,
      status: statusLabel(r.status),
      created: r.created_at || '',
      reviewed: r.reviewed_at || '',
      note: r.review_note || '',
      user: r.user_name || ''
    });
  }

  const ws2 = wb.addWorksheet('ملخص حسب المحلية');
  ws2.columns = [
    { header: 'المحلية', key: 'name', width: 24 },
    { header: 'عدد التقارير', key: 'count', width: 14 },
    { header: 'المبلغ (جنيه)', key: 'amount', width: 18 },
    { header: 'المستفيدون', key: 'ben', width: 14 }
  ];
  ws2.getRow(1).eachCell(c => { c.style = headerStyle; });
  for (const [name, v] of Object.entries(localityAgg)) ws2.addRow({ name, count: v.count, amount: v.amount, ben: v.ben });

  const ws3 = wb.addWorksheet('ملخص حسب الممول');
  ws3.columns = [
    { header: 'الممول', key: 'name', width: 24 },
    { header: 'عدد التقارير', key: 'count', width: 14 },
    { header: 'المبلغ (جنيه)', key: 'amount', width: 18 }
  ];
  ws3.getRow(1).eachCell(c => { c.style = headerStyle; });
  for (const [name, v] of Object.entries(donorAgg)) ws3.addRow({ name, count: v.count, amount: v.amount });

  const ws4 = wb.addWorksheet('ملخص حسب الحالة');
  ws4.columns = [
    { header: 'الحالة', key: 'name', width: 18 },
    { header: 'عدد التقارير', key: 'count', width: 14 },
    { header: 'المبلغ (جنيه)', key: 'amount', width: 18 },
    { header: 'المستفيدون', key: 'ben', width: 14 }
  ];
  ws4.getRow(1).eachCell(c => { c.style = headerStyle; });
  for (const [name, v] of Object.entries(statusAgg)) ws4.addRow({ name, count: v.count, amount: v.amount, ben: v.ben });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="north-darfur-reports-${new Date().toISOString().split('T')[0]}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
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
