// التحقق من مسار PostgreSQL (قواعد الكتابة والشيفرة) عبر PGlite — محرك PostgreSQL يعمل داخل العملية
import { PGlite } from '@electric-sql/pglite';
import { buildSchemaStatements, createPGLayer, seedData, translateToPG, MONTHS } from './server/db.js';
import bcrypt from 'bcryptjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`✔ ${name}`); }
  else { fail++; console.log(`✘ ${name} ${extra}`); }
}

const pg = new PGlite();
const layer = createPGLayer({ query: (sql, values) => pg.query(sql, values) });

// 1. DDL يعمل بصيغة PostgreSQL
try {
  for (const stmt of buildSchemaStatements('pg')) {
    await pg.query(stmt);
  }
  check('schema DDL on PG', true);
} catch (e) {
  check('schema DDL on PG', false, e.message);
}

// 2. البذور الأولية
await seedData(layer);

// 3. إنشاء مستخدم + تسجيل دخول (bcrypt)
const hash = bcrypt.hashSync('test12345', 10);
const insUser = await layer.run(
  'INSERT INTO users (email, password_hash, name, role, locality_id) VALUES (?, ?, ?, ?, ?)',
  ['pguser@ndr.org', hash, 'مستخدم PG', 'user', 1]
);
check('INSERT returns lastInsertRowid', typeof insUser.lastInsertRowid === 'number' && insUser.lastInsertRowid > 0, JSON.stringify(insUser));

const found = await layer.get('SELECT * FROM users WHERE email = ?', ['pguser@ndr.org']);
check('SELECT by email', found && found.email === 'pguser@ndr.org' && bcrypt.compareSync('test12345', found.password_hash));

// 4. تقرير + مراجعة
const rep = await layer.run(`
  INSERT INTO reports (user_id, err_name, locality_id, donor_id, support_type_id, support_description,
    partner_id, month_id, amount_received, beneficiaries_total, beneficiaries_male, beneficiaries_female,
    challenges, positive_outcomes, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
`, [found.id, 'غرفة PG', 1, 1, 1, 'وصف', 1, 6, 1234567.5, 100, 40, 60, 'تحديات', 'نتائج']);
const reportId = rep.lastInsertRowid;
check('insert report', reportId > 0);

// 5. استعلام مع JOIN (مثل تقارير الواجهة)
const joined = await layer.get(`
  SELECT r.*, u.name AS user_name, l.name_ar AS locality_ar, d.name AS donor_name,
    s.name_ar AS support_ar, p.name AS partner_name
  FROM reports r
  JOIN users u ON u.id = r.user_id
  JOIN localities l ON l.id = r.locality_id
  JOIN donors d ON d.id = r.donor_id
  JOIN support_types s ON s.id = r.support_type_id
  JOIN partners p ON p.id = r.partner_id
  WHERE r.id = ?
`, [reportId]);
check('JOIN query', joined && joined.user_name && joined.locality_ar === 'الفاشر' && joined.donor_name && joined.support_ar && joined.partner_name);

// 6. استعلام named parameters (نمط activity.js)
const act = await layer.all('SELECT * FROM activity_log WHERE action LIKE @a ORDER BY id LIMIT @limit', { a: '%تقرير%', limit: 10 });
check('named params query', Array.isArray(act));

// 7. UPDATE + صيغة ISO للتاريخ
await layer.run('UPDATE reports SET updated_at = ?, support_description = ? WHERE id = ?',
  [new Date().toISOString(), 'محدّث', reportId]);
const upd = await layer.get('SELECT support_description, updated_at FROM reports WHERE id = ?', [reportId]);
check('update report', upd.support_description === 'محدّث' && /^\d{4}-\d{2}-\d{2}T/.test(upd.updated_at), upd.updated_at);

// 8. تجميعات SUM/COUNT (نمط التحليلات)
const agg = await layer.get('SELECT COALESCE(SUM(amount_received), 0) AS s, COUNT(*) AS c FROM reports WHERE status = ?', ['submitted']);
check('aggregations', agg.s === 1234567.5 && agg.c === 1, JSON.stringify(agg));

// 9. روابط المشاركة + مقارنة ISO للصلاحية
const link = await layer.run(
  'INSERT INTO share_links (token, name, created_by, expires_at, permissions) VALUES (?, ?, ?, ?, ?)',
  ['tok123', 'رابط', found.id, new Date(Date.now() + 3600e3).toISOString(), JSON.stringify({ reports: true })]
);
const active = await layer.all('SELECT * FROM share_links WHERE expires_at > ?', [new Date().toISOString()]);
check('share link ISO expiry', active.length === 1 && active[0].token === 'tok123');

// 10. count التحديث (view_count + 1)
await layer.run('UPDATE share_links SET view_count = view_count + 1 WHERE id = ?', [link.lastInsertRowid]);
const vc = await layer.get('SELECT view_count FROM share_links WHERE id = ?', [link.lastInsertRowid]);
check('increment view_count', vc.view_count === 1);

// 11. translateToPG وحدة مستقلة
const t1 = translateToPG('SELECT * FROM users WHERE id = ? AND active = ?', [5, 1]);
check('translate positional', t1.sql === 'SELECT * FROM users WHERE id = $1 AND active = $2' && t1.values[0] === 5);
const t2 = translateToPG('SELECT * FROM x WHERE a = @a AND b LIKE @b', { a: 1, b: '%x%' });
check('translate named', t2.sql === 'SELECT * FROM x WHERE a = $1 AND b LIKE $2' && t2.values[1] === '%x%');

// 12. MONTHS مستوردة
check('months exported', MONTHS.length === 12);

console.log(`\n===== PG: ${pass} ناجح / ${fail} فشل =====`);
await pg.close();
process.exit(fail > 0 ? 1 : 0);
