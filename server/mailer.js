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
