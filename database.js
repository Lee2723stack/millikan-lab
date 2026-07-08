const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/millikan';

let _pool = null;

// 将 SQLite 风格的 ? 占位符转换为 PostgreSQL 的 $1, $2
function convertSQL(sql) {
  let n = 1;
  return sql.replace(/\?/g, () => `$${n++}`);
}

class Database {
  constructor(pool) {
    this._pool = pool;
  }

  // 执行 INSERT/UPDATE/DELETE，返回 { rowCount, lastInsertRowid }
  async run(sql, ...params) {
    const pgSql = convertSQL(sql);
    const result = await this._pool.query(pgSql, params);
    let lastInsertRowid = null;
    if (result.rows.length > 0 && result.rows[0].id) {
      lastInsertRowid = result.rows[0].id;
    }
    return { changes: result.rowCount, lastInsertRowid };
  }

  // 查询单行
  async get(sql, ...params) {
    const pgSql = convertSQL(sql);
    const result = await this._pool.query(pgSql, params);
    return result.rows[0] || null;
  }

  // 查询多行
  async all(sql, ...params) {
    const pgSql = convertSQL(sql);
    const result = await this._pool.query(pgSql, params);
    return result.rows;
  }

  // 事务
  async transaction(fn) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async save() {
    // PostgreSQL 自动持久化，无需手动保存
  }
}

async function initDatabase() {
  _pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  // 测试连接
  await _pool.query('SELECT 1');

  // 初始化表结构（PostgreSQL 语法）
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user' CHECK(role IN ('user', 'admin', 'anonymous')),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS data_records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      run_time REAL NOT NULL,
      run_time_unit TEXT DEFAULT '秒',
      distance REAL NOT NULL,
      distance_unit TEXT DEFAULT 'cm',
      voltage REAL NOT NULL,
      voltage_unit TEXT DEFAULT 'V',
      upload_time TIMESTAMP DEFAULT NOW()
    )
  `);

  await _pool.query('CREATE INDEX IF NOT EXISTS idx_data_user_id ON data_records(user_id)');
  await _pool.query('CREATE INDEX IF NOT EXISTS idx_data_upload_time ON data_records(upload_time)');

  const db = new Database(_pool);

  // 创建默认管理员
  const adminExists = await db.get('SELECT id FROM users WHERE username = $1', 'admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.run('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', 'admin', hash, 'admin');
    console.log('默认管理员账户已创建: 用户名 admin  密码 admin123');
  }

  // 创建演示用户 + 演示数据
  const demoExists = await db.get('SELECT id FROM users WHERE username = $1', 'demo');
  if (!demoExists) {
    const hash = bcrypt.hashSync('demo123', 10);
    const result = await db.run(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id',
      'demo', hash, 'user'
    );
    const demoId = result.lastInsertRowid;
    console.log('演示账户已创建: 用户名 demo  密码 demo123');

    // 密里根实验演示数据
    const e_ref = 1.602e-19;
    const d_plate = 0.005;
    const eta = 1.83e-5;
    const rho = 874;
    const g = 9.80;
    const dist_m = 0.002;
    const preFactor = Math.pow(eta, 1.5) / Math.sqrt(2 * rho * g);

    const targets = [
      { n: 1, V: 500 }, { n: 2, V: 350 }, { n: 3, V: 420 },
      { n: 1, V: 480 }, { n: 4, V: 380 }, { n: 2, V: 520 },
      { n: 5, V: 300 }, { n: 3, V: 450 }, { n: 6, V: 440 },
      { n: 1, V: 510 }, { n: 7, V: 270 }, { n: 4, V: 400 },
      { n: 2, V: 360 }, { n: 8, V: 260 }, { n: 5, V: 320 },
    ];

    for (const t of targets) {
      const q = t.n * e_ref * (1 + (Math.random() - 0.5) * 0.04);
      const v = Math.pow((q * t.V) / (18 * Math.PI * d_plate * preFactor), 2 / 3);
      const time = +(dist_m / v).toFixed(1);
      await db.run(
        'INSERT INTO data_records (user_id, run_time, run_time_unit, distance, distance_unit, voltage, voltage_unit) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        demoId, time, '秒', 2.0, 'mm', t.V, 'V'
      );
    }
    console.log(`已预置 ${targets.length} 条密里根实验演示数据`);
  }

  console.log('数据库初始化完成');
  return db;
}

function getDb() {
  if (!_pool) throw new Error('数据库尚未初始化');
  return new Database(_pool);
}

module.exports = { initDatabase, getDb };
