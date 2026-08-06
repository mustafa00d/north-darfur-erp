import nodemailer from 'nodemailer';

let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: (process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
}

export async function sendResetEmail(to, name, link) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@ndr.org';
  const subject = 'استعادة كلمة المرور | نظام تقارير شمال دارفور — Password Reset';
  const text =
    `مرحباً ${name},\n\n` +
    `نستلمنا طلباً لاستعادة كلمة المرور في نظام تقارير شمال دارفور.\n` +
    `لإعادة تعيين كلمة المرور، اضغط على الرابط التالي (صالح لمدة ساعة):\n\n` +
    `${link}\n\n` +
    `إذا لم تكن أنت من طلب الاستعادة، تجاهل هذه الرسالة.\n\n` +
    `Hello ${name},\n\n` +
    `We received a password reset request for the North Darfur Reports System.\n` +
    `Click the link below to reset your password (valid for one hour):\n\n` +
    `${link}\n\n` +
    `If you did not request this, you can ignore this email.\n`;

  const t = getTransporter();
  if (t) {
    await t.sendMail({ from, to, subject, text });
  } else {
    console.log('[MAIL] SMTP غير مهيأ — رابط الاستعادة:', link);
  }
}

function baseSender() {
  return { from: process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@ndr.org' };
}

export async function sendReportStatusEmail(to, name, reportTitle, status, note, refCode) {
  const statusAr = status === 'approved' ? 'تمت الموافقة' : 'تم الرفض';
  const statusEn = status === 'approved' ? 'Approved' : 'Rejected';
  const subject = `${statusAr} — ${reportTitle} | Report ${statusEn}`;
  const text =
    `مرحباً ${name},\n\n` +
    `تقريرك (${refCode || reportTitle}) حالته الآن: ${statusAr}.\n` +
    (note ? `ملاحظة المراجعة: ${note}\n` : '') +
    `\nHello ${name},\n\n` +
    `Your report (${refCode || reportTitle}) status is now: ${statusEn}.\n` +
    (note ? `Review note: ${note}\n` : '');
  const t = getTransporter();
  if (t) await t.sendMail({ ...baseSender(), to, subject, text });
  else console.log(`[MAIL] (SMTP غير مهيأ) حالة التقرير ${refCode}: ${status}`);
}

export async function sendNewReportEmail(admins, author, reportTitle, refCode) {
  const subject = 'تقرير جديد بانتظار المراجعة | New report pending review';
  const text =
    `أضاف ${author} تقريراً جديداً: ${reportTitle} (${refCode}).\n\n` +
    `A new report was submitted by ${author}: ${reportTitle} (${refCode}).`;
  const t = getTransporter();
  if (t) {
    for (const a of admins) {
      await t.sendMail({ ...baseSender(), to: a.email, subject, text });
    }
  } else {
    console.log(`[MAIL] (SMTP غير مهيأ) تقرير جديد: ${refCode} — ${reportTitle}`);
  }
}
