/* ============================================================
   多用户数据收集系统 - 前端应用
   ============================================================ */

// ==================== 配置 ====================
const CONFIG = {
  API_BASE: '/api',
  PAGE_SIZE: 20,
  TOAST_DURATION: 3500
};

// ==================== API 客户端 ====================
const api = {
  async request(method, endpoint, data, options = {}) {
    const headers = { ...options.headers };
    const token = Auth.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const config = { method, headers };
    if (data && !(data instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(data);
    } else if (data instanceof FormData) {
      config.body = data;
    }

    try {
      const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, config);
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          Auth.logout();
          throw new Error(json.error || '登录已过期');
        }
        throw new Error(json.error || `请求失败 (${res.status})`);
      }
      return json;
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        throw new Error('网络连接失败，请检查网络');
      }
      throw err;
    }
  },
  get(endpoint) { return this.request('GET', endpoint); },
  post(endpoint, data) { return this.request('POST', endpoint, data); },
  del(endpoint) { return this.request('DELETE', endpoint); }
};

// ==================== Toast 通知 ====================
const Toast = {
  show(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, CONFIG.TOAST_DURATION);
  },
  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error'); },
  warning(msg) { this.show(msg, 'warning'); },
  info(msg) { this.show(msg, 'info'); }
};

// ==================== 确认对话框 ====================
const Confirm = {
  show(title, message) {
    return new Promise((resolve) => {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-message').textContent = message;
      const modal = document.getElementById('confirm-modal');
      modal.style.display = 'flex';

      const cleanup = () => {
        modal.style.display = 'none';
        document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
        document.getElementById('confirm-ok').removeEventListener('click', onOk);
      };

      const onCancel = () => { cleanup(); resolve(false); };
      const onOk = () => { cleanup(); resolve(true); };

      document.getElementById('confirm-cancel').addEventListener('click', onCancel);
      document.getElementById('confirm-ok').addEventListener('click', onOk);
    });
  }
};

// ==================== 认证模块 ====================
const Auth = {
  getToken() { return localStorage.getItem('token'); },
  setToken(token) { localStorage.setItem('token', token); },
  getUser() {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); }
    catch { return null; }
  },
  setUser(user) { localStorage.setItem('user', JSON.stringify(user)); },
  isLoggedIn() { return !!this.getToken(); },
  isAdmin() { const u = this.getUser(); return u && u.role === 'admin'; },
  logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    document.getElementById('auth-page').style.display = 'flex';
    document.getElementById('app-page').style.display = 'none';
    if (window._currentChart) { window._currentChart.destroy(); window._currentChart = null; }
  },

  async login(username, password) {
    const res = await api.post('/auth/login', { username, password });
    this.setToken(res.token);
    this.setUser(res.user);
    return res;
  },

  async register(username, password) {
    const res = await api.post('/auth/register', { username, password });
    this.setToken(res.token);
    this.setUser(res.user);
    return res;
  },

  async anonymousLogin() {
    const res = await api.post('/auth/anonymous');
    this.setToken(res.token);
    this.setUser(res.user);
    return res;
  }
};

// ==================== 侧边栏导航 ====================
const Nav = {
  currentView: 'upload',
  _rafId: null,
  _targets: [],
  _currents: [],
  _items: [],

  render() {
    const navEl = document.getElementById('sidebar-nav');
    const userEl = document.getElementById('sidebar-user-info');
    const isAdmin = Auth.isAdmin();
    const user = Auth.getUser();

    // 用户信息
    if (userEl && user) {
      userEl.innerHTML = `<strong>${user.username}</strong>${isAdmin ? ' · 管理员' : ''}`;
    }

    // 导航项
    const items = isAdmin
      ? ['📤 上传数据', '📋 我的数据', '📊 统计分析', '🔬 实验计算', '👥 全部数据', '👤 用户管理']
      : ['📤 上传数据', '📋 我的数据', '📊 统计分析', '🔬 实验计算'];
    const views = isAdmin
      ? ['upload', 'myData', 'stats', 'millikan', 'allData', 'users']
      : ['upload', 'myData', 'stats', 'millikan'];

    navEl.innerHTML = items.map((label, i) => `
      <li class="line-sidebar__item" data-view="${views[i]}" aria-current="${this.currentView === views[i] ? 'true' : 'false'}">
        <span class="line-sidebar__marker" aria-hidden="true"></span>
        <span class="line-sidebar__label">
          <span class="line-sidebar__index">${String(i + 1).padStart(2, '0')}</span>
          <span class="line-sidebar__text">${label.slice(2)}</span>
        </span>
      </li>
    `).join('');

    // 缓存 item 引用
    this._items = [...navEl.querySelectorAll('.line-sidebar__item')];
    this._targets = this._items.map(() => 0);
    this._currents = this._items.map(() => 0);

    // 点击切换
    this._items.forEach(item => {
      item.addEventListener('click', () => this.switchTo(item.dataset.view));
    });

    // 指针追踪
    navEl.onpointermove = (e) => this._handlePointerMove(e);
    navEl.onpointerleave = () => this._handlePointerLeave();

    // 启动动画循环
    this._startLoop();
  },

  _handlePointerMove(e) {
    const rect = document.getElementById('sidebar-nav').getBoundingClientRect();
    const py = e.clientY - rect.top;
    const radius = 120;
    this._items.forEach((el, i) => {
      const center = el.offsetTop + el.offsetHeight / 2;
      const dist = Math.abs(py - center);
      const p = Math.max(0, 1 - dist / radius);
      this._targets[i] = p * p * (3 - 2 * p); // smoothstep
    });
  },

  _handlePointerLeave() {
    this._targets = this._items.map(() => 0);
  },

  _startLoop() {
    if (this._rafId) return;
    let last = performance.now();
    const run = (now) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const tau = 0.1;
      const k = 1 - Math.exp(-dt / tau);
      let moving = false;
      this._items.forEach((el, i) => {
        const target = Math.max(this._targets[i], this.currentView === el.dataset.view ? 1 : 0);
        const cur = this._currents[i] || 0;
        const next = cur + (target - cur) * k;
        const settled = Math.abs(target - next) < 0.002;
        this._currents[i] = settled ? target : next;
        const v = this._currents[i];
        el.style.setProperty('--effect', v.toFixed(4));
        // 颜色混合
        const r = Math.round(255 * (1 - v) + 255 * v);
        const g = Math.round(255 * (1 - v) + 255 * v);
        const b = Math.round(255 * (1 - v) + 255 * v);
        el.style.color = `rgba(${r},${g},${b},${0.55 + v * 0.45})`;
        el.style.paddingLeft = `${24 + v * 8}px`;
        // marker 伸缩
        const marker = el.querySelector('.line-sidebar__marker');
        if (marker) marker.style.transform = `scaleX(${0.5 + v * 0.8})`;
        if (!settled) moving = true;
      });
      if (moving) this._rafId = requestAnimationFrame(run);
      else this._rafId = null;
    };
    this._rafId = requestAnimationFrame(run);
  },

  switchTo(view) {
    this.currentView = view;
    this.render();
    this.loadView(view);
  },

  loadView(view) {
    const container = document.getElementById('main-content');
    container.innerHTML = '<div class="loading"><div class="spinner"></div><span class="loading-text">加载中...</span></div>';

    switch (view) {
      case 'upload': renderUploadView(container); break;
      case 'myData': renderMyDataView(container); break;
      case 'stats': renderStatsView(container); break;
      case 'millikan': renderMillikanView(container); break;
      case 'allData': renderAllDataView(container); break;
      case 'users': renderUsersView(container); break;
    }
  }
};

