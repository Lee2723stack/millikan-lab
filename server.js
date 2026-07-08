const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== 公网隧道（localtunnel 库，进程内运行，不掉线） ==========
function startTunnel() {
  try {
    const localtunnel = require('localtunnel');
    console.log('[隧道] 正在建立公网通道...');

    const tunnel = localtunnel(PORT, { subdomain: '' }, (err, tunnel) => {
      if (err) {
        console.log(`[隧道] 连接失败: ${err.message}，10秒后重连...`);
        setTimeout(startTunnel, 10000);
        return;
      }
      const url = tunnel.url;
      console.log(`\n========================================`);
      console.log(`  🌐 公网地址: ${url}`);
      console.log(`  分享这个链接给任何人即可访问`);
      console.log(`========================================\n`);
      try {
        fs.writeFileSync(path.join(__dirname, 'tunnel_url.txt'), url);
      } catch(e) {}

      tunnel.on('close', () => {
        console.log('[隧道] 连接断开，5秒后重连...');
        setTimeout(startTunnel, 5000);
      });

      tunnel.on('error', (err) => {
        console.log(`[隧道] 错误: ${err.message}`);
      });
    });
  } catch(e) {
    console.log(`[隧道] 启动异常: ${e.message}`);
    setTimeout(startTunnel, 10000);
  }
}

// 启动服务器
async function start() {
  // 先初始化数据库
  await initDatabase();

  // 数据库就绪后再加载路由
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/data', require('./routes/data'));

  // 前端页面
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // 错误处理
  app.use((err, req, res, next) => {
    if (err.message && err.message.includes('仅支持')) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err.stack);
    res.status(500).json({ error: '服务器内部错误' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`  密里根油滴实验数据采集系统已启动`);
    console.log(`  本地访问: http://localhost:${PORT}`);
    console.log(`  管理员账户: admin / admin123`);
    console.log(`========================================\n`);

    // 启动公网隧道
    setTimeout(startTunnel, 1000);
  });
}

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
