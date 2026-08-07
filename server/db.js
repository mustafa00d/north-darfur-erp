import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== Static Data ====================

export const MONTHS = [
  { id: 1, nameAr: 'يناير', nameEn: 'January' },
  { id: 2, nameAr: 'فبراير', nameEn: 'February' },
  { id: 3, nameAr: 'مارس', nameEn: 'March' },
  { id: 4, nameAr: 'أبريل', nameEn: 'April' },
  { id: 5, nameAr: 'مايو', nameEn: 'May' },
  { id: 6, nameAr: 'يونيو', nameEn: 'June' },
  { id: 7, nameAr: 'يوليو', nameEn: 'July' },
  { id: 8, nameAr: 'أغسطس', nameEn: 'August' },
  { id: 9, nameAr: 'سبتمبر', nameEn: 'September' },
  { id: 10, nameAr: 'أكتوبر', nameEn: 'October' },
  { id: 11, nameAr: 'نوفمبر', nameEn: 'November' },
  { id: 12, nameAr: 'ديسمبر', nameEn: 'December' }
];

export const SUPPORT_TYPES = [
  { nameAr: 'الغذاء', nameEn: 'Food Assistance', icon: '🍞', color: '#F97316' },
  { nameAr: 'احتياجات نسوية', nameEn: 'Women Needs', icon: '👩', color: '#EC4899' },
  { nameAr: 'الصحة', nameEn: 'Health', icon: '🏥', color: '#EF4444' },
  { nameAr: 'الحماية والإيواء والإجلاء', nameEn: 'Protection & Shelter', icon: '🏠', color: '#8B5CF6' },
  { nameAr: 'المياه والصرف الصحي', nameEn: 'WASH', icon: '💧', color: '#06B6D4' },
  { nameAr: 'التعليم', nameEn: 'Education', icon: '📚', color: '#22C55E' },
  { nameAr: 'بناء القدرات', nameEn: 'Capacity Building', icon: '📈', color: '#3B82F6' },
  { nameAr: 'دعم المتطوعين', nameEn: 'Volunteer Support', icon: '🤝', color: '#84CC16' }
];

// ==================== Schema (portable) ====================

const SQLITE_TS = "strftime('%Y-%m-%dT%H:%M:%S.000Z','now')";
const PG_TS = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export function buildSchemaStatements(backend) {  const pk = backend === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const ts = backend === 'pg' ? PG_TS : SQLITE_TS;
  const amount = backend === 'pg' ? 'DOUBLE PRECISION' : 'REAL';

  return `
CREATE TABLE IF NOT EXISTS users (
  id ${pk},
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  locality_id INTEGER,
  active INTEGER DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (${ts}),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS localities (
  id ${pk},
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  color TEXT DEFAULT '#6B2D5B'
);

CREATE TABLE IF NOT EXISTS donors (
  id ${pk},
  name TEXT NOT NULL,
  color TEXT DEFAULT '#3B82F6'
);

CREATE TABLE IF NOT EXISTS partners (
  id ${pk},
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_types (
  id ${pk},
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  icon TEXT DEFAULT '',
  color TEXT DEFAULT '#3B82F6'
);

CREATE TABLE IF NOT EXISTS reports (
  id ${pk},
  created_at TEXT DEFAULT (${ts}),
  updated_at TEXT DEFAULT (${ts}),
  user_id INTEGER NOT NULL,
  err_name TEXT NOT NULL,
  locality_id INTEGER NOT NULL,
  donor_id INTEGER NOT NULL,
  support_type_id INTEGER NOT NULL,
  support_description TEXT,
  partner_id INTEGER NOT NULL,
  month_id INTEGER NOT NULL,
  year INTEGER NOT NULL DEFAULT 0,
  ref_code TEXT,
  amount_received ${amount} DEFAULT 0,
  beneficiaries_total INTEGER DEFAULT 0,
  beneficiaries_male INTEGER DEFAULT 0,
  beneficiaries_female INTEGER DEFAULT 0,
  challenges TEXT,
  positive_outcomes TEXT,
  status TEXT DEFAULT 'submitted',
  reviewed_by INTEGER,
  reviewed_at TEXT,
  review_note TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id ${pk},
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT DEFAULT (${ts})
);

CREATE TABLE IF NOT EXISTS notifications (
  id ${pk},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  type TEXT DEFAULT 'info',
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (${ts})
);

CREATE TABLE IF NOT EXISTS share_links (
  id ${pk},
  token TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT (${ts}),
  expires_at TEXT NOT NULL,
  permissions TEXT NOT NULL,
  password_hash TEXT,
  view_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS password_resets (
  id ${pk},
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (${ts})
);
`.split(';\n\n').map(s => s.trim()).filter(Boolean);
}

