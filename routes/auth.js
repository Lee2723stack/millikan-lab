const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../database');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');

// 用户注册
router.post('/register', (req, res) => {
  const db = getDb();
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: '用户名长度需在3-20个字符之间' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码长度不能少于6个字符' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(400).json({ error: '用户名已存在' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, hashedPassword, 'user');
  const token = jwt.sign({ id: result.lastInsertRowid, username, role: 'user' }, JWT_SECRET, { expiresIn: '24h' });

  db.save();
  res.json({ message: '注册成功', token, user: { id: result.lastInsertRowid, username, role: 'user' } });
});

// 用户登录
router.post('/login', (req, res) => {
  const db = getDb();
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ message: '登录成功', token, user: { id: user.id, username: user.username, role: user.role } });
});

// 匿名登录
router.post('/anonymous', (req, res) => {
  const db = getDb();
  const anonymousId = 'guest_' + crypto.randomBytes(6).toString('hex');
  const hashedPassword = bcrypt.hashSync(anonymousId, 10);
  const result = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(anonymousId, hashedPassword, 'anonymous');
  const token = jwt.sign({ id: result.lastInsertRowid, username: anonymousId, role: 'anonymous' }, JWT_SECRET, { expiresIn: '24h' });

  db.save();
  res.json({ message: '匿名登录成功', token, user: { id: result.lastInsertRowid, username: anonymousId, role: 'anonymous' } });
});

// 获取当前用户信息
router.get('/me', authenticateToken, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user });
});

// 修改密码
router.post('/change-password', authenticateToken, (req, res) => {
  const db = getDb();
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '旧密码和新密码不能为空' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码长度不能少于6个字符' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(400).json({ error: '旧密码错误' });
  }

  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  db.save();
  res.json({ message: '密码修改成功' });
});

module.exports = router;
