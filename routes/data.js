const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// 配置文件上传
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 Excel (.xlsx, .xls) 和 CSV (.csv) 格式文件'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 列名映射
const COLUMN_MAP = {
  run_time: ['运行时间', 'run_time', 'runtime', '时间', 'time'],
  run_time_unit: ['时间单位', 'run_time_unit', 'time_unit', '单位'],
  distance: ['运动距离', 'distance', '距离', 'dist'],
  distance_unit: ['距离单位', 'distance_unit', 'dist_unit'],
  voltage: ['平衡电压', 'voltage', '电压', 'volt', 'v'],
  voltage_unit: ['电压单位', 'voltage_unit', 'volt_unit']
};

function findColumn(row, keys) {
  for (const key of keys) {
    const val = row[key];
    if (val !== undefined && val !== '' && val !== null) return val;
  }
  return undefined;
}

function validateRecord(record, lineNum) {
  const errors = [];
  if (isNaN(record.run_time) || record.run_time < 0) {
    errors.push(`第${lineNum}行: 运行时间必须为非负数字，当前值: ${record.run_time}`);
  }
  if (isNaN(record.distance) || record.distance < 0) {
    errors.push(`第${lineNum}行: 运动距离必须为非负数字，当前值: ${record.distance}`);
  }
  if (isNaN(record.voltage)) {
    errors.push(`第${lineNum}行: 平衡电压必须为有效数字，当前值: ${record.voltage}`);
  }
  return errors;
}

function normalizeUnit(value, validUnits, defaultUnit) {
  return validUnits.includes(value) ? value : defaultUnit;
}

// ==================== 手动提交单条数据 ====================
router.post('/submit', authenticateToken, (req, res) => {
  const db = getDb();
  const { run_time, run_time_unit, distance, distance_unit, voltage, voltage_unit } = req.body;

  const record = {
    run_time: parseFloat(run_time),
    distance: parseFloat(distance),
    voltage: parseFloat(voltage)
  };

  const errors = validateRecord(record, 1);
  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join('; ') });
  }

  const rtUnit = normalizeUnit(run_time_unit, ['秒', '分钟', '小时'], '秒');
  const distUnit = normalizeUnit(distance_unit, ['cm', 'mm'], 'cm');
  const voltUnit = normalizeUnit(voltage_unit, ['V', 'KV'], 'V');

  const result = db.prepare(
    'INSERT INTO data_records (user_id, run_time, run_time_unit, distance, distance_unit, voltage, voltage_unit) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, record.run_time, rtUnit, record.distance, distUnit, record.voltage, voltUnit);

  db.save();
  res.json({ message: '数据上传成功', id: result.lastInsertRowid });
});