// ==================== PG dialect translation ====================

export function translateToPG(sql, params) {
  const values = [];
  if (params == null) params = [];
  const isArr = Array.isArray(params);
  let i = 0;
  sql = sql.replace(/\?/g, () => {
    values.push(isArr ? params[i] : undefined);
    return `$${++i}`;
  });
  sql = sql.replace(/@([A-Za-z0-9_]+)/g, (m, name) => {
    values.push(params[name]);
    return `$${++i}`;
  });
  return { sql, values };
}

// ==================== Layers ====================

export function createPGLayer(poolLike) {
  return {
    isPG: true,
    async get(sql, params) {
      const t = translateToPG(sql, params);
      const r = await poolLike.query(t.sql, t.values);
      return r.rows[0];
    },
    async all(sql, params) {
      const t = translateToPG(sql, params);
      const r = await poolLike.query(t.sql, t.values);
      return r.rows;
    },
    async run(sql, params) {
      const t = translateToPG(sql, params);
      let q = t.sql;
      if (/^\s*insert\b/i.test(q) && !/\breturning\b/i.test(q)) {
        q += ' RETURNING id';
      }
      const r = await poolLike.query(q, t.values);
      return {
        lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined,
        changes: r.rowCount
      };
    },
    async exec(sql) {
      await poolLike.query(sql);
    }
  };
}