// ==================== 上传视图 ====================
function renderUploadView(container) {
  container.innerHTML = `
    <div class="card">
      <div class="card-header"><h2 class="card-title">📤 上传数据</h2></div>
      <p class="card-subtitle mb-16">支持手动填写表单或批量上传 Excel/CSV 文件</p>

      <!-- 手动输入表单 -->
      <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">方式一：手动输入</h3>
      <div class="form-row">
        <div class="form-group">
          <label>运行时间</label>
          <input type="number" id="form-run-time" placeholder="请输入数值" min="0" step="any">
        </div>
        <div class="form-group" style="flex:0 0 120px;">
          <label>&nbsp;</label>
          <select id="form-run-time-unit">
            <option value="秒">秒</option>
            <option value="分钟">分钟</option>
            <option value="小时">小时</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>运动距离</label>
          <input type="number" id="form-distance" placeholder="请输入数值" min="0" step="any">
        </div>
        <div class="form-group" style="flex:0 0 120px;">
          <label>&nbsp;</label>
          <select id="form-distance-unit">
            <option value="cm">cm</option>
            <option value="mm">mm</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>平衡电压</label>
          <input type="number" id="form-voltage" placeholder="支持正负数值，如 3.3 或 -1.5" step="any">
        </div>
        <div class="form-group" style="flex:0 0 100px;">
          <label>&nbsp;</label>
          <select id="form-voltage-unit">
            <option value="V">V</option>
            <option value="KV">KV</option>
          </select>
        </div>
      </div>
      <button id="submit-form-btn" class="btn btn-primary">提交数据</button>

      <hr style="margin:24px 0;border:none;border-top:1px solid var(--border);">

      <!-- 文件上传 -->
      <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">方式二：文件批量上传</h3>
      <div class="upload-zone" id="upload-zone">
        <div class="upload-zone-icon">📁</div>
        <div class="upload-zone-text">拖拽文件到此处，或点击选择文件</div>
        <div class="upload-zone-hint">支持 Excel (.xlsx, .xls) 和 CSV (.csv) 格式，单次最多1000条</div>
        <input type="file" id="file-input" accept=".xlsx,.xls,.csv">
      </div>
      <div id="upload-result" class="mt-16" style="display:none;"></div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">📋 列名说明</h2></div>
      <p class="text-secondary" style="font-size:13px;line-height:2;">
        文件表头支持中英文：<br>
        <strong>运行时间</strong> / run_time / runtime / 时间 / time &nbsp;|&nbsp;
        <strong>时间单位</strong>（可选）：秒/分钟/小时<br>
        <strong>运动距离</strong> / distance / 距离 / dist &nbsp;|&nbsp;
        <strong>距离单位</strong>（可选）：cm / mm<br>
        <strong>平衡电压</strong> / voltage / 电压 / volt / v &nbsp;|&nbsp; 单位: V / KV<br>
        <strong>电压单位</strong>（可选）：V / KV
      </p>
    </div>
  `;

  // 手动提交
  document.getElementById('submit-form-btn').addEventListener('click', async () => {
    const run_time = document.getElementById('form-run-time').value;
    const distance = document.getElementById('form-distance').value;
    const voltage = document.getElementById('form-voltage').value;

    if (!run_time || !distance || !voltage) {
      return Toast.warning('请填写所有必填字段');
    }

    try {
      const btn = document.getElementById('submit-form-btn');
      btn.disabled = true;
      btn.textContent = '提交中...';

      await api.post('/data/submit', {
        run_time,
        run_time_unit: document.getElementById('form-run-time-unit').value,
        distance,
        distance_unit: document.getElementById('form-distance-unit').value,
        voltage,
        voltage_unit: document.getElementById('form-voltage-unit').value
      });

      Toast.success('数据上传成功！');
      document.getElementById('form-run-time').value = '';
      document.getElementById('form-distance').value = '';
      document.getElementById('form-voltage').value = '';
    } catch (err) {
      Toast.error(err.message);
    } finally {
      const btn = document.getElementById('submit-form-btn');
      btn.disabled = false;
      btn.textContent = '提交数据';
    }
  });

  // 文件上传区事件
  const zone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFileUpload(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileUpload(fileInput.files[0]);
  });

  async function handleFileUpload(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext)) {
      return Toast.error('仅支持 Excel (.xlsx, .xls) 和 CSV (.csv) 格式文件');
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      const btn = document.createElement('button');
      Toast.info(`正在上传 ${file.name}...`);

      const result = await api.post('/data/upload-file', formData);

      const resultEl = document.getElementById('upload-result');
      resultEl.style.display = 'block';

      let html = `<div style="padding:12px;border-radius:var(--radius);background:var(--success-light);color:var(--success);">✅ ${result.message}</div>`;
      if (result.errors && result.errors.length > 0) {
        html += `<div class="mt-8" style="padding:12px;border-radius:var(--radius);background:var(--warning-light);color:var(--warning);font-size:13px;">
          ⚠️ 校验失败详情：<br>${result.errors.map(e => '&nbsp;&nbsp;• ' + e).join('<br>')}
        </div>`;
      }
      resultEl.innerHTML = html;

      if (result.errorCount === 0) {
        Toast.success(result.message);
      } else {
        Toast.warning(result.message);
      }
    } catch (err) {
      Toast.error(err.message);
    }
  }
}

