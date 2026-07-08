const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// Railway 部署时使用 /data 目录持久化，本地开发用项目目录
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'data.db');

let _db = null;

// sql.js 封装类，提供与 better-sqlite3 兼容的同步 API
class Database {
  constructor(db) {
    this._db = db;
    this._db.run('PRAGMA foreign_keys = ON');
  }

  exec(sql) {
    this._db.run(sql);
    return this;
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        self._db.run(sql, params);
        return {
          changes: self._db.getRowsModified(),
          lastInsertRowid: (() => {
            try {
              const r = self._db.exec('SELECT last_insert_rowid() as id');
              return r[0]?.values[0]?.[0] ?? null;
            } catch { return null; }
          })()
        };
      },
      get(...params) {
        try {
          const stmt = self._db.prepare(sql);
          stmt.bind(params);
          let result = null;
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            result = {};
            cols.forEach((col, i) => { result[col] = vals[i]; });
          }
          stmt.free();
          return result;
        } catch (e) {
          // 如果 SQL 有语法问题，尝试用 exec
          const r = self._db.exec(sql);
          if (r.length && r[0].values.length) {
            const cols = r[0].columns;
            const vals = r[0].values[0];
            const result = {};
            cols.forEach((col, i) => { result[col] = vals[i]; });
            return result;
          }
          return null;
        }
      },
      all(...params) {
        try {
          const stmt = self._db.prepare(sql);
          if (params.length) stmt.bind(params);
          const results = [];
          const cols = stmt.getColumnNames();
          while (stmt.step()) {
            const vals = stmt.get();
            const row = {};
            cols.forEach((col, i) => { row[col] = vals[i]; });
            results.push(row);
          }
          stmt.free();
          return results;
        } catch (e) {
          // fallback: use exec
          const r = self._db.exec(sql);
          if (r.length) {
            return r[0].values.map(vals => {
              const row = {};
              r[0].columns.forEach((col, i) => { row[col] = vals[i]; });
              return row;
            });
          }
          return [];
        }
      }
    };
  }

  transaction(fn) {
    const self = this;
    return (...args) => {
      self._db.run('BEGIN');
      try {
        fn(...args);
        self._db.run('COMMIT');
      } catch (err) {
        self._db.run('ROLLBACK');
        throw err;
      }
    };
  }

  save() {
    const data = this._db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();

  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  _db = new Database(sqlDb);

  // 初始化表结构
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user' CHECK(role IN ('user', 'admin', 'anonymous')),
      created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS data_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      run_time REAL NOT NULL,
      run_time_unit TEXT DEFAULT '秒' CHECK(run_time_unit IN ('秒', '分钟', '小时')),
      distance REAL NOT NULL,
      distance_unit TEXT DEFAULT 'cm' CHECK(distance_unit IN ('cm', 'mm')),
      voltage REAL NOT NULL,
      voltage_unit TEXT DEFAULT 'V' CHECK(voltage_unit IN ('V', 'KV')),
      upload_time DATETIME DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  _db.exec('CREATE INDEX IF NOT EXISTS idx_data_user_id ON data_records(user_id)');
  _db.exec('CREATE INDEX IF NOT EXISTS idx_data_upload_time ON data_records(upload_time)');

  // 创建默认管理员账户
  const bcrypt = require('bcryptjs');
  const adminExists = _db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    _db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hash, 'admin');
    console.log('默认管理员账户已创建: 用户名 admin  密码 admin123');
  }

  // 创建演示用户 + 预置实验数据
  const demoExists = _db.prepare('SELECT id FROM users WHERE username = ?').get('demo');
  if (!demoExists) {
    const hash = bcrypt.hashSync('demo123', 10);
    const demoUser = _db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('demo', hash, 'user');
    const demoId = demoUser.lastInsertRowid;
    console.log('演示账户已创建: 用户名 demo  密码 demo123');

    // 用密里根公式反推生成真实数据
    // 参数: e_ref=1.602e-19, d=5mm, η=1.83e-5, ρ=874, g=9.80
    const e_ref = 1.602e-19;
    const d_plate = 0.005;
    const eta = 1.83e-5;
    const rho = 874;
    const g = 9.80;
    const dist_m = 0.002; // 观测距离 2mm
    const preFactor = Math.pow(eta, 1.5) / Math.sqrt(2 * rho * g);

    // 目标电荷: n × e_ref + 小噪声
    const targets = [
      { n: 1, V: 500, noise: -0.03 },
      { n: 2, V: 350, noise: 0.02 },
      { n: 3, V: 420, noise: -0.01 },
      { n: 1, V: 480, noise: 0.04 },
      { n: 4, V: 380, noise: -0.02 },
      { n: 2, V: 520, noise: 0.01 },
      { n: 5, V: 300, noise: 0.03 },
      { n: 3, V: 450, noise: -0.04 },
      { n: 6, V: 440, noise: 0.02 },
      { n: 1, V: 510, noise: -0.01 },
      { n: 7, V: 270, noise: 0.015 },
      { n: 4, V: 400, noise: -0.03 },
      { n: 2, V: 360, noise: 0.025 },
      { n: 8, V: 260, noise: -0.02 },
      { n: 5, V: 320, noise: 0.01 },
    ];

    const insert = _db.prepare(
      'INSERT INTO data_records (user_id, run_time, run_time_unit, distance, distance_unit, voltage, voltage_unit) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    targets.forEach((t, i) => {
      const q = t.n * e_ref * (1 + Math.random() * t.noise);
      const v = Math.pow((q * t.V) / (18 * Math.PI * d_plate * preFactor), 2 / 3);
      const time = +(dist_m / v).toFixed(1);
      insert.run(demoId, time, '秒', 2.0, 'mm', t.V, 'V');
    });

    _db.save();
    console.log(`已预置 ${targets.length} 条密里根实验演示数据`);
  }

  console.log('数据库初始化完成');
  return _db;
}

function getDb() {
  if (!_db) throw new Error('数据库尚未初始化，请先调用 initDatabase()');
  return _db;
}

module.exports = { initDatabase, getDb };