export function createSQLiteLayer(database) {
  const layer = {
    isPG: false,
    get(sql, params) {
      const stmt = database.prepare(sql);
      if (params === undefined) return stmt.get();
      return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
    },
    all(sql, params) {
      const stmt = database.prepare(sql);
      if (params === undefined) return stmt.all();
      return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
    },
    run(sql, params) {
      const stmt = database.prepare(sql);
      const r = params === undefined ? stmt.run()
        : Array.isArray(params) ? stmt.run(...params)
        : stmt.run(params);
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    exec(sql) {
      database.exec(sql);
    }
  };
  return layer;
}

// ==================== Migration (add columns to existing DBs) ====================

async function getColumns(layer, table) {
  if (layer.isPG) {
    const rows = await layer.all(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`
    );
    return rows.map(r => r.column_name);
  }
  const rows = await layer.all(`PRAGMA table_info(${table})`);
  return rows.map(r => r.name);
}

async function migrateColumns(layer) {
  const migrations = {
    users: [
      ['failed_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['locked_until', 'TEXT'],
      ['must_change_password', 'INTEGER NOT NULL DEFAULT 0']
    ],
    share_links: [
      ['password_hash', 'TEXT']
    ],
    reports: [
      ['year', 'INTEGER NOT NULL DEFAULT 0'],
      ['ref_code', 'TEXT']
    ]
  };
  for (const [table, cols] of Object.entries(migrations)) {
    let existing = [];
    try { existing = await getColumns(layer, table); } catch { continue; }
    for (const [name, def] of cols) {
      if (!existing.includes(name)) {
        await layer.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
      }
    }
  }
  // ملء السنة والرقم المرجعي للتقارير القديمة
  try {
    if (layer.isPG) {
      await layer.exec(`UPDATE reports SET year = EXTRACT(YEAR FROM created_at)::int WHERE year IS NULL OR year = 0`);
      await layer.exec(`UPDATE reports SET ref_code = 'ND-' || year || '-' || LPAD(CAST(id AS TEXT), 4, '0') WHERE ref_code IS NULL`);
    } else {
      await layer.exec(`UPDATE reports SET year = CAST(strftime('%Y', created_at) AS INTEGER) WHERE year IS NULL OR year = 0`);
      await layer.exec(`UPDATE reports SET ref_code = 'ND-' || year || '-' || SUBSTR('0000' || id, -4) WHERE ref_code IS NULL`);
    }
    await layer.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_ref_code ON reports (ref_code)');
  } catch (e) { /* الجداول الجديدة لا تحتاج ترحيلاً */ }
}

// ==================== Module-level DB (auto-selected) ====================

const DATABASE_URL = process.env.DATABASE_URL;

let backend = null; // 'pg' | 'sqlite'
let pool = null;
let sqlite = null;
let db = null;

export async function init() {
  if (DATABASE_URL && DATABASE_URL.toLowerCase() !== 'sqlite') {
    const pg = await import('pg');
    const isRemote = !/localhost|127\.0\.0\.1|::1/.test(DATABASE_URL);
    // int8 (COUNT) و numeric (SUM) يعودان نصاً في node-postgres — نحوّلهما لأرقام
    pg.default.types.setTypeParser(20, v => parseInt(v, 10));
    pg.default.types.setTypeParser(1700, v => parseFloat(v));
    pool = new pg.default.Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL !== 'false' && isRemote ? { rejectUnauthorized: false } : undefined
    });
    backend = 'pg';
    db = createPGLayer(pool);
    for (const stmt of buildSchemaStatements('pg')) {
      await db.exec(stmt);
    }
    await migrateColumns(db);
  } else {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    sqlite = new DatabaseSync(path.join(dataDir, 'emergency.db'));
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
    backend = 'sqlite';
    db = createSQLiteLayer(sqlite);
    for (const stmt of buildSchemaStatements('sqlite')) {
      db.exec(stmt);
    }
    await migrateColumns(db);
  }
  await seedData(db);
  return db;
}

export function getDB() {
  if (!db) throw new Error('قاعدة البيانات لم تُهيّأ بعد - اتصل بـ init() أولاً');
  return db;
}

const lazyDb = {
  get isPG() { return getDB().isPG; },
  get: (...args) => getDB().get(...args),
  all: (...args) => getDB().all(...args),
  run: (...args) => getDB().run(...args),
  exec: (...args) => getDB().exec(...args)
};

export default lazyDb;

// ==================== Seed ====================

export async function seedData(layer) {
  const countLocalities = await layer.get('SELECT COUNT(*) AS c FROM localities');
  if (!countLocalities.c) {
    const data = [
      ['الفاشر', 'ALfashir', '#3B82F6'],
      ['مليط', 'Maleet', '#EF4444'],
      ['كتم', 'Kutum', '#F97316'],
      ['المالحة', 'Almalha', '#22C55E'],
      ['دار السلام', 'Daraslam', '#8B5CF6'],
      ['الطويشة', 'Tewatsh', '#06B6D4'],
      ['كلميندو', 'Kelemendo', '#EC4899'],
      ['أم كدادة', 'UMKadada', '#84CC16'],
      ['كرنوي', 'Kornoi', '#B45309'],
      ['الطينة', 'Alteena', '#1E3A8A'],
      ['كورما', 'Korma', '#7C3AED'],
      ['كبكابية', 'Kabkabia', '#059669'],
      ['طويلة', 'Tawila', '#DC2626'],
      ['امبرو', 'Umbaro', '#D97706'],
      ['الكومة', 'Alkuma', '#7C2D12'],
      ['الواحة', 'Alwaha', '#4338CA']
    ];
    for (const d of data) {
      await layer.run('INSERT INTO localities (name_ar, name_en, color) VALUES (?, ?, ?)', d);
    }
  }

  const countDonors = await layer.get('SELECT COUNT(*) AS c FROM donors');
  if (!countDonors.c) {
    const data = [
      ['NPA', '#3B82F6'],
      ['Save the World', '#EF4444'],
      ['NRC', '#22C55E'],
      ['Proximity', '#F97316'],
      ['Acted', '#8B5CF6'],
      ['UNICEF', '#06B6D4']
    ];
    for (const d of data) {
      await layer.run('INSERT INTO donors (name, color) VALUES (?, ?)', d);
    }
  }

  const countPartners = await layer.get('SELECT COUNT(*) AS c FROM partners');
  if (!countPartners.c) {
    for (const n of ['LocHup', 'Direct', 'LCC', 'Adeela']) {
      await layer.run('INSERT INTO partners (name) VALUES (?)', [n]);
    }
  }

  const countTypes = await layer.get('SELECT COUNT(*) AS c FROM support_types');
  if (!countTypes.c) {
    for (const s of SUPPORT_TYPES) {
      await layer.run('INSERT INTO support_types (name_ar, name_en, icon, color) VALUES (?, ?, ?, ?)',
        [s.nameAr, s.nameEn, s.icon, s.color]);
    }
  }

  const countUsers = await layer.get('SELECT COUNT(*) AS c FROM users');
  if (!countUsers.c) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@ndr.org';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@5523';
    const hash = bcrypt.hashSync(adminPassword, 10);
    await layer.run(
      'INSERT INTO users (email, password_hash, name, role, locality_id) VALUES (?, ?, ?, ?, ?)',
      [adminEmail.toLowerCase(), hash, 'مدير النظام', 'admin', 1]
    );
    console.log('✔ تم إنشاء حساب المدير:', adminEmail, '/', adminPassword);
  }
}

// ==================== Logging ====================

export async function logActivity(user, action, entityType, entityId, details = '') {
  await getDB().run(
    `INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user ? user.id : null, user ? user.name : 'نظام', action, entityType, entityId, details]
  );
}

export async function createNotification(userId, title, message, type = 'info') {
  await getDB().run(
    'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
    [userId, title, message, type]
  );
}