// ==================== 我的数据视图 ====================
async function renderMyDataView(container) {
  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">📋 我的数据</h2>
        <div class="flex gap-8">
          <button id="export-csv-btn" class="btn btn-outline btn-sm">导出 CSV</button>
          <button id="export-xlsx-btn" class="btn btn-outline btn-sm">导出 Excel</button>
        </div>
      </div>
      <div class="filter-bar">
        <div class="form-group">
          <label>开始日期</label>
          <input type="date" id="filter-start-date">
        </div>
        <div class="form-group">
          <label>结束日期</label>
          <input type="date" id="filter-end-date">
        </div>
        <div class="form-group">
          <label>排序字段</label>
          <select id="filter-sort-by">
            <option value="upload_time">上传时间</option>
            <option value="run_time">运行时间</option>
            <option value="distance">运动距离</option>
            <option value="voltage">平衡电压</option>
          </select>
        </div>
        <div class="form-group">
          <label>&nbsp;</label>
          <button id="filter-apply-btn" class="btn btn-primary btn-sm">查询</button>
          <button id="filter-reset-btn" class="btn btn-outline btn-sm">重置</button>
        </div>
      </div>
      <div id="my-data-table-container">
        <div class="loading"><div class="spinner"></div><span class="loading-text">加载数据...</span></div>
      </div>
    </div>
  `;

  // 导出按钮
  document.getElementById('export-csv-btn').addEventListener('click', () => exportData('csv'));
  document.getElementById('export-xlsx-btn').addEventListener('click', () => exportData('xlsx'));
  document.getElementById('filter-apply-btn').addEventListener('click', () => loadMyData(1));
  document.getElementById('filter-reset-btn').addEventListener('click', () => {
    document.getElementById('filter-start-date').value = '';
    document.getElementById('filter-end-date').value = '';
    document.getElementById('filter-sort-by').value = 'upload_time';
    loadMyData(1);
  });

  // 初始加载
  await loadMyData(1);
}

function getMyDataFilters() {
  return {
    startDate: document.getElementById('filter-start-date')?.value || '',
    endDate: document.getElementById('filter-end-date')?.value || '',
    sortBy: document.getElementById('filter-sort-by')?.value || 'upload_time'
  };
}

async function loadMyData(page) {
  const container = document.getElementById('my-data-table-container');
  if (!container) return;

  const filters = getMyDataFilters();
  const params = new URLSearchParams({ page, limit: CONFIG.PAGE_SIZE, ...filters });
  const sortOrder = document.getElementById('filter-sort-order')?.value || 'DESC';
  params.append('sortOrder', sortOrder);

  try {
    const data = await api.get(`/data/my-data?${params}`);
    renderDataTable(container, data, page, loadMyData);
  } catch (err) {
    container.innerHTML = `<div class="text-center text-danger" style="padding:40px;">❌ ${err.message}</div>`;
  }
}

function renderDataTable(container, data, currentPage, loadFn) {
  const { records, pagination, statistics } = data;

  let statsHtml = '';
  if (statistics && statistics.total_count > 0) {
    statsHtml = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">总记录数</div><div class="stat-value">${statistics.total_count}<span class="stat-unit"> 条</span></div></div>
        <div class="stat-card"><div class="stat-label">平均运行时间</div><div class="stat-value">${statistics.avg_run_time}<span class="stat-unit"> (原单位)</span></div></div>
        <div class="stat-card"><div class="stat-label">平均运动距离</div><div class="stat-value">${statistics.avg_distance}<span class="stat-unit"> (原单位)</span></div></div>
        <div class="stat-card"><div class="stat-label">平均平衡电压</div><div class="stat-value">${statistics.avg_voltage}<span class="stat-unit"> V</span></div></div>
        <div class="stat-card"><div class="stat-label">极值范围</div><div class="stat-value" style="font-size:14px;">
          时间: ${statistics.min_run_time}~${statistics.max_run_time}<br>
          距离: ${statistics.min_distance}~${statistics.max_distance}<br>
          电压: ${statistics.min_voltage}~${statistics.max_voltage} V
        </div></div>
      </div>`;
  }

  let tableHtml = '<div class="table-container"><table><thead><tr>';
  const headers = ['ID', '运行时间', '时间单位', '运动距离', '距离单位', '平衡电压', '电压单位', '上传时间', '操作'];
  headers.forEach(h => { tableHtml += `<th>${h}</th>`; });
  tableHtml += '</tr></thead><tbody>';

  if (records.length === 0) {
    tableHtml += '<tr class="empty-row"><td colspan="9">暂无数据</td></tr>';
  } else {
    records.forEach(r => {
      tableHtml += `<tr>
        <td>${r.id}</td>
        <td>${r.run_time}</td>
        <td>${r.run_time_unit}</td>
        <td>${r.distance}</td>
        <td>${r.distance_unit}</td>
        <td>${r.voltage}</td>
        <td>${r.voltage_unit || 'V'}</td>
        <td>${r.upload_time}</td>
        <td><button class="btn btn-danger btn-sm my-delete-btn" data-id="${r.id}">删除</button></td>
      </tr>`;
    });
  }
  tableHtml += '</tbody></table></div>';

  // 分页
  let paginationHtml = '';
  if (pagination.totalPages > 1) {
    paginationHtml = '<div class="pagination">';
    paginationHtml += `<button ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">上一页</button>`;

    const maxButtons = 7;
    let start = Math.max(1, currentPage - 3);
    let end = Math.min(pagination.totalPages, start + maxButtons - 1);
    if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);

    for (let i = start; i <= end; i++) {
      paginationHtml += `<button class="${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }

    paginationHtml += `<button ${currentPage >= pagination.totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">下一页</button>`;
    paginationHtml += `<span class="page-info">共 ${pagination.total} 条，${pagination.totalPages} 页</span>`;
    paginationHtml += '</div>';
  }

  container.innerHTML = statsHtml + tableHtml + paginationHtml;

  // 绑定分页事件
  container.querySelectorAll('.pagination button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => loadFn(parseInt(btn.dataset.page)));
  });

  // 绑定删除事件
  container.querySelectorAll('.my-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const confirmed = await Confirm.show('确认删除', `确定要删除数据记录 #${id} 吗？此操作不可恢复。`);
      if (!confirmed) return;

      try {
        await api.del(`/data/my-record/${id}`);
        Toast.success('数据已删除');
        // 重新加载当前页
        const pageBtns = container.querySelectorAll('.pagination button.active');
        const page = pageBtns.length > 0 ? parseInt(pageBtns[0].dataset.page) : 1;
        loadFn(page);
      } catch (err) {
        Toast.error(err.message);
      }
    });
  });
}

