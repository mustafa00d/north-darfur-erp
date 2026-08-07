import db, { createNotification } from './db.js';
import { sendSimpleMail } from './mailer.js';

const JOB = 'monday-batch';
const HOUR_MS = 3600 * 1000;

export function mondayKey(now) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function nowIso(msOffset = 0) {
  return new Date(Date.now() + msOffset).toISOString();
}

async function alreadyRun(today) {
  const row = await db.get('SELECT last_run FROM cron_log WHERE job = ?', [JOB]);
  return !!(row && row.last_run === today);
}

async function markRun(today) {
  await db.run(
    `INSERT INTO cron_log (job, last_run) VALUES (?, ?)
     ON CONFLICT(job) DO UPDATE SET last_run = excluded.last_run`,
    [JOB, today]
  );
}

export async function runMondayJob(opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const today = mondayKey(now);
  const weekday = (now.getUTCDay() + 6) % 7;
  if (weekday !== 0 && !opts.force) return { skipped: true, reason: 'not-monday' };
  if (!opts.force && (await alreadyRun(today))) return { skipped: true, reason: 'already-run' };

  const stats = { rejectedReminded: 0, pendingReminded: 0, summarySent: 0 };
  const emails = [];

  const rejected = await db.all(
    `SELECT r.id, r.err_name, r.ref_code, r.user_id, u.name AS user_name, u.email
     FROM reports r JOIN users u ON u.id = r.user_id
     WHERE r.status = 'rejected'`
  );
  for (const r of rejected) {
    const title = 'تذكير بتقرير مرفوض';
    const msg = `تقريرك (${r.ref_code || r.err_name}) مرفوض ولم يُعد إرساله بعد. يرجى مراجعته وإعادة الإرسال.`;
    await createNotification(r.user_id, title, msg, 'warning');
    emails.push({
      to: r.email,
      subject: `${title} | Reminder: rejected report`,
      text: `مرحباً ${r.user_name},\n\n${msg}\n\nHello ${r.user_name},\n\nYour report (${r.ref_code || r.err_name}) was rejected and has not been resubmitted yet. Please review and resubmit.`
    });
    stats.rejectedReminded++;
  }

  const threshold = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const pending = await db.all(
    `SELECT r.id, r.err_name, r.ref_code, r.locality_id, r.created_at
     FROM reports r WHERE r.status = 'submitted' AND r.created_at < ?`,
    [threshold]
  );
  for (const r of pending) {
    const reviewers = await db.all(
      `SELECT u.id, u.name, u.email FROM users u
       WHERE u.active = 1 AND (
         u.role = 'admin' OR (u.role = 'locality_admin' AND u.locality_id = ?)
       )`,
      [r.locality_id]
    );
    const title = 'تقرير بانتظار المراجعة منذ فترة';
    const msg = `التقرير (${r.ref_code || r.err_name}) لم يُراجَع منذ أكثر من 3 أيام. يرجى مراجعته.`;
    for (const reviewer of reviewers) {
      await createNotification(reviewer.id, title, msg, 'warning');
      emails.push({
        to: reviewer.email,
        subject: `${title} | Pending review reminder`,
        text: `مرحباً ${reviewer.name},\n\n${msg}\n\nHello ${reviewer.name},\n\nThe report (${r.ref_code || r.err_name}) has been awaiting review for more than 3 days.`
      });
    }
    stats.pendingReminded++;
  }

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const week = await db.get(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
       COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
       COALESCE(SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(amount_received), 0) AS amount,
       COALESCE(SUM(beneficiaries_total), 0) AS beneficiaries,
       COUNT(DISTINCT locality_id) AS localities
     FROM reports WHERE created_at >= ?`,
    [weekAgo]
  );
  const admins = await db.all(`SELECT id, name, email FROM users WHERE role = 'admin' AND active = 1`);
  if (week.total > 0) {
    const lines =
      `التقارير المرفوعة هذا الأسبوع: ${week.total}\n` +
      `تمت الموافقة: ${week.approved} | مرفوضة: ${week.rejected} | بانتظار المراجعة: ${week.pending}\n` +
      `إجمالي المبالغ: ${Number(week.amount).toLocaleString('ar-EG')}\n` +
      `إجمالي المستفيدين: ${Number(week.beneficiaries).toLocaleString('ar-EG')}\n` +
      `المحليات النشطة: ${week.localities}`;
    for (const a of admins) {
      await createNotification(a.id, 'الملخص الأسبوعي', lines, 'info');
      emails.push({
        to: a.email,
        subject: 'الملخص الأسبوعي | Weekly summary',
        text: `مرحباً ${a.name},\n\n${lines}\n\nHello ${a.name},\n\nWeekly summary — Reports: ${week.total} (approved ${week.approved}, rejected ${week.rejected}, pending ${week.pending}), Amount: ${week.amount}, Beneficiaries: ${week.beneficiaries}, Active localities: ${week.localities}.`
      });
    }
    stats.summarySent++;
  }

  for (const m of emails) await sendSimpleMail(m.to, m.subject, m.text);

  await markRun(today);
  return { ok: true, date: today, ...stats, emails: emails.length };
}

export function startScheduler() {
  setInterval(async () => {
    try {
      await runMondayJob();
    } catch (err) {
      console.error('[CRON] فشل تشغيل المهمة الأسبوعية:', err.message);
    }
  }, 30 * 60 * 1000);
  console.log('✔ جدولة تذكيرات الاثنين مفعلة (كل 30 دقيقة)');
}