// ==================== 文件批量上传 ====================
router.post('/upload-file', authenticateToken, upload.single('file'), (req, res) => {
  const db = getDb();
  if (!req.file) {
    return res.status(400).json({ error: '请选择要上传的文件' });
  }

  let data;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (err) {
    return res.status(400).json({ error: `文件解析失败: ${err.message}` });
  }

  if (data.length === 0) {
    return res.status(400).json({ error: '文件中没有数据' });
  }
  if (data.length > 1000) {
    return res.status(400).json({ error: '单次上传最多支持1000条数据，当前文件包含' + data.length + '条' });
  }

  const errors = [];
  const validRecords = [];

  data.forEach((row, index) => {
    const lineNum = index + 2;
    const record = {
      run_time: parseFloat(findColumn(row, COLUMN_MAP.run_time)),
      run_time_unit: normalizeUnit(String(findColumn(row, COLUMN_MAP.run_time_unit) || '秒'), ['秒', '分钟', '小时'], '秒'),
      distance: parseFloat(findColumn(row, COLUMN_MAP.distance)),
      distance_unit: normalizeUnit(String(findColumn(row, COLUMN_MAP.distance_unit) || 'cm'), ['cm', 'mm'], 'cm'),
      voltage: parseFloat(findColumn(row, COLUMN_MAP.voltage)),
      voltage_unit: normalizeUnit(String(findColumn(row, COLUMN_MAP.voltage_unit) || 'V'), ['V', 'KV'], 'V')
    };

    const recordErrors = validateRecord(record, lineNum);
    if (recordErrors.length > 0) {
      errors.push(...recordErrors);
    } else {
      validRecords.push(record);
    }
  });

  if (errors.length > 0 && validRecords.length === 0) {
    return res.status(400).json({ error: `数据校验失败:\n${errors.join('\n')}` });
  }

  // 批量插入
  const insert = db.prepare(
    'INSERT INTO data_records (user_id, run_time, run_time_unit, distance, distance_unit, voltage, voltage_unit) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertMany = db.transaction((records) => {
    for (const r of records) {
      insert.run(req.user.id, r.run_time, r.run_time_unit, r.distance, r.distance_unit, r.voltage, r.voltage_unit);
    }
  });
  insertMany(validRecords);
  db.save();

  let message = `成功上传 ${validRecords.length} 条数据`;
  if (errors.length > 0) {
    message += `，${errors.length} 条数据校验失败`;
  }

  res.json({
    message,
    successCount: validRecords.length,
    errorCount: errors.length,
    errors: errors.slice(0, 10)
  });
});

// ==================== 获取当前用户数据（分页+筛选） ====================
router.get('/my-data', authenticateToken, (req, res) => {
  const db = getDb();
  const { page = 1, limit = 20, startDate, endDate, sortBy = 'upload_time', sortOrder = 'DESC' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const allowedSort = ['upload_time', 'run_time', 'distance', 'voltage'];
  const sortColumn = allowedSort.includes(sortBy) ? sortBy : 'upload_time';
  const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  let where = 'WHERE user_id = ?';
  const params = [req.user.id];

  if (startDate) { where += ' AND upload_time >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND upload_time <= ?'; params.push(endDate + ' 23:59:59'); }

  const { total } = db.prepare(`SELECT COUNT(*) as total FROM data_records ${where}`).get(...params);
  const records = db.prepare(
    `SELECT * FROM data_records ${where} ORDER BY ${sortColumn} ${order} LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  // 统计数据
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_count,
      ROUND(AVG(run_time), 2) as avg_run_time,
      ROUND(AVG(distance), 2) as avg_distance,
      ROUND(AVG(voltage), 4) as avg_voltage,
      ROUND(MAX(run_time), 2) as max_run_time,
      ROUND(MAX(distance), 2) as max_distance,
      ROUND(MAX(voltage), 4) as max_voltage,
      ROUND(MIN(run_time), 2) as min_run_time,
      ROUND(MIN(distance), 2) as min_distance,
      ROUND(MIN(voltage), 4) as min_voltage
    FROM data_records ${where}
  `).get(...params);

  res.json({
    records,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) },
    statistics: stats
  });
});

// ==================== 导出数据 ====================
router.get('/export', authenticateToken, (req, res) => {
  const db = getDb();
  const { format = 'csv', startDate, endDate } = req.query;

  let where = 'WHERE user_id = ?';
  const params = [req.user.id];
  if (startDate) { where += ' AND upload_time >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND upload_time <= ?'; params.push(endDate + ' 23:59:59'); }

  const records = db.prepare(`SELECT * FROM data_records ${where} ORDER BY upload_time DESC`).all(...params);

  const exportData = records.map(r => ({
    '运行时间': r.run_time,
    '时间单位': r.run_time_unit,
    '运动距离': r.distance,
    '距离单位': r.distance_unit,
    '平衡电压': r.voltage,
    '电压单位': r.voltage_unit || 'V',
    '上传时间': r.upload_time
  }));

  if (format === 'xlsx') {
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '数据');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('数据导出')}.xlsx`);
    return res.send(buf);
  }

  // CSV
  const ws = XLSX.utils.json_to_sheet(exportData);
  const csv = XLSX.utils.sheet_to_csv(ws);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('数据导出')}.csv`);
  res.send('﻿' + csv);
});