async function exportData(format) {
  try {
    const filters = getMyDataFilters();
    const params = new URLSearchParams({ format, ...filters });
    const token = Auth.getToken();

    const res = await fetch(`${CONFIG.API_BASE}/data/export?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || '导出失败');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ext = format === 'xlsx' ? 'xlsx' : 'csv';
    a.download = `数据导出_${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    Toast.success('数据导出成功！');
  } catch (err) {
    Toast.error(err.message);
  }
}

// ==================== 统计分析视图 ====================
async function renderStatsView(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div><span class="loading-text">加载统计数据...</span></div>';

  try {
    // 并行加载个人数据和全局数据
    const [myData, globalData] = await Promise.all([
      api.get('/data/my-data?limit=10000'),
      api.get('/data/global-statistics')
    ]);

    const { records, statistics } = myData;
    const { overview, userBreakdown, dailyTrend, voltageDist } = globalData;

    // 如果没有任何数据
    if (overview.total_records === 0) {
      container.innerHTML = `
        <div class="card text-center" style="padding:60px;">
          <div style="font-size:48px;margin-bottom:16px;">📊</div>
          <h3>暂无数据</h3>
          <p class="text-secondary mt-8">上传数据后将在此处显示统计图表</p>
        </div>`;
      return;
    }

    let html = '';

    // ========== 全局概览卡片 ==========
    html += `
    <div class="card">
      <div class="card-header"><h2 class="card-title">🌐 全局数据概览（所有用户）</h2></div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">参与用户</div><div class="stat-value">${overview.total_users}<span class="stat-unit"> 人</span></div></div>
        <div class="stat-card"><div class="stat-label">数据总量</div><div class="stat-value">${overview.total_records}<span class="stat-unit"> 条</span></div></div>
        <div class="stat-card"><div class="stat-label">平均运行时间</div><div class="stat-value">${overview.avg_run_time || 'N/A'}</div></div>
        <div class="stat-card"><div class="stat-label">平均运动距离</div><div class="stat-value">${overview.avg_distance || 'N/A'}</div></div>
        <div class="stat-card"><div class="stat-label">平均平衡电压</div><div class="stat-value">${overview.avg_voltage || 'N/A'}<span class="stat-unit"> V</span></div></div>
        <div class="stat-card"><div class="stat-label">电压范围</div><div class="stat-value" style="font-size:15px;">${overview.min_voltage} ~ ${overview.max_voltage}<span class="stat-unit"> V</span></div></div>
      </div>
    </div>`;

    // ========== 每日趋势图 + 电压分布图 ==========
    html += `
    <div class="chart-row">
      <div class="card">
        <h3 class="card-title mb-16">📈 每日数据趋势（全局）</h3>
        <div class="chart-container"><canvas id="daily-trend-chart"></canvas></div>
      </div>
      <div class="card">
        <h3 class="card-title mb-16">⚡ 电压分布统计</h3>
        <div class="chart-container"><canvas id="voltage-dist-chart"></canvas></div>
      </div>
    </div>`;

    // ========== 用户贡献排行榜 ==========
    if (userBreakdown.length > 0) {
      html += `
      <div class="card">
        <div class="card-header"><h2 class="card-title">🏆 用户数据贡献排行</h2></div>
        <div class="table-container">
          <table>
            <thead><tr>
              <th>排名</th><th>用户名</th><th>角色</th><th>数据条数</th><th>平均运行时间</th><th>平均距离</th><th>平均电压</th><th>电压范围</th>
            </tr></thead>
            <tbody>
              ${userBreakdown.map((u, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td><strong>${u.username}</strong></td>
                  <td><span class="badge ${u.role === 'admin' ? 'badge-danger' : u.role === 'anonymous' ? 'badge-warning' : 'badge-info'}">${u.role === 'admin' ? '管理员' : u.role === 'anonymous' ? '匿名' : '用户'}</span></td>
                  <td>${u.record_count} 条</td>
                  <td>${u.avg_run_time || 'N/A'}</td>
                  <td>${u.avg_distance || 'N/A'}</td>
                  <td>${u.avg_voltage || 'N/A'} V</td>
                  <td>${u.min_voltage} ~ ${u.max_voltage} V</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    }

    // ========== 我的数据概览 ==========
    if (records && records.length > 0) {
      html += `
      <div class="card">
        <div class="card-header"><h2 class="card-title">👤 我的数据概览</h2></div>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-label">我的记录数</div><div class="stat-value">${statistics.total_count}<span class="stat-unit"> 条</span></div></div>
          <div class="stat-card"><div class="stat-label">我的平均运行时间</div><div class="stat-value">${statistics.avg_run_time}</div></div>
          <div class="stat-card"><div class="stat-label">我的平均距离</div><div class="stat-value">${statistics.avg_distance}</div></div>
          <div class="stat-card"><div class="stat-label">我的平均电压</div><div class="stat-value">${statistics.avg_voltage}<span class="stat-unit"> V</span></div></div>
          <div class="stat-card"><div class="stat-label">我的最大电压</div><div class="stat-value">${statistics.max_voltage}<span class="stat-unit"> V</span></div></div>
          <div class="stat-card"><div class="stat-label">我的最小电压</div><div class="stat-value">${statistics.min_voltage}<span class="stat-unit"> V</span></div></div>
        </div>
      </div>

      <div class="chart-row">
        <div class="card"><h3 class="card-title mb-16">📈 我的数据趋势</h3><div class="chart-container"><canvas id="my-trend-chart"></canvas></div></div>
        <div class="card"><h3 class="card-title mb-16">📊 我的电压分布</h3><div class="chart-container"><canvas id="my-dist-chart"></canvas></div></div>
      </div>`;
    }

    container.innerHTML = html;

    // ========== 绘制图表 ==========

    // 每日趋势图（全局）
    if (dailyTrend.length > 0) {
      const sorted = [...dailyTrend].reverse();
      if (window._chart1) window._chart1.destroy();
      window._chart1 = new Chart(document.getElementById('daily-trend-chart'), {
        type: 'line',
        data: {
          labels: sorted.map(d => d.date),
          datasets: [
            { label: '记录数', data: sorted.map(d => d.count), borderColor: '#4f6ef7', backgroundColor: 'rgba(79,110,247,.1)', fill: true, tension: 0.3, yAxisID: 'y' },
            { label: '平均电压 (V)', data: sorted.map(d => d.avg_voltage), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.1)', fill: true, tension: 0.3, yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'bottom' } },
          scales: {
            y: { type: 'linear', position: 'left', title: { display: true, text: '记录数' }, beginAtZero: true },
            y1: { type: 'linear', position: 'right', title: { display: true, text: '电压 (V)' }, grid: { drawOnChartArea: false } }
          }
        }
      });
    }

    // 电压分布图（全局）
    if (voltageDist.length > 0) {
      if (window._chart2) window._chart2.destroy();
      window._chart2 = new Chart(document.getElementById('voltage-dist-chart'), {
        type: 'bar',
        data: {
          labels: voltageDist.map(d => d.range),
          datasets: [{ label: '数据条数', data: voltageDist.map(d => d.count), backgroundColor: ['#ef4444','#f59e0b','#10b981','#4f6ef7','#8b5cf6','#ec4899','#06b6d4'], borderWidth: 1 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { title: { display: true, text: '数据条数' }, beginAtZero: true } }
        }
      });
    }

    // 我的趋势图
    if (records && records.length > 0) {
      const recentRecords = records.slice(-50);
      const labels = recentRecords.map(r => r.upload_time?.slice(5, 16) || '');

      if (window._chart3) window._chart3.destroy();
      window._chart3 = new Chart(document.getElementById('my-trend-chart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: '运行时间', data: recentRecords.map(r => r.run_time), borderColor: '#4f6ef7', backgroundColor: 'rgba(79,110,247,.1)', fill: true, tension: 0.3, yAxisID: 'y' },
            { label: '运动距离', data: recentRecords.map(r => r.distance), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.1)', fill: true, tension: 0.3, yAxisID: 'y1' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'bottom' } },
          scales: {
            y: { type: 'linear', position: 'left', title: { display: true, text: '运行时间' } },
            y1: { type: 'linear', position: 'right', title: { display: true, text: '运动距离' }, grid: { drawOnChartArea: false } }
          }
        }
      });

      if (window._chart4) window._chart4.destroy();
      window._chart4 = new Chart(document.getElementById('my-dist-chart'), {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: '平衡电压 (V)',
            data: recentRecords.map(r => r.voltage),
            backgroundColor: recentRecords.map(v => v.voltage >= 0 ? 'rgba(16,185,129,.6)' : 'rgba(239,68,68,.6)'),
            borderColor: recentRecords.map(v => v.voltage >= 0 ? '#10b981' : '#ef4444'),
            borderWidth: 1
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { title: { display: true, text: '电压 (V)' } } }
        }
      });
    }

  } catch (err) {
    container.innerHTML = `<div class="card text-center text-danger" style="padding:40px;">❌ ${err.message}</div>`;
  }
}

// ==================== 管理员：全部数据视图 ====================
async function renderAllDataView(container) {
  container.innerHTML = `
    <div class="card">
      <div class="card-header"><h2 class="card-title">👥 全部用户数据</h2></div>
      <div class="filter-bar">
        <div class="form-group">
          <label>用户筛选</label>
          <select id="admin-filter-user"><option value="">全部用户</option></select>
        </div>
        <div class="form-group">
          <label>开始日期</label>
          <input type="date" id="admin-filter-start">
        </div>
        <div class="form-group">
          <label>结束日期</label>
          <input type="date" id="admin-filter-end">
        </div>
        <div class="form-group">
          <label>&nbsp;</label>
          <button id="admin-filter-apply" class="btn btn-primary btn-sm">查询</button>
          <button id="admin-filter-reset" class="btn btn-outline btn-sm">重置</button>
        </div>
      </div>
      <div id="all-data-table-container">
        <div class="loading"><div class="spinner"></div><span class="loading-text">加载数据...</span></div>
      </div>
    </div>
  `;

  // 加载用户列表到筛选下拉
  try {
    const { users } = await api.get('/data/users');
    const select = document.getElementById('admin-filter-user');
    users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = `${u.username} (${u.record_count}条)`;
      select.appendChild(opt);
    });
  } catch (err) { /* 忽略 */ }

  document.getElementById('admin-filter-apply').addEventListener('click', () => loadAllData(1));
  document.getElementById('admin-filter-reset').addEventListener('click', () => {
    document.getElementById('admin-filter-user').value = '';
    document.getElementById('admin-filter-start').value = '';
    document.getElementById('admin-filter-end').value = '';
    loadAllData(1);
  });

  await loadAllData(1);
}

async function loadAllData(page) {
  const container = document.getElementById('all-data-table-container');
  if (!container) return;

  const params = new URLSearchParams({ page, limit: CONFIG.PAGE_SIZE });
  const userId = document.getElementById('admin-filter-user')?.value;
  const startDate = document.getElementById('admin-filter-start')?.value;
  const endDate = document.getElementById('admin-filter-end')?.value;
  if (userId) params.append('userId', userId);
  if (startDate) params.append('startDate', startDate);
  if (endDate) params.append('endDate', endDate);

  try {
    const data = await api.get(`/data/all-data?${params}`);
    renderAllDataTable(container, data, page);
  } catch (err) {
    container.innerHTML = `<div class="text-center text-danger" style="padding:40px;">❌ ${err.message}</div>`;
  }
}

function renderAllDataTable(container, data, currentPage) {
  const { records, pagination } = data;

  let html = '<div class="table-container"><table><thead><tr>';
  ['ID', '用户', '运行时间', '时间单位', '运动距离', '距离单位', '平衡电压', '电压单位', '上传时间', '操作'].forEach(h => {
    html += `<th>${h}</th>`;
  });
  html += '</tr></thead><tbody>';

  if (records.length === 0) {
    html += '<tr class="empty-row"><td colspan="10">暂无数据</td></tr>';
  } else {
    records.forEach(r => {
      html += `<tr>
        <td>${r.id}</td>
        <td><span class="badge badge-info">${r.username}</span></td>
        <td>${r.run_time}</td>
        <td>${r.run_time_unit}</td>
        <td>${r.distance}</td>
        <td>${r.distance_unit}</td>
        <td>${r.voltage}</td>
        <td>${r.voltage_unit || 'V'}</td>
        <td>${r.upload_time}</td>
        <td><button class="btn btn-danger btn-sm delete-record-btn" data-id="${r.id}" data-user="${r.username}">删除</button></td>
      </tr>`;
    });
  }
  html += '</tbody></table></div>';

  if (pagination.totalPages > 1) {
    html += '<div class="pagination">';
    html += `<button ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">上一页</button>`;
    const maxButtons = 7;
    let start = Math.max(1, currentPage - 3);
    let end = Math.min(pagination.totalPages, start + maxButtons - 1);
    if (end - start < maxButtons - 1) start = Math.max(1, end - maxButtons + 1);
    for (let i = start; i <= end; i++) {
      html += `<button class="${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button ${currentPage >= pagination.totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">下一页</button>`;
    html += `<span class="page-info">共 ${pagination.total} 条，${pagination.totalPages} 页</span>`;
    html += '</div>';
  }

  container.innerHTML = html;

  // 绑定事件
  container.querySelectorAll('.pagination button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => loadAllData(parseInt(btn.dataset.page)));
  });

  container.querySelectorAll('.delete-record-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const username = btn.dataset.user;
      const confirmed = await Confirm.show('确认删除', `确定要删除用户 "${username}" 的数据记录 #${id} 吗？此操作不可恢复。`);
      if (!confirmed) return;

      try {
        await api.del(`/data/record/${id}`);
        Toast.success('数据已删除');
        await loadAllData(currentPage);
      } catch (err) {
        Toast.error(err.message);
      }
    });
  });
}

