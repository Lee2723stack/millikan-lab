// 流体粒子背景
(function() {
  const container = document.getElementById('auth-page');
  if (!container) return;
  container.style.position = 'relative';
  container.style.overflow = 'hidden';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;z-index:0;';
  container.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let W, H;
  function resize() {
    const r = container.getBoundingClientRect();
    W = canvas.width = r.width;
    H = canvas.height = r.height;
  }
  resize();
  window.addEventListener('resize', resize);

  // 粒子系统
  const COUNT = 80;
  const particles = [];
  for (let i = 0; i < COUNT; i++) {
    particles.push({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: 60 + Math.random() * 140,
      hue: 240 + Math.random() * 60 // blue to purple
    });
  }

  let mx = W / 2, my = H / 2;

  container.addEventListener('mousemove', e => {
    const r = container.getBoundingClientRect();
    mx = e.clientX - r.left;
    my = e.clientY - r.top;
  });
  container.addEventListener('touchmove', e => {
    e.preventDefault();
    const r = container.getBoundingClientRect();
    mx = e.touches[0].clientX - r.left;
    my = e.touches[0].clientY - r.top;
  }, { passive: false });

  function loop() {
    ctx.clearRect(0, 0, W, H);

    // 暗色底
    ctx.fillStyle = '#0d1528';
    ctx.fillRect(0, 0, W, H);

    // 绘制粒子光晕
    for (const p of particles) {
      // 向鼠标微弱吸引
      const dx = mx - p.x, dy = my - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 300) {
        p.vx += (dx / dist) * 0.02;
        p.vy += (dy / dist) * 0.02;
      }

      // 减速
      p.vx *= 0.995;
      p.vy *= 0.995;
      p.vx += (Math.random() - 0.5) * 0.05;
      p.vy += (Math.random() - 0.5) * 0.05;

      p.x += p.vx;
      p.y += p.vy;

      // 边界回弹
      if (p.x < -p.r) p.x = W + p.r;
      if (p.x > W + p.r) p.x = -p.r;
      if (p.y < -p.r) p.y = H + p.r;
      if (p.y > H + p.r) p.y = -p.r;

      // 渐变光晕
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      grad.addColorStop(0, `hsla(${p.hue}, 70%, 50%, 0.15)`);
      grad.addColorStop(0.5, `hsla(${p.hue}, 60%, 40%, 0.06)`);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    requestAnimationFrame(loop);
  }

  loop();
})();