// ==================== 管理员：获取所有用户数据 ====================
router.get('/all-data', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const { page = 1, limit = 20, userId, startDate, endDate, sortBy = 'upload_time', sortOrder = 'DESC' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const allowedSort = ['upload_time', 'run_time', 'distance', 'voltage'];
  const sortColumn = allowedSort.includes(sortBy) ? sortBy : 'upload_time';
  const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  let where = 'WHERE 1=1';
  const params = [];

  if (userId) { where += ' AND d.user_id = ?'; params.push(parseInt(userId)); }
  if (startDate) { where += ' AND d.upload_time >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND d.upload_time <= ?'; params.push(endDate + ' 23:59:59'); }

  const { total } = db.prepare(`SELECT COUNT(*) as total FROM data_records d ${where}`).get(...params);
  const records = db.prepare(
    `SELECT d.*, u.username FROM data_records d JOIN users u ON d.user_id = u.id ${where} ORDER BY d.${sortColumn} ${order} LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  res.json({ records, pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) } });
});

// ==================== 管理员：获取概览统计 ====================
router.get('/statistics', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const overview = db.prepare(`
    SELECT
      COUNT(DISTINCT user_id) as total_users,
      COUNT(*) as total_records,
      ROUND(AVG(run_time), 2) as avg_run_time,
      ROUND(AVG(distance), 2) as avg_distance,
      ROUND(AVG(voltage), 4) as avg_voltage
    FROM data_records
  `).get();

  const userStats = db.prepare(`
    SELECT u.id, u.username, u.role, COUNT(d.id) as record_count,
      ROUND(AVG(d.run_time), 2) as avg_run_time,
      ROUND(AVG(d.distance), 2) as avg_distance,
      ROUND(AVG(d.voltage), 4) as avg_voltage
    FROM users u LEFT JOIN data_records d ON u.id = d.user_id
    GROUP BY u.id ORDER BY record_count DESC
  `).all();

  res.json({ overview, userStats });
});

// ==================== 用户删除自己的数据 ====================
router.delete('/my-record/:id', authenticateToken, (req, res) => {
  const db = getDb();
  const record = db.prepare('SELECT * FROM data_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: '数据记录不存在' });
  if (record.user_id !== req.user.id) {
    return res.status(403).json({ error: '无权删除他人的数据' });
  }
  db.prepare('DELETE FROM data_records WHERE id = ?').run(req.params.id);
  db.save();
  res.json({ message: '数据已删除' });
});

// ==================== 管理员：删除任意数据 ====================
router.delete('/record/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const record = db.prepare('SELECT * FROM data_records WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: '数据记录不存在' });
  db.prepare('DELETE FROM data_records WHERE id = ?').run(req.params.id);
  db.save();
  res.json({ message: '数据已删除' });
});

// ==================== 管理员：获取用户列表 ====================
router.get('/users', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(
    'SELECT u.id, u.username, u.role, u.created_at, COUNT(d.id) as record_count FROM users u LEFT JOIN data_records d ON u.id = d.user_id GROUP BY u.id ORDER BY u.id'
  ).all();
  res.json({ users });
});

// ==================== 全局数据统计（整合所有用户） ====================
router.get('/global-statistics', authenticateToken, (req, res) => {
  const db = getDb();

  // 全局概览
  const overview = db.prepare(`
    SELECT
      COUNT(DISTINCT user_id) as total_users,
      COUNT(*) as total_records,
      ROUND(AVG(run_time), 2) as avg_run_time,
      ROUND(AVG(distance), 2) as avg_distance,
      ROUND(AVG(voltage), 4) as avg_voltage,
      ROUND(MAX(run_time), 2) as max_run_time,
      ROUND(MAX(distance), 2) as max_distance,
      ROUND(MAX(voltage), 4) as max_voltage,
      ROUND(MIN(run_time), 2) as min_run_time,
      ROUND(MIN(distance), 2) as min_distance,
      ROUND(MIN(voltage), 4) as min_voltage,
      ROUND(SUM(run_time), 2) as sum_run_time,
      ROUND(SUM(distance), 2) as sum_distance
    FROM data_records
  `).get();

  // 按用户分组统计
  const userBreakdown = db.prepare(`
    SELECT u.username, u.role, COUNT(d.id) as record_count,
      ROUND(AVG(d.run_time), 2) as avg_run_time,
      ROUND(AVG(d.distance), 2) as avg_distance,
      ROUND(AVG(d.voltage), 4) as avg_voltage,
      ROUND(MAX(d.voltage), 4) as max_voltage,
      ROUND(MIN(d.voltage), 4) as min_voltage
    FROM users u
    INNER JOIN data_records d ON u.id = d.user_id
    GROUP BY u.id
    ORDER BY record_count DESC
  `).all();

  // 按日期分组趋势
  const dailyTrend = db.prepare(`
    SELECT
      DATE(upload_time) as date,
      COUNT(*) as count,
      ROUND(AVG(run_time), 2) as avg_run_time,
      ROUND(AVG(distance), 2) as avg_distance,
      ROUND(AVG(voltage), 4) as avg_voltage
    FROM data_records
    GROUP BY DATE(upload_time)
    ORDER BY date DESC
    LIMIT 30
  `).all();

  // 电压分布统计
  const voltageDist = db.prepare(`
    SELECT
      CASE
        WHEN voltage < 0 THEN '负电压 (<0V)'
        WHEN voltage >= 0 AND voltage < 1 THEN '0~1V'
        WHEN voltage >= 1 AND voltage < 2 THEN '1~2V'
        WHEN voltage >= 2 AND voltage < 3 THEN '2~3V'
        WHEN voltage >= 3 AND voltage < 5 THEN '3~5V'
        WHEN voltage >= 5 AND voltage < 10 THEN '5~10V'
        ELSE '≥10V'
      END as range,
      COUNT(*) as count
    FROM data_records
    GROUP BY range
    ORDER BY MIN(voltage)
  `).all();

  res.json({ overview, userBreakdown, dailyTrend, voltageDist });
});

// ==================== 密里根油滴实验计算 ====================
/**
 * 密里根油滴公式（平衡法） + 最大公约数法求基本电荷：
 *
 *   步骤1: v = l / t                         — 下落速度
 *   步骤2: r = √(9ηv / 2ρg)                  — 油滴半径
 *   步骤3: q = 6πηrv·d / V = (18πd/V)·v³ᐟ²·√(η³/2ρg) — 电荷
 *
 *   步骤4（GCD法）:
 *     4a. 将所有电荷 q₁, q₂, ... 排序
 *     4b. 计算相邻电荷差 Δᵢ = qᵢ₊₁ − qᵢ
 *     4c. 寻找最小公共约数 e_GCD = 使 Σ|qᵢ - nᵢ·e|² 最小的 e
 *     4d. 扫描 e ∈ [0.5, 3.0]×10⁻¹⁹C，残差取极小值即基本电荷
 */
router.post('/millikan-calculate', authenticateToken, (req, res) => {
  const db = getDb();
  const {
    plate_distance = 5.0,
    viscosity = 1.83e-5,
    oil_density = 874,
    gravity = 9.80,
    e_ref = 1.602e-19
  } = req.body;

  const d = plate_distance / 1000;
  const eta = viscosity;
  const rho = oil_density;
  const g = gravity;
  const preFactor = Math.pow(eta, 1.5) / Math.sqrt(2 * rho * g);

  const records = db.prepare(
    'SELECT * FROM data_records WHERE user_id = ? ORDER BY id'
  ).all(req.user.id);

  if (records.length === 0) {
    return res.json({ error: '请先上传数据', results: [], e_estimate: null });
  }

  const results = [];
  const chargesSorted = [];  // {q, id, ...} for GCD analysis

  for (const r of records) {
    let time_s = r.run_time;
    if (r.run_time_unit === '分钟') time_s *= 60;
    else if (r.run_time_unit === '小时') time_s *= 3600;
    let dist_m = r.distance;
    if (r.distance_unit === 'cm') dist_m /= 100;
    else if (r.distance_unit === 'mm') dist_m /= 1000;
    let voltage_v = r.voltage;
    if (r.voltage_unit === 'KV') voltage_v *= 1000;

    if (time_s <= 0 || dist_m <= 0 || voltage_v === 0) {
      results.push({ id: r.id, error: '无效数据' });
      continue;
    }

    const velocity = dist_m / time_s;
    const q = (18 * Math.PI * d / Math.abs(voltage_v)) * Math.pow(velocity, 1.5) * preFactor;
    const radius = Math.sqrt((9 * eta * velocity) / (2 * rho * g));
    const n_float = q / e_ref;
    const n = Math.round(n_float);
    const e_est = n > 0 ? q / n : null;

    results.push({
      id: r.id,
      run_time: r.run_time, run_time_unit: r.run_time_unit,
      distance: r.distance, distance_unit: r.distance_unit,
      voltage: r.voltage, voltage_unit: r.voltage_unit || 'V',
      time_s: +time_s.toFixed(4), dist_m: +dist_m.toExponential(4),
      voltage_v: +voltage_v.toFixed(2),
      velocity: +velocity.toExponential(4),
      radius: +radius.toExponential(4),
      charge: +q.toExponential(4), charge_raw: q,
      n, n_float: +n_float.toFixed(3),
      e_estimate: e_est ? +e_est.toExponential(4) : null,
      error: null
    });

    chargesSorted.push({ id: r.id, q, n, e_est });
  }

  // ==================== GCD 最大公约数法 ====================
  chargesSorted.sort((a, b) => a.q - b.q);

  // 相邻电荷差
  const diffs = [];
  for (let i = 1; i < chargesSorted.length; i++) {
    diffs.push({
      from_id: chargesSorted[i - 1].id,
      to_id: chargesSorted[i].id,
      q_low: chargesSorted[i - 1].q,
      q_high: chargesSorted[i].q,
      delta: chargesSorted[i].q - chargesSorted[i - 1].q
    });
  }

  // ===== 最大公约数法：最小电荷法 + 精细扫描 =====
  // 方法1：从最小电荷出发，尝试 n=1,2,3... 作为候选 e = q_min/n
  const qMin = chargesSorted[0].q;
  const candidates = [];
  for (let n = 1; n <= 30; n++) {
    const e_candidate = qMin / n;
    if (e_candidate < e_ref * 0.3 || e_candidate > e_ref * 3) continue;
    let totalError = 0;
    const assignments = [];
    for (const c of chargesSorted) {
      const n_i = Math.max(1, Math.round(c.q / e_candidate));
      const residual = c.q - n_i * e_candidate;
      totalError += residual * residual;
      assignments.push({ id: c.id, n_i, residual });
    }
    candidates.push({ e: e_candidate, n_min: n, error: totalError, assignments });
  }

  // 方法2：选择最佳候选（偏好更大 e = 更简单解释）
  // 子谐波问题: q=n*e_ref → 也可表示为 q=(2n)*(e_ref/2) → 误差完全相同
  // 从误差最小的候选组中，选 e 最大的（对应最小 n 值，最自然的解释）
  candidates.sort((a, b) => a.error - b.error);
  const minError = candidates[0].error;
  const tolerance = minError * 1.01; // 误差在 1% 以内的都视为等效
  const bestCandidates = candidates.filter(c => c.error <= tolerance);
  bestCandidates.sort((a, b) => b.e - a.e); // e 从大到小
  const bestCandidate = bestCandidates[0];
  let bestE = bestCandidate.e;
  let bestResidualSq = bestCandidate.error;

  // 在 bestE 附近 ±30% 精细扫描 (500点)
  const fineScanPoints = 500;
  const fineMin = bestE * 0.70;
  const fineMax = bestE * 1.30;
  const fineStep = (fineMax - fineMin) / fineScanPoints;
  const scanResults = [];
  let fineBestE = bestE, fineBestScore = Infinity;

  for (let i = 0; i <= fineScanPoints; i++) {
    const e_trial = fineMin + i * fineStep;
    let residualSq = 0;
    for (const c of chargesSorted) {
      const n_trial = Math.max(1, Math.round(c.q / e_trial));
      const r = c.q - n_trial * e_trial;
      residualSq += r * r;
    }
    scanResults.push({ e: e_trial, residual: Math.sqrt(residualSq) });
    if (residualSq < fineBestScore) {
      fineBestScore = residualSq;
      fineBestE = e_trial;
    }
  }
  bestE = fineBestE;
  bestResidualSq = fineBestScore;

  // 用最佳 e 重新分配 n
  const gcdResults = chargesSorted.map(c => {
    const n_gcd = Math.max(1, Math.round(c.q / bestE));
    const residual = c.q - n_gcd * bestE;
    return {
      id: c.id,
      q: +c.q.toExponential(4),
      n_gcd,
      e_from_gcd: +((c.q / n_gcd).toExponential(4)),
      residual: +residual.toExponential(3),
      residual_percent: +((Math.abs(residual) / c.q) * 100).toFixed(2)
    };
  });

  // 统计
  const gcdEvalues = gcdResults.map(r => r.e_from_gcd);
  const avgE = gcdEvalues.reduce((s, v) => s + v, 0) / gcdEvalues.length;
  const variance = gcdEvalues.reduce((s, v) => s + (v - avgE) ** 2, 0) / gcdEvalues.length;

  // n 分布
  const nDist = {};
  gcdResults.forEach(r => { nDist[r.n_gcd] = (nDist[r.n_gcd] || 0) + 1; });

  // 整数倍阶梯参考线
  const maxN = Math.max(...gcdResults.map(r => r.n_gcd), 1);
  const ladderLines = [];
  for (let k = 1; k <= maxN + 2; k++) {
    ladderLines.push({ n: k, q_ref: +((k * bestE).toExponential(4)), q_ref_raw: k * bestE });
  }

  res.json({
    constants: { plate_distance_mm: plate_distance, viscosity: eta, oil_density: rho, gravity: g, e_ref },
    formula: {
      description: '密里根油滴实验 — 最大公约数法',
      step1: 'v = l / t',
      step2: 'r = √(9ηv / 2ρg)',
      step3: 'q = 6πηrv·d / V',
      step4: 'e = GCD(q₁, q₂, ...) = argmin Σ|qᵢ - nᵢ·e|²'
    },
    results,

    // GCD 法结果
    gcd_method: {
      charges_sorted: chargesSorted.map(c => ({ id: c.id, q: +c.q.toExponential(4), q_raw: c.q })),
      diffs,
      scan_results: scanResults,
      best_e: +bestE.toExponential(4),
      best_residual: +Math.sqrt(fineBestScore).toExponential(4),
      e_scan_min: fineMin, e_scan_max: fineMax
    },

    e_estimate: +avgE.toExponential(4),
    e_uncertainty: +Math.sqrt(variance).toExponential(3),
    e_reference: e_ref,
    deviation_percent: +((Math.abs(avgE - e_ref) / e_ref) * 100).toFixed(2),
    n_distribution: nDist,
    ladder_lines: ladderLines,
    gcd_individual: gcdResults,
    total_valid: gcdResults.length,
    total_records: records.length
  });
});

module.exports = router;