// ==================== 密里根油滴实验计算 ====================
async function renderMillikanView(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div><span class="loading-text">加载数据...</span></div>';

  try {
    const data = await api.get('/data/my-data?limit=10000');
    const { records } = data;

    container.innerHTML = `
      <!-- GCD 法公式卡片 -->
      <div class="card">
        <div class="card-header"><h2 class="card-title">🔬 密里根油滴实验 — 最大公约数法</h2></div>
        <div class="formula-box">
          <div class="gcd-steps">
            <div class="gcd-step"><span class="gcd-num">①</span><strong>下落速度：</strong>v = l / t</div>
            <div class="gcd-step"><span class="gcd-num">②</span><strong>油滴半径：</strong>r = √(9ηv / 2ρg)</div>
            <div class="gcd-step"><span class="gcd-num">③</span><strong>电荷计算：</strong>q = (18πd/V)·v³ᐟ²·√(η³/2ρg)</div>
            <div class="gcd-step gcd-highlight"><span class="gcd-num">④</span><strong>GCD 法求 e：</strong></div>
            <div class="gcd-detail">a) 将所有 q 从小到大排序：q₁, q₂, q₃, ...</div>
            <div class="gcd-detail">b) 计算相邻差 Δᵢ = qᵢ₊₁ − qᵢ</div>
            <div class="gcd-detail">c) 扫描 e ∈ [0.5, 3.0]×10⁻¹⁹C，寻找使残差 Σ|qᵢ − nᵢ·e|² 最小的 e</div>
          </div>
          <div class="formula-big" style="margin-top:12px;">e<sub>GCD</sub> = argmin Σ |qᵢ − nᵢ·e|²</div>
        </div>
      </div>

      <!-- 常数参数 -->
      <div class="card">
        <div class="card-header"><h2 class="card-title">⚙️ 实验常数</h2></div>
        <div class="filter-bar">
          <div class="form-group">
            <label>极板间距 d (mm)</label>
            <input type="number" id="mc-d" value="5.00" step="0.01" style="width:100px">
          </div>
          <div class="form-group">
            <label>空气粘滞系数 η (Pa·s)</label>
            <input type="number" id="mc-eta" value="1.83e-5" step="any" style="width:140px">
          </div>
          <div class="form-group">
            <label>油滴密度 ρ (kg/m³)</label>
            <input type="number" id="mc-rho" value="874" style="width:100px">
          </div>
          <div class="form-group">
            <label>重力加速度 g (m/s²)</label>
            <input type="number" id="mc-g" value="9.80" style="width:100px">
          </div>
          <div class="form-group">
            <label>参考基本电荷 (C)</label>
            <input type="number" id="mc-eref" value="1.602e-19" step="any" style="width:140px">
          </div>
          <div class="form-group">
            <label>&nbsp;</label>
            <button id="mc-calc-btn" class="btn btn-primary" ${records.length === 0 ? 'disabled' : ''}>🧮 开始 GCD 计算</button>
          </div>
        </div>
        ${records.length === 0 ? '<div style="padding:20px;text-align:center;color:var(--warning);">⚠️ 暂无可计算数据，请先上传实验数据</div>' : `<p class="text-secondary" style="padding:0 16px 16px;">已加载 <strong>${records.length}</strong> 条实验数据，点击计算</p>`}
      </div>

      <!-- 结果区 -->
      <div id="mc-results"></div>
    `;

    // 绑定计算按钮
    document.getElementById('mc-calc-btn').addEventListener('click', async () => {
      const btn = document.getElementById('mc-calc-btn');
      btn.disabled = true;
      btn.textContent = 'GCD 计算中...';
      document.getElementById('mc-results').innerHTML = '<div class="card"><div class="loading"><div class="spinner"></div><span class="loading-text">正在执行 GCD 算法...</span></div></div>';

      try {
        const params = {
          plate_distance: parseFloat(document.getElementById('mc-d').value) || 5.0,
          viscosity: parseFloat(document.getElementById('mc-eta').value) || 1.83e-5,
          oil_density: parseFloat(document.getElementById('mc-rho').value) || 874,
          gravity: parseFloat(document.getElementById('mc-g').value) || 9.80,
          e_ref: parseFloat(document.getElementById('mc-eref').value) || 1.602e-19
        };

        const calc = await api.post('/data/millikan-calculate', params);

        let resultsHtml = '';

        // 结果摘要
        if (calc.e_estimate) {
          const devClass = calc.deviation_percent < 5 ? 'success' : calc.deviation_percent < 15 ? 'warning' : 'danger';
          const scaledE = calc.e_estimate * 1e19;
          resultsHtml += `
          <div class="card">
            <div class="card-header"><h2 class="card-title">📐 GCD 法计算结果</h2></div>
            <div class="result-highlight">
              <div class="result-main">
                <div class="result-label">最大公约数法测得基本电荷</div>
                <div class="result-value">e = ${calc.e_estimate} C</div>
                <div class="result-sub">= ${scaledE.toFixed(4)} × 10⁻¹⁹ C &nbsp;|&nbsp; GCD 最佳 e: ${calc.gcd_method.best_e} C</div>
              </div>
              <div class="result-compare">
                <div class="result-item">📏 参考值: ${calc.e_reference.toExponential(4)} C</div>
                <div class="result-item text-${devClass}">📊 偏差: ${calc.deviation_percent}%</div>
                <div class="result-item">🔢 有效电荷: ${calc.total_valid} 个</div>
              </div>
            </div>
          </div>`;

          // ============ 图像法图表 ============
          // 图表A: q-n 散点拟合图（图像法核心）
          resultsHtml += `
          <div class="card">
            <div class="card-header"><h2 class="card-title">📐 图像法：q-n 散点拟合</h2><p class="text-secondary">横轴=量子数 n · 纵轴=电荷(×10⁻¹⁹C) · 红色虚线=最佳拟合线 q=e·n &nbsp;|&nbsp; 所有点应落在直线上 → 证明电荷量子化</p></div>
            <div class="chart-container-lg"><canvas id="qn-fit-chart"></canvas></div>
          </div>`;

          // 图表B: 电荷分布直方图
          resultsHtml += `
          <div class="card">
            <div class="card-header"><h2 class="card-title">📊 图像法：电荷值分布</h2><p class="text-secondary">横轴=电荷(×10⁻¹⁹C) · 纵轴=频次 &nbsp;|&nbsp; 灰色虚线标记 GCD法求得的整数倍位置</p></div>
            <div class="chart-container-lg"><canvas id="charge-hist-chart"></canvas></div>
          </div>`;

          // ============ 图表1: 电荷量子化阶梯图 ============
          resultsHtml += `
          <div class="card">
            <div class="card-header"><h2 class="card-title">📈 电荷量子化阶梯图</h2><p class="text-secondary">横轴=测量序号 · 纵轴=电荷(×10⁻¹⁹C) · 虚线=GCD法整数倍参考线</p></div>
            <div class="chart-container-lg"><canvas id="ladder-chart"></canvas></div>
          </div>`;

          // ============ 图表2: GCD 扫描残差图 ============
          resultsHtml += `
          <div class="card">
            <div class="card-header"><h2 class="card-title">🔍 GCD 扫描残差曲线</h2><p class="text-secondary">扫描 e 值寻找残差最小点 → 即基本电荷</p></div>
            <div class="chart-container-lg"><canvas id="scan-chart"></canvas></div>
          </div>`;

          // n 分布
          const nEntries = Object.entries(calc.n_distribution).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
          resultsHtml += `
          <div class="card">
            <div class="card-header"><h2 class="card-title">📊 电荷量子数 n 分布</h2></div>
            <div class="n-dist-grid">
              ${nEntries.map(([n, count]) => `<div class="n-item"><div class="n-value">n=${n}</div><div class="n-count">${count} 个</div></div>`).join('')}
            </div>
          </div>`;
        } else {
          resultsHtml += `<div class="card"><div style="padding:40px;text-align:center;color:var(--warning);">⚠️ ${calc.error || '无有效计算结果'}</div></div>`;
        }

        // GCD 个体结果表
        if (calc.gcd_individual && calc.gcd_individual.length > 0) {
          resultsHtml += `
          <div class="card">
            <div class="card-header"><h2 class="card-title">📋 GCD 法 — 逐电荷分析</h2></div>
            <div class="table-container">
              <table>
                <thead><tr>
                  <th>ID</th><th>电荷 q (C)</th><th>n (GCD)</th><th>e = q/n (C)</th><th>残差 (C)</th><th>残差%</th>
                </tr></thead>
                <tbody>
                  ${calc.gcd_individual.map(r => `
                    <tr>
                      <td>${r.id}</td>
                      <td>${r.q}</td>
                      <td><strong>${r.n_gcd}</strong></td>
                      <td>${r.e_from_gcd}</td>
                      <td style="color:${Math.abs(r.residual) < 1e-20 ? 'var(--success)' : 'var(--warning)'}">${r.residual}</td>
                      <td>${r.residual_percent}%</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>`;
        }

        document.getElementById('mc-results').innerHTML = resultsHtml;

        // ========== 绘制图表 ==========

        const scale = 1e19;

        // ===== 图像法A: q-n 散点拟合图 =====
        if (calc.gcd_individual && calc.e_estimate) {
          const ctxQN = document.getElementById('qn-fit-chart');
          if (ctxQN) {
            if (window._mcChartQN) window._mcChartQN.destroy();
            const pts = calc.gcd_individual.map(r => ({ x: r.n_gcd, y: parseFloat(r.q) * scale }));
            const maxN = Math.max(...pts.map(p => p.x), 1);
            const eSlope = calc.e_estimate * 1e19; // slope in 10⁻¹⁹ units
            const fitLine = [{ x: 0, y: 0 }, { x: maxN + 1, y: eSlope * (maxN + 1) }];

            window._mcChartQN = new Chart(ctxQN, {
              type: 'scatter',
              data: {
                datasets: [
                  {
                    type: 'line',
                    label: `拟合线 q = e·n  (e=${calc.e_estimate})`,
                    data: fitLine,
                    borderColor: '#ef4444',
                    borderDash: [6, 3],
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false
                  },
                  {
                    type: 'scatter',
                    label: '实测电荷',
                    data: pts,
                    backgroundColor: '#4f6ef7',
                    borderColor: '#3d5ce5',
                    pointRadius: 7,
                    pointHoverRadius: 11
                  }
                ]
              },
              options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                  legend: { position: 'bottom' },
                  tooltip: {
                    callbacks: {
                      label: ctx => {
                        if (ctx.dataset.label === '实测电荷') {
                          const r = calc.gcd_individual[ctx.dataIndex];
                          return `q=${r.q} C  n=${r.n_gcd}  e=q/n=${r.e_from_gcd} C`;
                        }
                        return ctx.dataset.label;
                      }
                    }
                  }
                },
                scales: {
                  x: { title: { display: true, text: '量子数 n' }, ticks: { stepSize: 1 }, min: 0, max: maxN + 1.5 },
                  y: { title: { display: true, text: '电荷 (×10⁻¹⁹ C)' }, beginAtZero: true }
                }
              }
            });
          }
        }

        // ===== 图像法B: 电荷分布直方图 =====
        if (calc.gcd_individual && calc.ladder_lines) {
          const ctxHist = document.getElementById('charge-hist-chart');
          if (ctxHist) {
            if (window._mcChartHist) window._mcChartHist.destroy();
            const charges = calc.gcd_individual.map(r => parseFloat(r.q) * scale).sort((a, b) => a - b);
            const ladderQ = calc.ladder_lines.map(l => l.q_ref_raw * scale);

            // 自适应分箱
            const qMin = charges[0], qMax = charges[charges.length - 1];
            const range = qMax - qMin;
            const binWidth = Math.max(range / 12, 0.2); // 至少 0.2×10⁻¹⁹ 宽度
            const bins = [];
            const binStart = Math.floor(qMin / binWidth) * binWidth;
            const nBins = Math.ceil((qMax - binStart) / binWidth) + 1;

            for (let i = 0; i < nBins; i++) {
              const low = binStart + i * binWidth;
              const high = low + binWidth;
              const count = charges.filter(c => c >= low && c < high).length;
              bins.push({ x: (low + high) / 2, low, high, count });
            }

            window._mcChartHist = new Chart(ctxHist, {
              type: 'bar',
              data: {
                labels: bins.map(b => `${b.low.toFixed(1)}~${b.high.toFixed(1)}`),
                datasets: [{
                  label: '电荷出现频次',
                  data: bins.map(b => b.count),
                  backgroundColor: 'rgba(79,110,247,0.5)',
                  borderColor: '#4f6ef7',
                  borderWidth: 1
                }]
              },
              options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                  legend: { display: false },
                  tooltip: { callbacks: { label: ctx => `${ctx.raw} 个油滴` } }
                },
                scales: {
                  x: { title: { display: true, text: '电荷 (×10⁻¹⁹ C)' }, ticks: { maxTicksLimit: 15 } },
                  y: { title: { display: true, text: '出现次数' }, beginAtZero: true, ticks: { stepSize: 1 } }
                }
              },
              plugins: [{
                id: 'ladderLines',
                afterDraw: chart => {
                  const ctx = chart.ctx;
                  const xScale = chart.scales.x;
                  const yScale = chart.scales.y;
                  ctx.save();
                  ladderQ.forEach((lq, i) => {
                    if (lq >= qMin && lq <= qMax) {
                      const xPos = xScale.getPixelForValue(bins.find(b => lq >= b.low && lq < b.high)?.x || lq);
                      ctx.beginPath();
                      ctx.setLineDash([4, 4]);
                      ctx.strokeStyle = 'rgba(150,150,150,0.6)';
                      ctx.lineWidth = 1;
                      ctx.moveTo(chart.scales.x.left, yScale.getPixelForValue(0));
                      // vertical line at ladder position
                      const px = xScale.getPixelForValue(lq);
                      ctx.moveTo(px, yScale.getPixelForValue(0));
                      ctx.lineTo(px, yScale.getPixelForValue(Math.max(...bins.map(b => b.count), 1)));
                      ctx.stroke();
                      ctx.fillStyle = '#888';
                      ctx.font = '10px system-ui';
                      ctx.textAlign = 'center';
                      ctx.fillText(`n=${i + 1}`, px, yScale.getPixelForValue(0) - 5);
                    }
                  });
                  ctx.restore();
                }
              }]
            });
          }
        }

        // 图表1: 电荷量子化阶梯图
        if (calc.ladder_lines && calc.gcd_individual) {
          const ctx1 = document.getElementById('ladder-chart');
          if (ctx1) {
            if (window._mcChart1) window._mcChart1.destroy();

            const charges = calc.gcd_method.charges_sorted;
            const scale = 1e19;
            const indices = charges.map((_, i) => i + 1);
            const qScaled = charges.map(c => c.q_raw * scale);
            const ladderQ = calc.ladder_lines.map(l => l.q_ref_raw * scale);

            // 颜色方案
            const colors = ['#4f6ef7','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#14b8a6'];
            const datasets = [{
              type: 'scatter',
              label: '实测电荷',
              data: indices.map((x, i) => ({ x: x, y: qScaled[i] })),
              backgroundColor: qScaled.map((_, i) => colors[i % colors.length]),
              borderColor: qScaled.map((_, i) => colors[i % colors.length]),
              pointRadius: 8,
              pointHoverRadius: 12,
              order: 1
            }];

            // 为每条阶梯线添加水平虚线
            ladderQ.forEach((lq, li) => {
              datasets.push({
                type: 'line',
                label: `n=${li + 1}  (${calc.ladder_lines[li].q_ref})`,
                data: [
                  { x: 0.3, y: lq },
                  { x: indices.length + 0.7, y: lq }
                ],
                borderColor: 'rgba(150,150,150,0.5)',
                borderDash: [6, 3],
                borderWidth: 1,
                pointRadius: 0,
                fill: false,
                order: 2
              });
            });

            window._mcChart1 = new Chart(ctx1, {
              type: 'scatter',
              data: { datasets },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'nearest', intersect: true },
                plugins: {
                  legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
                  tooltip: {
                    callbacks: {
                      label: ctx => {
                        if (ctx.dataset.label === '实测电荷') {
                          const c = charges[ctx.dataIndex];
                          return `#${c.id}: q = ${c.q} C`;
                        }
                        return ctx.dataset.label;
                      }
                    }
                  }
                },
                scales: {
                  x: { title: { display: true, text: '测量序号' }, ticks: { stepSize: 1 }, min: 0.5, max: indices.length + 0.5 },
                  y: { title: { display: true, text: '电荷 (×10⁻¹⁹ C)' }, beginAtZero: false }
                }
              }
            });
          }
        }

        // 图表2: GCD 扫描残差图
        if (calc.gcd_method && calc.gcd_method.scan_results) {
          const ctx2 = document.getElementById('scan-chart');
          if (ctx2) {
            if (window._mcChart2) window._mcChart2.destroy();

            const scan = calc.gcd_method.scan_results;
            const scale = 1e19;
            const eData = scan.map(s => s.e * scale);
            const rData = scan.map(s => s.residual * 1e19);
            const bestE = calc.gcd_method.best_e;
            const bestEScaled = parseFloat(bestE) * scale;

            window._mcChart2 = new Chart(ctx2, {
              type: 'line',
              data: {
                labels: eData.map(e => e.toFixed(4)),
                datasets: [{
                  label: '残差 Σ|qᵢ − nᵢ·e|² 的平方根',
                  data: rData,
                  borderColor: '#4f6ef7',
                  backgroundColor: 'rgba(79,110,247,0.08)',
                  fill: true,
                  pointRadius: 0,
                  borderWidth: 2,
                  tension: 0.1
                }]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  legend: { position: 'bottom' },
                  annotation_line: false,
                  tooltip: {
                    callbacks: {
                      label: ctx => `e=${ctx.label}×10⁻¹⁹C  残差=${ctx.raw.toFixed(4)}×10⁻¹⁹C`
                    }
                  }
                },
                scales: {
                  x: {
                    title: { display: true, text: '候选 e (×10⁻¹⁹ C)' },
                    ticks: { maxTicksLimit: 20, autoSkip: true }
                  },
                  y: {
                    title: { display: true, text: '残差 (×10⁻¹⁹ C)' },
                    beginAtZero: true
                  }
                }
              },
              plugins: [{
                id: 'bestELine',
                afterDraw: chart => {
                  const meta = chart.getDatasetMeta(0);
                  if (!meta.data.length) return;
                  const xScale = chart.scales.x;
                  const yScale = chart.scales.y;
                  const xPos = xScale.getPixelForValue(bestEScaled);
                  const topY = yScale.top;
                  const bottomY = yScale.bottom;

                  const ctx = chart.ctx;
                  ctx.save();
                  ctx.beginPath();
                  ctx.setLineDash([4, 4]);
                  ctx.strokeStyle = '#ef4444';
                  ctx.lineWidth = 2;
                  ctx.moveTo(xPos, topY);
                  ctx.lineTo(xPos, bottomY);
                  ctx.stroke();
                  ctx.restore();

                  // 标注
                  ctx.save();
                  ctx.fillStyle = '#ef4444';
                  ctx.font = 'bold 13px system-ui';
                  ctx.textAlign = 'center';
                  ctx.fillText(`GCD 解: e=${bestEScaled.toFixed(4)}`, xPos, topY - 5);
                  ctx.restore();
                }
              }]
            });
          }
        }

      } catch (err) {
        document.getElementById('mc-results').innerHTML = `<div class="card text-center text-danger" style="padding:40px;">❌ ${err.message}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '🧮 重新 GCD 计算';
      }
    });

  } catch (err) {
    container.innerHTML = `<div class="card text-center text-danger" style="padding:40px;">❌ ${err.message}</div>`;
  }
}

// ==================== 管理员：用户管理视图 ====================
async function renderUsersView(container) {
  container.innerHTML = '<div class="loading"><div class="spinner"></div><span class="loading-text">加载用户数据...</span></div>';

  try {
    const { overview, userStats } = await api.get('/data/statistics');

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">总用户数</div><div class="stat-value">${overview.total_users}<span class="stat-unit"> 人</span></div></div>
        <div class="stat-card"><div class="stat-label">总数据量</div><div class="stat-value">${overview.total_records}<span class="stat-unit"> 条</span></div></div>
        <div class="stat-card"><div class="stat-label">全局平均运行时间</div><div class="stat-value">${overview.avg_run_time || 'N/A'}</div></div>
        <div class="stat-card"><div class="stat-label">全局平均电压</div><div class="stat-value">${overview.avg_voltage || 'N/A'}<span class="stat-unit"> V</span></div></div>
      </div>

      <div class="card">
        <div class="card-header"><h2 class="card-title">👤 用户列表</h2></div>
        <div class="table-container">
          <table>
            <thead><tr>
              <th>ID</th><th>用户名</th><th>角色</th><th>数据量</th><th>平均运行时间</th><th>平均距离</th><th>平均电压</th><th>注册时间</th>
            </tr></thead>
            <tbody>
              ${userStats.map(u => `
                <tr>
                  <td>${u.id}</td>
                  <td><strong>${u.username}</strong></td>
                  <td><span class="badge ${u.role === 'admin' ? 'badge-danger' : u.role === 'anonymous' ? 'badge-warning' : 'badge-success'}">${u.role === 'admin' ? '管理员' : u.role === 'anonymous' ? '匿名用户' : '普通用户'}</span></td>
                  <td>${u.record_count} 条</td>
                  <td>${u.avg_run_time || 'N/A'}</td>
                  <td>${u.avg_distance || 'N/A'}</td>
                  <td>${u.avg_voltage || 'N/A'} V</td>
                  <td>${u.created_at || 'N/A'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card text-center text-danger" style="padding:40px;">❌ ${err.message}</div>`;
  }
}

