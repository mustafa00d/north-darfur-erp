import bcrypt from 'bcryptjs';
import db, { init, logActivity } from './db.js';

await init();

async function main() {
  const countReports = await db.get('SELECT COUNT(*) AS c FROM reports');
  if (countReports.c > 0) {
    console.log('توجد تقارير موجودة، تم التخطي.');
    return;
  }

  const countUsers = await db.get('SELECT COUNT(*) AS c FROM users WHERE email != ?', ['admin@ndr.org']);
  if (countUsers.c === 0) {
    const hash = bcrypt.hashSync('demo12345', 10);
    const users = [
      ['فريق الفاشر', 'demo1@ndr.org', 1],
      ['فريق كبكابية', 'demo2@ndr.org', 12],
      ['فريق كتم', 'demo3@ndr.org', 3]
    ];
    for (const [name, email, loc] of users) {
      await db.run('INSERT INTO users (email, password_hash, name, role, locality_id) VALUES (?, ?, ?, ?, ?)',
        [email, hash, name, 'user', loc]);
    }
    console.log('✔ تم إنشاء 3 مستخدمين تجريبيين (demo1@ndr.org / demo12345 ...)');
  }

  const sample = [
    { err: 'غرفة طوارئ الفاشر', loc: 1, don: 1, sector: 1, partner: 1, month: 1, amount: 2500000, total: 8200, male: 3900, female: 4300, desc: 'توزيع سلال غذائية أساسية', chal: 'صعوبة الوصول للمناطق النائية', out: 'تحسن الحالة الغذائية' },
    { err: 'غرفة طوارئ الفاشر', loc: 1, don: 6, sector: 4, partner: 1, month: 2, amount: 1800000, total: 6400, male: 2900, female: 3500, desc: 'توفير مواد إيواء', chal: 'نقص مساحة التخزين', out: 'تأمين مأوى للعائلات' },
    { err: 'غرفة طوارئ كبكابية', loc: 12, don: 3, sector: 3, partner: 3, month: 2, amount: 3200000, total: 11500, male: 5100, female: 6400, desc: 'دعم مراكز صحية', chal: 'نقص الكوادر الطبية', out: 'خدمة صحية أفضل' },
    { err: 'غرفة طوارئ كتم', loc: 3, don: 5, sector: 5, partner: 2, month: 3, amount: 900000, total: 4800, male: 2200, female: 2600, desc: 'حفر آبار مياه', chal: 'انخفاض منسوب المياه', out: 'توفر مياه نظيفة' },
    { err: 'غرفة طوارئ كبكابية', loc: 12, don: 2, sector: 6, partner: 3, month: 4, amount: 750000, total: 2100, male: 1100, female: 1000, desc: 'دعم مدارس وقرطاسية', chal: 'غياب الطلاب', out: 'استمرار التعليم' },
    { err: 'غرفة طوارئ الفاشر', loc: 1, don: 4, sector: 2, partner: 1, month: 5, amount: 600000, total: 3200, male: 0, female: 3200, desc: 'حقيبة نسوية', chal: 'تحفظات مجتمعية', out: 'دعم مباشر للنساء' },
    { err: 'غرفة طوارئ كتم', loc: 3, don: 6, sector: 1, partner: 2, month: 6, amount: 2100000, total: 9500, male: 4400, female: 5100, desc: 'برنامج تغذية', chal: 'ارتفاع الأسعار', out: 'تحسن التغذية' },
    { err: 'غرفة طوارئ كبكابية', loc: 12, don: 1, sector: 7, partner: 3, month: 7, amount: 450000, total: 350, male: 200, female: 150, desc: 'تدريب متطوعين', chal: 'استمرارية المتطوعين', out: 'قدرات محلية' }
  ];

  const insert = `
    INSERT INTO reports (user_id, err_name, locality_id, donor_id, support_type_id, support_description,
      partner_id, month_id, amount_received, beneficiaries_total, beneficiaries_male,
      beneficiaries_female, challenges, positive_outcomes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const usersRows = await db.all('SELECT * FROM users WHERE email != ?', ['admin@ndr.org']);
  const statuses = ['approved', 'approved', 'submitted', 'approved', 'rejected', 'submitted', 'approved', 'approved'];

  let i = 0;
  for (const s of sample) {
    const user = usersRows[i % usersRows.length];
    await db.run(insert, [
      user.id, s.err, s.loc, s.don, s.sector, s.desc, s.partner, s.month,
      s.amount, s.total, s.male, s.female, s.chal, s.out, statuses[i]
    ]);
    i++;
  }

  const admin = await db.get("SELECT * FROM users WHERE role = 'admin'");
  await logActivity(admin, 'إضافة بيانات تجريبية', 'system', null, 'تهيئة النظام ببيانات تجريبية');
  await db.run('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
    [admin.id, 'مرحباً بك في النظام 👋', 'تم تجهيز النظام ببيانات تجريبية. يمكنك تجربة لوحة الإدارة والتحليلات الآن.', 'success']);

  console.log('✔ تمت إضافة 8 تقارير تجريبية');
  console.log('✔ مستخدمو التجربة: demo1@ndr.org / demo2@ndr.org / demo3@ndr.org (كلمة المرور: demo12345)');
}

await main();
