const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'data-collection-secret-key-2024';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: '登录已过期，请重新登录' });
    }
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足，需要管理员权限' });
  }
  next();
}

module.exports = { authenticateToken, requireAdmin, JWT_SECRET };