// ==================== 登录/注册事件处理 ====================
function bindAuthEvents() {
  // 标签切换
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      document.getElementById('login-form').style.display = target === 'login' ? 'block' : 'none';
      document.getElementById('register-form').style.display = target === 'register' ? 'block' : 'none';
    });
  });

  // 登录
  document.getElementById('login-btn').addEventListener('click', async () => {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    if (!username || !password) return Toast.warning('请输入用户名和密码');

    try {
      const btn = document.getElementById('login-btn');
      btn.disabled = true;
      btn.textContent = '登录中...';

      await Auth.login(username, password);
      Toast.success('登录成功！');
      enterApp();
    } catch (err) {
      Toast.error(err.message);
    } finally {
      const btn = document.getElementById('login-btn');
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  });

  // 回车快捷登录
  document.getElementById('login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('login-btn').click();
  });

  // 注册
  document.getElementById('register-btn').addEventListener('click', async () => {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;

    if (!username || !password || !password2) return Toast.warning('请填写所有字段');
    if (username.length < 3 || username.length > 20) return Toast.warning('用户名长度需在3-20个字符之间');
    if (password.length < 6) return Toast.warning('密码长度至少6个字符');
    if (password !== password2) return Toast.warning('两次密码输入不一致');

    try {
      const btn = document.getElementById('register-btn');
      btn.disabled = true;
      btn.textContent = '注册中...';

      await Auth.register(username, password);
      Toast.success('注册成功！');
      enterApp();
    } catch (err) {
      Toast.error(err.message);
    } finally {
      const btn = document.getElementById('register-btn');
      btn.disabled = false;
      btn.textContent = '注 册';
    }
  });

  // 匿名登录
  const handleAnonymous = async () => {
    try {
      await Auth.anonymousLogin();
      Toast.success('已进入匿名模式，数据将临时保存');
      enterApp();
    } catch (err) {
      Toast.error(err.message);
    }
  };

  document.getElementById('anonymous-btn').addEventListener('click', handleAnonymous);
  document.getElementById('anonymous-btn2').addEventListener('click', handleAnonymous);

  // 退出
  document.getElementById('logout-btn').addEventListener('click', () => {
    Auth.logout();
    Toast.info('已退出登录');
  });
}

// ==================== 进入应用 ====================
function enterApp() {
  document.getElementById('auth-page').style.display = 'none';
  document.getElementById('app-page').style.display = 'block';

  const user = Auth.getUser();
  document.getElementById('nav-user-info').innerHTML = `👤 <strong>${user.username}</strong> ${Auth.isAdmin() ? '<span class="badge badge-danger">管理员</span>' : ''}`;

  Nav.currentView = 'upload';
  Nav.render();
  Nav.loadView('upload');
}

// ==================== 初始化 ====================
function init() {
  bindAuthEvents();

  // 如果已有有效 token，自动进入应用
  if (Auth.isLoggedIn()) {
    // 验证 token 是否仍然有效
    api.get('/auth/me').then(res => {
      Auth.setUser(res.user);
      enterApp();
    }).catch(() => {
      Auth.logout();
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
