/* ============================================================
 * 数字账户 · 个人财务管理  —  纯前端实现（无依赖）
 * 数据保存在浏览器 localStorage，可通过「数据管理」导入导出
 * ============================================================ */
(function () {
  'use strict';

  var LS_KEY = 'digital_account_v1';
  var THEME_KEY = 'digital_account_theme';

  /* ---------- 工具 ---------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function uid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fmt(n) {
    var v = Math.round(n * 100) / 100;
    var s = v.toLocaleString('zh-CN', { minimumFractionDigits: (v % 1 === 0 ? 0 : 2), maximumFractionDigits: 2 });
    return '¥' + s;
  }
  function ymNow() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  /* ---------- 数据 ---------- */
  var store = loadStore();
  function loadStore() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        return {
          incomes: d.incomes || [], expenses: d.expenses || [],
          subs: d.subs || [], apis: d.apis || []
        };
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return { incomes: [], expenses: [], subs: [], apis: [] };
  }
  function saveStore() {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
    updateStorageInfo();
  }
  function updateStorageInfo() {
    var bytes = (localStorage.getItem(LS_KEY) || '').length;
    $('#storageInfo').textContent = '本地存储：' + (bytes / 1024).toFixed(1) + ' KB';
  }

  /* ---------- 状态 ---------- */
  var state = { view: 'dashboard', month: ymNow() };

  // 分类：覆盖年付、会员、水电煤、生活缴费等常见场景
  var CATS = {
    income: ['工资', '奖金', '年终奖', '副业', '兼职', '投资收益', '利息', '退款', '红包', '其他'],
    expense: [
      '餐饮', '外卖', '买菜', '交通', '通讯', '水电煤', '物业费', '房租/房贷',
      '购物', '娱乐', '会员费', '医疗', '教育', '保险', '宠物', '旅行',
      '人情往来', '税务/服务费', '日用品', '其他'
    ],
    sub: [
      '视频会员', '音乐会员', '读书会员', '健身会员', '外卖/购物会员',
      '云服务', '软件工具', 'AI 服务', '域名/主机', '通讯套餐',
      '保险（年付）', '水电煤代扣', '其他'
    ],
    api: ['OpenAI', 'Anthropic', 'Claude', 'DeepSeek', 'Gemini', '阿里云', '腾讯云', '华为云', 'AWS', 'Azure', '百度智能云', '其他']
  };

  var VIEW_META = {
    dashboard: ['总览', '查看本月的收支、订阅与 API 费用概况'],
    income: ['收入项', '管理固定月薪、一次性收入与年付收入'],
    expense: ['支出项', '管理固定月支出、一次性支出与年付支出'],
    subs: ['订阅费用', '每月 / 每季 / 每年订阅，自动折算月均成本'],
    api: ['API 费用', '单独统计各 API 服务的月度开销'],
    data: ['数据管理', '备份、导入、重置与费用归类参考']
  };

  /* ============================================================
   * 计算逻辑
   * ============================================================ */
  function monthIncome(ym) {
    var sum = 0;
    store.incomes.forEach(function (r) {
      if (r.freq === 'monthly') sum += +r.amount || 0;
      else if ((r.date || '').slice(0, 7) === ym) sum += +r.amount || 0; // once / yearly
    });
    return sum;
  }
  function monthExpenseOnly(ym) {
    var sum = 0;
    store.expenses.forEach(function (r) {
      if (r.freq === 'monthly') sum += +r.amount || 0;
      else if ((r.date || '').slice(0, 7) === ym) sum += +r.amount || 0; // once / yearly
    });
    return sum;
  }
  function subsMonthly() {
    var sum = 0;
    store.subs.forEach(function (s) {
      if (!s.active) return;
      var a = +s.amount || 0;
      if (s.cycle === 'monthly') sum += a;
      else if (s.cycle === 'quarterly') sum += a / 3;
      else if (s.cycle === 'yearly') sum += a / 12;
    });
    return sum;
  }
  function apiMonth(ym) {
    var sum = 0;
    store.apis.forEach(function (a) {
      if ((a.month || '').slice(0, 7) === ym) sum += +a.amount || 0;
    });
    return sum;
  }
  function remain(ym) {
    return monthIncome(ym) - monthExpenseOnly(ym) - subsMonthly() - apiMonth(ym);
  }
  function nextRenewal(sub) {
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var day = Math.max(1, Math.min(31, +sub.day || 1));
    function dateOf(y, m) { // m: 0-based
      var last = new Date(y, m + 1, 0).getDate();
      return new Date(y, m, Math.min(day, last));
    }
    var d = dateOf(now.getFullYear(), now.getMonth());
    if (d < now) d = dateOf(now.getFullYear() + Math.floor((now.getMonth() + 1) / 12), (now.getMonth() + 1) % 12);
    return d;
  }
  function daysUntil(date) {
    var now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.round((date - now) / 86400000);
  }

  /* ============================================================
   * 视图切换
   * ============================================================ */
  function switchView(view) {
    state.view = view;
    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
    $$('.view').forEach(function (v) { v.hidden = (v.id !== 'view-' + view); });
    $('#pageTitle').textContent = VIEW_META[view][0];
    $('#pageDesc').textContent = VIEW_META[view][1];
    render();
  }

  /* ============================================================
   * 总渲染入口
   * ============================================================ */
  function render() {
    renderBadges();
    if (state.view === 'dashboard') renderDashboard();
    if (state.view === 'income') renderLedger('income');
    if (state.view === 'expense') renderLedger('expense');
    if (state.view === 'subs') renderSubs();
    if (state.view === 'api') renderApi();
  }

  function renderBadges() {
    $('#badge-income').textContent = store.incomes.length;
    $('#badge-expense').textContent = store.expenses.length;
    $('#badge-subs').textContent = store.subs.filter(function (s) { return s.active; }).length;
    $('#badge-api').textContent = store.apis.filter(function (a) { return (a.month || '').slice(0, 7) === state.month; }).length;
  }

  /* ---------- 总览 ---------- */
  function renderDashboard() {
    var ym = state.month;
    var inc = monthIncome(ym), exp = monthExpenseOnly(ym), sub = subsMonthly(), api = apiMonth(ym);
    $('#stat-income').textContent = fmt(inc);
    $('#stat-expense').textContent = fmt(exp);
    $('#stat-subs').textContent = fmt(sub);
    $('#stat-api').textContent = fmt(api);
    $('#stat-remain').textContent = fmt(remain(ym));
    $('#stat-subs-foot').textContent = store.subs.filter(function (s) { return s.active; }).length + ' 项活跃订阅（按周期折算）';
    $('#stat-api-foot').textContent = store.apis.filter(function (a) { return (a.month || '').slice(0, 7) === ym; }).length + ' 个 API 服务产生费用';

    renderChart();
    renderRenews();
    renderCatBars();
    renderFlow(inc, exp, sub, api);
  }

  function renderChart() {
    var box = $('#chart');
    box.innerHTML = '';
    var months = [];
    var d = new Date(state.month + '-01');
    for (var i = 5; i >= 0; i--) {
      var t = new Date(d.getFullYear(), d.getMonth() - i, 1);
      months.push(t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'));
    }
    var data = months.map(function (m) {
      return { m: m, inc: monthIncome(m), out: monthExpenseOnly(m) + subsMonthly() + apiMonth(m) };
    });
    var max = 1;
    data.forEach(function (x) { max = Math.max(max, x.inc, x.out); });
    data.forEach(function (x) {
      var g = document.createElement('div');
      g.className = 'chart-group';
      g.innerHTML =
        '<div class="chart-bars">' +
          '<div class="chart-bar bar-income" style="height:' + Math.max(2, x.inc / max * 100) + '%">' +
            '<span class="bar-tip">收入 ' + fmt(x.inc) + '</span></div>' +
          '<div class="chart-bar bar-expense" style="height:' + Math.max(2, x.out / max * 100) + '%">' +
            '<span class="bar-tip">支出 ' + fmt(x.out) + '</span></div>' +
        '</div>' +
        '<div class="chart-label">' + x.m.slice(2).replace('-', '/') + '</div>';
      box.appendChild(g);
    });
  }

  function renderRenews() {
    var list = $('#renewList');
    var items = store.subs.filter(function (s) { return s.active; })
      .map(function (s) { return { s: s, date: nextRenewal(s), days: 0 }; })
      .map(function (x) { x.days = daysUntil(x.date); return x; })
      .sort(function (a, b) { return a.days - b.days; })
      .slice(0, 5);
    $('#renewCount').textContent = items.length + ' 项';
    if (!items.length) {
      list.innerHTML = '<li class="empty-state"><div class="es-icon">🔖</div>' +
        '<div class="es-title">暂无活跃订阅</div><div>点击「订阅费用」页面的「+ 添加订阅」开始记录</div></li>';
      return;
    }
    list.innerHTML = items.map(function (x) {
      var chip = x.days <= 3 ? 'chip-danger' : (x.days <= 10 ? 'chip-warn' : 'chip-ok');
      return '<li class="renew-item">' +
        '<div class="renew-ico">' + esc(x.s.name).slice(0, 1) + '</div>' +
        '<div class="renew-info">' +
          '<div class="renew-name">' + esc(x.s.name) + '</div>' +
          '<div class="renew-date">' + x.date.toISOString().slice(0, 10) + ' 续订</div>' +
        '</div>' +
        '<div class="renew-amount">' + fmt(x.s.amount) + '</div>' +
        '<span class="chip ' + chip + '" style="margin-left:10px">' + (x.days === 0 ? '今天' : x.days + ' 天后') + '</span>' +
      '</li>';
    }).join('');
  }

  function renderCatBars() {
    var ym = state.month;
    var map = {};
    store.expenses.forEach(function (r) {
      var hit = (r.freq === 'monthly') || ((r.date || '').slice(0, 7) === ym);
      if (hit) map[r.category || '其他'] = (map[r.category || '其他'] || 0) + (+r.amount || 0);
    });
    var rows = Object.keys(map).map(function (k) { return [k, map[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6);
    var box = $('#catBars');
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state"><div class="es-icon">📊</div><div class="es-title">暂无支出数据</div><div>添加支出项后这里会展示分类构成</div></div>';
      return;
    }
    var max = rows[0][1] || 1;
    box.innerHTML = rows.map(function (r) {
      return '<div class="cat-row">' +
        '<span class="cat-name">' + esc(r[0]) + '</span>' +
        '<div class="cat-track"><div class="cat-fill" style="width:' + (r[1] / max * 100).toFixed(1) + '%"></div></div>' +
        '<span class="cat-amt">' + fmt(r[1]) + '</span>' +
      '</div>';
    }).join('');
  }

  function renderFlow(inc, exp, sub, api) {
    $('#flowList').innerHTML =
      flowRow('本月收入', inc, 'f-income') +
      flowRow('本月支出', -exp, 'f-expense') +
      flowRow('固定订阅（月均）', -sub, 'f-expense') +
      flowRow('API 费用', -api, 'f-expense') +
      '<li class="flow-row total"><span class="f-label">本月剩余价值</span><span class="f-val">' + fmt(inc - exp - sub - api) + '</span></li>';
  }
  function flowRow(label, val, cls) {
    var sign = val > 0 ? '+' : '';
    return '<li class="flow-row"><span class="f-label">' + label + '</span><span class="f-val ' + cls + '">' + sign + fmt(val) + '</span></li>';
  }

  /* ---------- 收入 / 支出 列表 ---------- */
  function renderLedger(type) {
    var sec = $('#view-' + type);
    var isIn = type === 'income';
    var rows = store[type === 'income' ? 'incomes' : 'expenses'];
    sec.innerHTML =
      '<div class="card table-card">' +
        '<div class="card-head"><h3>' + (isIn ? '收入明细' : '支出明细') + '</h3>' +
        '<button class="btn btn-primary" data-add="' + type + '">+ 添加' + (isIn ? '收入' : '支出') + '</button></div>' +
        '<div class="table-wrap"><table class="table"><thead><tr>' +
          '<th>名称</th><th>分类</th><th>金额</th><th>周期</th><th>日期</th><th>备注</th><th class="th-op">操作</th>' +
        '</tr></thead><tbody>' + ledgerRows(rows, isIn) + '</tbody></table></div>' +
      '</div>';
    // 事件委托已在文档级别注册，无需再绑一次
  }

  var LEDGER_FREQ_LABEL = { monthly: '每月固定', once: '一次性', yearly: '年付' };
  function ledgerRows(rows, isIn) {
    if (!rows.length) {
      return '<tr class="empty-row"><td colspan="7"><div class="empty-state"><div class="es-icon">' +
        (isIn ? '💰' : '🧾') + '</div><div class="es-title">还没有记录</div>' +
        '<div>点击右上角按钮添加第一条' + (isIn ? '收入' : '支出') + '</div></div></td></tr>';
    }
    return rows.map(function (r) {
      var showDate = r.freq === 'monthly' ? '—' : esc(r.date || '');
      return '<tr>' +
        '<td class="row-name">' + esc(r.name) + '</td>' +
        '<td><span class="freq-tag">' + esc(r.category || '其他') + '</span></td>' +
        '<td class="amt ' + (isIn ? 'amt-in' : 'amt-out') + '">' + fmt(r.amount) + '</td>' +
        '<td>' + (LEDGER_FREQ_LABEL[r.freq] || '一次性') + '</td>' +
        '<td>' + showDate + '</td>' +
        '<td class="row-note" title="' + esc(r.note || '') + '">' + esc(r.note || '—') + '</td>' +
        '<td class="th-op">' +
          '<button class="btn btn-text btn-sm" data-edit="' + (isIn ? 'income' : 'expense') + '" data-id="' + r.id + '">编辑</button>' +
          '<button class="btn btn-text btn-sm danger" data-del="' + (isIn ? 'income' : 'expense') + '" data-id="' + r.id + '">删除</button>' +
        '</td></tr>';
    }).join('');
  }

  /* ---------- 订阅列表 ---------- */
  var CYCLE_LABEL = { monthly: '每月', quarterly: '每季', yearly: '每年' };
  function renderSubs() {
    var tbody = $('#tbody-subs');
    if (!store.subs.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8"><div class="empty-state"><div class="es-icon">🔖</div>' +
        '<div class="es-title">还没有订阅记录</div><div>添加你的第一个固定订阅，系统会自动折算月均成本</div></div></td></tr>';
      return;
    }
    tbody.innerHTML = store.subs.map(function (s) {
      var monthAvg = s.cycle === 'monthly' ? s.amount : s.cycle === 'quarterly' ? s.amount / 3 : s.amount / 12;
      var date = s.active ? nextRenewal(s) : null;
      var days = date ? daysUntil(date) : null;
      var chip = !s.active ? '<span class="chip chip-off">已停用</span>'
        : days <= 3 ? '<span class="chip chip-danger">' + (days === 0 ? '今天' : days + ' 天后') + '</span>'
        : days <= 10 ? '<span class="chip chip-warn">' + days + ' 天后</span>'
        : '<span class="chip chip-ok">' + days + ' 天后</span>';
      return '<tr>' +
        '<td class="row-name">' + esc(s.name) + '</td>' +
        '<td><span class="freq-tag">' + esc(s.category || '其他') + '</span></td>' +
        '<td class="amt amt-out">' + fmt(s.amount) + ' / ' + CYCLE_LABEL[s.cycle] + '</td>' +
        '<td>' + CYCLE_LABEL[s.cycle] + '</td>' +
        '<td class="amt">' + fmt(monthAvg) + '</td>' +
        '<td>' + (date ? date.toISOString().slice(0, 10) : '—') + '</td>' +
        '<td>' + chip + '</td>' +
        '<td class="th-op">' +
          '<button class="btn btn-text btn-sm" data-edit="subs" data-id="' + s.id + '">编辑</button>' +
          '<button class="btn btn-text btn-sm danger" data-del="subs" data-id="' + s.id + '">删除</button>' +
        '</td></tr>';
    }).join('');
  }

  /* ---------- API 费用 ---------- */
  function renderApi() {
    var ym = state.month;
    var rows = store.apis.filter(function (a) { return (a.month || '').slice(0, 7) === ym; });
    var total = apiMonth(ym);
    $('#api-total').textContent = fmt(total);
    $('#api-count').textContent = rows.length;
    $('#api-daily').textContent = fmt(total / 30);
    $('#api-total-foot').textContent = ym.replace('-', ' 年 ') + ' 月（切换上方月份查看其他月份）';

    var tbody = $('#tbody-api');
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="empty-state"><div class="es-icon">🔌</div>' +
        '<div class="es-title">该月份暂无 API 费用</div><div>添加 OpenAI、云服务等 API 开销，单独核算</div></div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (a) {
      return '<tr>' +
        '<td class="row-name">' + esc(a.provider) + '</td>' +
        '<td>' + esc(a.usage || '—') + '</td>' +
        '<td>' + esc(a.month || '') + '</td>' +
        '<td class="amt amt-out">' + fmt(a.amount) + '</td>' +
        '<td class="row-note" title="' + esc(a.note || '') + '">' + esc(a.note || '—') + '</td>' +
        '<td class="th-op">' +
          '<button class="btn btn-text btn-sm" data-edit="api" data-id="' + a.id + '">编辑</button>' +
          '<button class="btn btn-text btn-sm danger" data-del="api" data-id="' + a.id + '">删除</button>' +
        '</td></tr>';
    }).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ============================================================
   * 表格事件（事件委托，全局唯一）
   * ============================================================ */
  function onTableClick(e) {
    var btn = e.target.closest('button[data-add], button[data-edit], button[data-del]');
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.add) openModal(btn.dataset.add, null);
    else if (btn.dataset.edit) openModal(btn.dataset.edit, btn.dataset.id);
    else if (btn.dataset.del) {
      var type = btn.dataset.del, id = btn.dataset.id;
      var name = findRecord(type, id);
      if (confirm('确定删除「' + (name ? name.name || name.provider : '') + '」吗？')) {
        var key = { income: 'incomes', expense: 'expenses', subs: 'subs', api: 'apis' }[type];
        store[key] = store[key].filter(function (r) { return r.id !== id; });
        saveStore(); render();
        toast('已删除');
      }
    }
  }
  function findRecord(type, id) {
    var key = { income: 'incomes', expense: 'expenses', subs: 'subs', api: 'apis' }[type];
    return store[key].filter(function (r) { return r.id === id; })[0];
  }
  document.addEventListener('click', onTableClick);

  /* ============================================================
   * 弹窗表单
   * ============================================================ */
  var LEDGER_FREQ_OPTIONS = [
    ['monthly', '每月固定'],
    ['once', '一次性'],
    ['yearly', '年付']
  ];

  function openModal(type, id) {
    var rec = id ? findRecord(type, id) : null;
    var titleEl = $('#modalTitle');
    var form = $('#modalForm');
    form.innerHTML = '';
    $('#modalMask').hidden = false;

    if (type === 'income' || type === 'expense') {
      var isIn = type === 'income';
      titleEl.textContent = (rec ? '编辑' : '添加') + (isIn ? '收入' : '支出');
      var freq = rec ? (rec.freq || 'monthly') : 'monthly';
      var dateVal = rec && (rec.freq === 'once' || rec.freq === 'yearly') ? (rec.date || todayStr()) : todayStr();
      form.innerHTML =
        field('名称', 'text', 'name', rec ? rec.name : '', '如：工资 / 房租', true) +
        selectField('分类', 'category', CATS[isIn ? 'income' : 'expense'], rec ? rec.category : '') +
        '<div class="form-grid-2">' +
          field('金额（¥）', 'number', 'amount', rec ? rec.amount : '', '0.00', true, '0', 'step="0.01"') +
          selectField('周期', 'freq', LEDGER_FREQ_OPTIONS, freq) +
        '</div>' +
        field('日期（一次性 / 年付时填写）', 'date', 'date', dateVal) +
        field('备注', 'text', 'note', rec ? rec.note : '', '选填');
      form.dataset.type = type; form.dataset.id = id || '';

      var freqSel = form.querySelector('[name="freq"]');
      var dateRow = form.querySelector('[name="date"]') ? form.querySelector('[name="date"]').closest('.form-row') : null;
      if (freqSel && dateRow) {
        var sync = function () { dateRow.style.display = (freqSel.value === 'once' || freqSel.value === 'yearly') ? '' : 'none'; };
        freqSel.addEventListener('change', sync); sync();
      }
    } else if (type === 'subs') {
      titleEl.textContent = (rec ? '编辑' : '添加') + '订阅';
      form.innerHTML =
        field('名称', 'text', 'name', rec ? rec.name : '', '如：Netflix / iCloud+', true) +
        selectField('分类', 'category', CATS.sub, rec ? rec.category : '') +
        '<div class="form-grid-2">' +
          field('金额（¥）', 'number', 'amount', rec ? rec.amount : '', '0.00', true, '0', 'step="0.01"') +
          selectField('计费周期', 'cycle', [['monthly', '每月'], ['quarterly', '每季'], ['yearly', '每年']], rec ? (rec.cycle || 'monthly') : 'monthly') +
        '</div>' +
        '<div class="form-grid-2">' +
          field('每月几号扣费', 'number', 'day', rec ? (rec.day || 1) : 1, '', true, '1', 'min="1" max="31"') +
          selectField('状态', 'active', [['1', '使用中'], ['', '已停用']], rec ? (rec.active ? '1' : '') : '1') +
        '</div>' +
        field('备注', 'text', 'note', rec ? rec.note : '', '选填');
      form.dataset.type = 'subs'; form.dataset.id = id || '';
    } else if (type === 'api') {
      titleEl.textContent = (rec ? '编辑' : '添加') + ' API 费用';
      form.innerHTML =
        field('服务商', 'text', 'provider', rec ? rec.provider : '', '如：OpenAI', true) +
        field('用途 / 模型', 'text', 'usage', rec ? rec.usage : '', '如：GPT-4o API 调用') +
        '<div class="form-grid-2">' +
          field('费用（¥）', 'number', 'amount', rec ? rec.amount : '', '0.00', true, '0', 'step="0.01"') +
          field('所属月份', 'month', 'month', rec ? rec.month : state.month, '', true) +
        '</div>' +
        field('备注', 'text', 'note', rec ? rec.note : '', '选填');
      form.dataset.type = 'api'; form.dataset.id = id || '';
    } else {
      titleEl.textContent = '添加';
      form.innerHTML = '<div class="empty-state"><div class="es-icon">⚠️</div><div class="es-title">未识别类型</div>' +
        '<div>请关闭后重试，或刷新页面</div></div>';
      console.error('Unknown modal type:', type);
    }

    var first = form.querySelector('input, select');
    if (first && first.focus) first.focus();
  }

  function field(label, type, name, value, ph, required, min, extra) {
    return '<div class="form-row"><label>' + label + (required ? ' *' : '') + '</label>' +
      '<input type="' + type + '" name="' + name + '" value="' + esc(value) + '" placeholder="' + esc(ph || '') + '"' +
      (required ? ' required' : '') + (min ? ' min="' + min + '"' : '') + ' ' + (extra || '') + '></div>';
  }
  function selectField(label, name, opts, value) {
    var optsHtml = opts.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o;
      var t = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(value) ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');
    return '<div class="form-row"><label>' + label + '</label><select name="' + name + '">' + optsHtml + '</select></div>';
  }

  function closeModal() { $('#modalMask').hidden = true; }
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalMask').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  $('#modalForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    var type = form.dataset.type, id = form.dataset.id;
    var v = {};
    $$('input, select', form).forEach(function (el) {
      if (el.name) v[el.name] = el.type === 'number' ? parseFloat(el.value || 0) : el.value.trim();
    });
    if (!v.name && !v.provider) { toast('请填写必填项'); return; }
    if (isNaN(v.amount) || v.amount < 0) { toast('金额无效'); return; }

    var key = { income: 'incomes', expense: 'expenses', subs: 'subs', api: 'apis' }[type];
    var rec;
    if (id) {
      rec = findRecord(type, id);
    } else {
      rec = { id: uid() };
      store[key].push(rec);
    }
    if (type === 'income' || type === 'expense') {
      rec.name = v.name; rec.category = v.category; rec.amount = v.amount;
      rec.freq = v.freq; rec.date = v.date; rec.note = v.note;
    } else if (type === 'subs') {
      rec.name = v.name; rec.category = v.category; rec.amount = v.amount;
      rec.cycle = v.cycle; rec.day = v.day; rec.active = v.active === '1'; rec.note = v.note;
    } else if (type === 'api') {
      rec.provider = v.provider; rec.usage = v.usage; rec.amount = v.amount;
      rec.month = v.month || state.month; rec.note = v.note;
    }
    saveStore(); closeModal(); render();
    toast(id ? '已保存修改' : '已添加');
  });

  /* ============================================================
   * 数据管理
   * ============================================================ */
  $('#btnExport').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'digital-account-backup-' + todayStr() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出备份文件');
  });

  $('#btnImport').addEventListener('click', function () { $('#fileImport').click(); });
  $('#fileImport').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result);
        if (!d || !Array.isArray(d.incomes) || !Array.isArray(d.expenses) || !Array.isArray(d.subs) || !Array.isArray(d.apis)) {
          throw new Error('格式不符');
        }
        store = { incomes: d.incomes, expenses: d.expenses, subs: d.subs, apis: d.apis };
        saveStore(); render();
        toast('导入成功');
      } catch (err) {
        alert('导入失败：文件格式不正确（需要本应用导出的 JSON 备份）');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('#btnDemo').addEventListener('click', function () {
    if (!confirm('载入示例数据将覆盖当前全部数据，确定继续吗？')) return;
    store = demoData();
    saveStore(); render();
    toast('已载入示例数据');
  });

  $('#btnReset').addEventListener('click', function () {
    if (!confirm('确定清空全部数据吗？此操作不可撤销，建议先导出备份。')) return;
    if (!confirm('再次确认：真的要清空所有记录吗？')) return;
    store = { incomes: [], expenses: [], subs: [], apis: [] };
    saveStore(); render();
    toast('已清空全部数据');
  });

  function demoData() {
    var ym = ymNow();
    return {
      incomes: [
        { id: uid(), name: '工资', category: '工资', amount: 18000, freq: 'monthly', date: '', note: '每月 10 号发薪' },
        { id: uid(), name: '副业稿费', category: '副业', amount: 2200, freq: 'monthly', date: '', note: '公众号写作' },
        { id: uid(), name: '年终奖', category: '年终奖', amount: 24000, freq: 'yearly', date: ym.slice(0, 4) + '-02-05', note: '公司年终奖' }
      ],
      expenses: [
        { id: uid(), name: '房租', category: '房租/房贷', amount: 4200, freq: 'monthly', date: '', note: '每月 1 号' },
        { id: uid(), name: '水电煤', category: '水电煤', amount: 350, freq: 'monthly', date: '', note: '夏季空调略高' },
        { id: uid(), name: '通讯套餐', category: '通讯', amount: 128, freq: 'monthly', date: '', note: '手机+宽带' },
        { id: uid(), name: '买显示器', category: '购物', amount: 1299, freq: 'once', date: ym + '-12', note: '4K 显示器' },
        { id: uid(), name: '医疗保险年付', category: '保险', amount: 2680, freq: 'yearly', date: ym + '-08-15', note: '年付商业医疗险' }
      ],
      subs: [
        { id: uid(), name: 'iCloud+ 2TB', category: '云服务', amount: 68, cycle: 'monthly', day: 8, active: true, note: '家庭共享' },
        { id: uid(), name: 'Netflix', category: '视频会员', amount: 105, cycle: 'monthly', day: 15, active: true, note: '' },
        { id: uid(), name: 'JetBrains 全家桶', category: '软件工具', amount: 1699, cycle: 'yearly', day: 3, active: true, note: '年付折算 ¥142/月' },
        { id: uid(), name: '某音乐会员', category: '音乐会员', amount: 108, cycle: 'yearly', day: 20, active: false, note: '已退订' }
      ],
      apis: [
        { id: uid(), provider: 'OpenAI', usage: 'GPT-4o 日常调用', month: ym, amount: 86.4, note: '约 6 美元' },
        { id: uid(), provider: 'DeepSeek', usage: '代码补全', month: ym, amount: 21.6, note: '' },
        { id: uid(), provider: '阿里云', usage: 'ECS + OSS', month: ym, amount: 138, note: '个人服务器' }
      ]
    };
  }

  /* ============================================================
   * 主题 & 月份 & 导航
   * ============================================================ */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('#iconMoon').style.display = theme === 'dark' ? 'none' : '';
    $('#iconSun').style.display = theme === 'dark' ? '' : 'none';
    $('#themeLabel').textContent = theme === 'dark' ? '浅色模式' : '深色模式';
  }
  var savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(savedTheme);
  $('#themeToggle').addEventListener('click', function () {
    var next = (document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  $('#monthPicker').value = state.month;
  $('#monthPicker').addEventListener('change', function (e) {
    state.month = e.target.value || ymNow();
    render();
  });

  $$('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () { switchView(b.dataset.view); });
  });

  /* ---------- 启动 ---------- */
  updateStorageInfo();
  switchView('dashboard');
})();
