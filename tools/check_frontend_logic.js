/**
 * 第 3 轮：前端计算逻辑测试（日期边界 / 闰年 / 月末钳制 / 金额格式化 / XSS 转义）
 *
 * 用 node 的 vm 把 core.js 跑在一个最小沙箱里，只给它 localStorage / document 存根，
 * 然后直接调用纯函数做断言。不需要浏览器。
 *
 * 用法：node tools/check_frontend_logic.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'static', 'js', 'core.js'), 'utf8');

const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { querySelector: () => null },
  setTimeout,
};
vm.createContext(sandbox);
vm.runInContext(
  src +
    '\n;globalThis.__api = { periodOf, monthlyCost, nextChargeText, addMonths, addDays,' +
    ' daysBetween, fmtD, pd, today, money, esc, cycleStep, RECUR, CYCLES };',
  sandbox
);
const A = sandbox.__api;

let pass = 0;
const fails = [];
function eq(actual, expected, label) {
  if (actual === expected) {
    pass++;
  } else {
    fails.push(`${label}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function d(y, m, day) { return new Date(y, m - 1, day); }

// ---------- addMonths：月末钳制 ----------
eq(A.fmtD(A.addMonths(d(2026, 1, 31), 1, 31)), '2026-02-28', '1月31日 +1月 → 平年钳到 2/28');
eq(A.fmtD(A.addMonths(d(2024, 1, 31), 1, 31)), '2024-02-29', '1月31日 +1月 → 闰年钳到 2/29');
eq(A.fmtD(A.addMonths(d(2026, 1, 31), 3, 31)), '2026-04-30', '1月31日 +3月 → 钳到 4/30');
eq(A.fmtD(A.addMonths(d(2026, 12, 15), 1, 15)), '2027-01-15', '跨年 +1月');
eq(A.fmtD(A.addMonths(d(2026, 3, 15), -2, 15)), '2026-01-15', '负数月份 -2月');
eq(A.fmtD(A.addMonths(d(2026, 1, 31), -13, 31)), '2024-12-31', '负数跨年 -13月');

// ---------- addDays / daysBetween ----------
eq(A.fmtD(A.addDays(d(2026, 12, 25), 7)), '2027-01-01', 'addDays 跨年');
eq(A.daysBetween(d(2026, 2, 26), d(2026, 3, 1)), 3, '平年 2/26→3/1 相差 3 天');
eq(A.daysBetween(d(2024, 2, 26), d(2024, 3, 1)), 4, '闰年 2/26→3/1 相差 4 天');

// ---------- periodOf：月付 ----------
let p = A.periodOf({ cycle: 'monthly', start_date: '2026-01-31', charge_day: 31 }, d(2026, 8, 29));
eq(A.fmtD(p.s) + '~' + A.fmtD(p.e), '2026-07-31~2026-08-31', '月付本期区间（扣费日 31）');
eq(A.fmtD(p.next), '2026-08-31', '月付下次扣费');

p = A.periodOf({ cycle: 'monthly', start_date: '2026-01-31', charge_day: 31 }, d(2026, 2, 28));
eq(A.fmtD(p.e), '2026-03-31', '2 月钳制后本期结束于 3/31');

p = A.periodOf({ cycle: 'monthly', start_date: '2026-08-20', charge_day: 20 }, d(2026, 8, 29));
eq(A.fmtD(p.s) + '~' + A.fmtD(p.e), '2026-08-20~2026-09-20', '当月已扣过费的本期区间');

// ---------- periodOf：周付 / 季付 / 年付 ----------
p = A.periodOf({ cycle: 'weekly', start_date: '2026-12-25', charge_day: null }, d(2027, 1, 5));
eq(A.fmtD(p.s) + '~' + A.fmtD(p.e), '2027-01-01~2027-01-08', '周付跨年');

p = A.periodOf({ cycle: 'quarterly', start_date: '2026-01-15', charge_day: 15 }, d(2026, 8, 29));
eq(A.fmtD(p.s) + '~' + A.fmtD(p.e), '2026-07-15~2026-10-15', '季付本期区间');

p = A.periodOf({ cycle: 'yearly', start_date: '2024-02-29', charge_day: null }, d(2026, 8, 29));
eq(A.fmtD(p.s) + '~' + A.fmtD(p.e), '2026-02-28~2027-02-28', '闰年年付锚定 2/28');

// ---------- 未来开始日期 / 无开始日期 ----------
p = A.periodOf({ cycle: 'monthly', start_date: '2027-03-10', charge_day: 10 }, d(2026, 8, 29));
eq(A.fmtD(p.next), '2027-03-10', '未来开始日期：下次扣费 = 开始日');
eq(A.daysBetween(d(2026, 8, 29), p.next) > 0, true, '未来项目的剩余天数为正');

eq(A.periodOf({ cycle: 'monthly', start_date: '', charge_day: null }, d(2026, 8, 29)), null,
  '缺少开始日期时 periodOf 返回 null');
eq(A.periodOf({ cycle: 'usage', start_date: '2026-01-01', charge_day: null }, d(2026, 8, 29)), null,
  '按量项目不参与剩余价值');
eq(A.periodOf({ cycle: 'onetime', start_date: '2026-01-01', charge_day: null }, d(2026, 8, 29)), null,
  '一次性项目不参与剩余价值');

// ---------- monthlyCost ----------
eq(A.monthlyCost({ cycle: 'weekly', amount: 12 }), 52, '周付 12 → 月均 52');
eq(A.monthlyCost({ cycle: 'monthly', amount: 30 }), 30, '月付 30');
eq(Math.round(A.monthlyCost({ cycle: 'quarterly', amount: 90 })), 30, '季付 90 → 月均 30');
eq(Math.round(A.monthlyCost({ cycle: 'yearly', amount: 120 })), 10, '年付 120 → 月均 10');
eq(A.monthlyCost({ cycle: 'usage', amount: 80 }), 80, '按量 = 月均预估');
eq(A.monthlyCost({ cycle: 'onetime', amount: 999 }), 0, '一次性不计入月均');

// ---------- nextChargeText ----------
eq(A.nextChargeText({ cycle: 'usage' }, d(2026, 8, 29)), '按量', '按量显示文案');
eq(A.nextChargeText({ cycle: 'onetime', start_date: '' }, d(2026, 8, 29)), '—',
  '一次性无日期显示占位符');
eq(A.nextChargeText({ cycle: 'onetime', start_date: '2026-05-01' }, d(2026, 8, 29)), '2026-05-01',
  '一次性显示发生日期');

// ---------- 金额格式化 ----------
eq(A.money(0), '¥0.00', '金额 0');
eq(A.money(1234.5), '¥1,234.50', '金额千分位');
eq(A.money(null), '¥0.00', '金额 null 兜底');

// ---------- XSS 转义 ----------
eq(A.esc('<img src=x onerror=alert(1)>'),
  '&lt;img src=x onerror=alert(1)&gt;', 'esc 转义尖括号');
eq(A.esc(`a"b'c&d`), 'a&quot;b&#39;c&amp;d', 'esc 转义引号与 &');
eq(A.esc(null), '', 'esc 处理 null');
eq(A.esc(123), '123', 'esc 处理数字');

// ---------- 周期推进步长 ----------
eq([A.cycleStep({ cycle: 'monthly' }), A.cycleStep({ cycle: 'quarterly' }),
  A.cycleStep({ cycle: 'yearly' })].join(','), '1,3,12', 'cycleStep 步长');

// =====================================================================
// 渲染层：老项目（起始日距今很多年）会不会被循环上限截断
// =====================================================================
const rsrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'render.js'), 'utf8');
const els = new Map();
const mkEl = () => {
  const handlers = {};
  return {
    innerHTML: '', textContent: '', value: '', style: {}, hidden: false, dataset: {},
    disabled: false, checked: false, indeterminate: false, files: null,
    _h: handlers,
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener() {},
    querySelectorAll: () => [], querySelector: () => mkEl(), closest: () => null,
    focus() {}, click() {}, appendChild() {}, remove() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    parentElement: { classList: { toggle() {} } },
  };
};
const domHandlers = {};
const sb = {
  console, setTimeout,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    __handlers: domHandlers,
    addEventListener: (type, fn) => { (domHandlers[type] = domHandlers[type] || []).push(fn); },
    querySelector: (s) => { if (!els.has(s)) els.set(s, mkEl()); return els.get(s); },
    querySelectorAll: () => [],
    getElementById: (id) => { if (!els.has('#' + id)) els.set('#' + id, mkEl()); return els.get('#' + id); },
    createElement: () => mkEl(),
    activeElement: null,
  },
};
vm.createContext(sb);
vm.runInContext(
  src + '\n' + rsrc +
    '\n;globalThis.__api2 = { setItems: (x) => { ITEMS = x; },'
    + ' setKpiUnit: (k, v) => { state[k] = v; },'
    + ' renderTrend, renderValueRelation, renderKpis, renderItems };',
  sb
);
const R = sb.__api2;

function cumulativeOfTrend(items) {
  R.setItems(items);
  els.clear();
  R.renderTrend();
  const html = els.get('#catsBody').innerHTML || '';
  const cums = [...html.matchAll(/hb-cum num">([^<]+)</g)].map((m) => m[1]);
  return cums.length ? cums[cums.length - 1] : null;
}

function remainingValueOf(items) {
  R.setItems(items);
  els.clear();
  R.renderValueRelation();
  const html = els.get('#valueBody').innerHTML || '';
  const m = html.match(/hb-amt num">([^<]+)</);
  return m ? m[1] : null;
}

const weeklyOld = [{ id: 1, name: '老周付', type: 'expense', category: 'game', amount: 10,
  cycle: 'weekly', charge_day: null, start_date: '2005-01-01', active: 1, note: '' }];
const weeklyNew = [{ id: 2, name: '新周付', type: 'expense', category: 'game', amount: 10,
  cycle: 'weekly', charge_day: null, start_date: '2026-07-01', active: 1, note: '' }];
const monthlyOld = [{ id: 3, name: '老月付', type: 'expense', category: 'ai', amount: 100,
  cycle: 'monthly', charge_day: 1, start_date: '2005-01-01', active: 1, note: '' }];

const cumOld = cumulativeOfTrend(weeklyOld);
const cumNew = cumulativeOfTrend(weeklyNew);
console.log(`\n[趋势图] 2005 年起的周付项目近 12 月累计 = ${cumOld}`);
console.log(`[趋势图] 2026 年起的周付项目近 12 月累计 = ${cumNew}`);
eq(cumOld !== '0' && cumOld !== null, true, '老周付项目（2005 年起）趋势图不能算成 0');

const cumMonthlyOld = cumulativeOfTrend(monthlyOld);
console.log(`[趋势图] 2005 年起的月付项目近 12 月累计 = ${cumMonthlyOld}`);
eq(cumMonthlyOld !== '0' && cumMonthlyOld !== null, true, '老月付项目（2005 年起）趋势图不能算成 0');

const rvOld = remainingValueOf(weeklyOld);
console.log(`[剩余价值] 2005 年起的周付项目 = ${rvOld}`);
eq(rvOld !== '¥0' && rvOld !== null, true, '老周付项目的剩余价值不能算成 0');

// ---------- KPI 卡片：按量预估 + 口径下拉 ----------
const kpiItems = [
  { id: 11, name: '月付A', type: 'expense', category: 'ai', amount: 100,
    cycle: 'monthly', charge_day: 1, start_date: '2026-01-01', active: 1, note: '' },
  { id: 12, name: '按量A', type: 'expense', category: 'api', amount: 80,
    cycle: 'usage', charge_day: null, start_date: '2026-01-01', active: 1, note: '' },
  { id: 13, name: '按量B', type: 'expense', category: 'utilities', amount: 20,
    cycle: 'usage', charge_day: null, start_date: '2026-01-01', active: 1, note: '' },
];

function kpiHtml(unit) {
  R.setItems(kpiItems);
  R.setKpiUnit('kpiUsageUnit', unit);
  els.clear();
  R.renderKpis();
  return els.get('#sec-kpi').innerHTML || '';
}

function usageValue(html) {
  // 按量卡片结构：label=按量预估，其后第一个 value
  const at = html.indexOf('按量预估');
  if (at < 0) return null;
  const m = html.slice(at).match(/class="value num ">¥([^<]+)</);
  return m ? m[1] : null;
}

const kpiMonthly = kpiHtml('monthly');
console.log(`\n[KPI] 按量预估（月均）= ${usageValue(kpiMonthly)}`);
eq(kpiMonthly.includes('按量预估'), true, 'KPI 卡片标题为「按量预估」');
eq(kpiMonthly.includes('按量月均预估'), false, '旧标题「按量月均预估」不应再出现');
eq((kpiMonthly.match(/class="kpi-sel"/g) || []).length, 3,
  '固定支出/周期订阅/按量预估 三张卡都有口径下拉');
eq(kpiMonthly.includes('data-unit="usage"'), true, '按量卡片有独立的口径下拉');
eq(usageValue(kpiMonthly), '100', '按量月均 = 80 + 20 = 100');

const kpiYearly = kpiHtml('yearly');
console.log(`[KPI] 按量预估（年均）= ${usageValue(kpiYearly)}`);
eq(usageValue(kpiYearly), '1,200', '按量年均 = 月均 × 12 = 1200');
eq(kpiYearly.includes('年度口径'), true, '切换口径后副标题同步变化');

const kpiQuarterly = kpiHtml('quarterly');
eq(usageValue(kpiQuarterly), '300', '按量季均 = 月均 × 3 = 300');

// 恢复默认口径，避免影响后续用例
R.setKpiUnit('kpiUsageUnit', 'monthly');

// =====================================================================
// 交互：点击 KPI 卡片「在管项目」应切到项目清单区块
// =====================================================================
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');
vm.runInContext(appSrc, sb);
(domHandlers['DOMContentLoaded'] || []).forEach((fn) => fn());

function clickKpiLink(href) {
  // 卡片每次渲染都会重建，事件必须委托在 #sec-kpi 容器上
  const container = sb.document.querySelector('#sec-kpi');
  const handlers = (container._h && container._h.click) || [];
  const anchor = { getAttribute: (k) => (k === 'href' ? href : null) };
  const evt = {
    target: { closest: (sel) => (sel === 'a.kpi-link' ? anchor : null) },
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
  handlers.forEach((h) => h(evt));
  return evt.prevented;
}

const displayOf = (id) => sb.document.getElementById(id).style.display;

eq((sb.document.querySelector('#sec-kpi')._h.click || []).length > 0, true,
  'KPI 容器上注册了 click 委托（不能直接绑在卡片上，重渲染会丢）');

// 未点击前：默认只显示 KPI 区块
eq(displayOf('sec-kpi'), '', '初始显示 KPI 区块');
eq(displayOf('sec-items'), 'none', '初始隐藏项目清单区块');

const prevented = clickKpiLink('#sec-items');
eq(prevented, true, '点击卡片应阻止浏览器默认锚点跳转');
eq(displayOf('sec-items'), '', '点击「在管项目」后项目清单应显示');
eq(displayOf('sec-kpi'), 'none', '点击后 KPI 区块应隐藏');

// 锚点失效时不能把整页都藏起来
clickKpiLink('#sec-nope');
eq(displayOf('sec-items'), '', '未知锚点不应改变当前区块');

// =====================================================================
// 表格：表头与数据列必须列数一致、对齐方式一致
// =====================================================================
function tableParts(items) {
  R.setItems(items);
  els.clear();
  R.renderItems();
  const html = els.get('#itemsBody').innerHTML || '';
  const thead = (html.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
  const body = (html.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0];
  const firstTr = (body.match(/<tr>[\s\S]*?<\/tr>/) || [''])[0];
  return {
    // 注意别把 <thead> 当成 <th> 匹配：th 后必须跟空白或 >
    // td 要把单元格内容一起取上：对齐样式可能挂在内层元素上（如 .td-actions）
    ths: [...thead.matchAll(/<th(?:\s([^>]*))?>/g)].map((m) => m[1] || ''),
    tds: [...firstTr.matchAll(/<td(?:\s([^>]*))?>([\s\S]*?)<\/td>/g)]
      .map((m) => (m[1] || '') + ' ' + (m[2] || '')),
  };
}

const isRightAligned = (attrs) =>
  /class="[^"]*\bnum\b/.test(attrs) ||
  /td-actions/.test(attrs) ||
  /text-align:\s*right/.test(attrs);

const tableFootOf = (items) => {
  R.setItems(items);
  els.clear();
  R.renderItems();
  return els.get('#itemsBody').innerHTML || '';
};

const parts = tableParts(kpiItems);

// 合计行的 colspan 总和必须等于列数，否则「总计」会跑偏
const tfoot = (tableFootOf(kpiItems).match(/<tfoot>[\s\S]*?<\/tfoot>/) || [''])[0];
const spanSum = [...tfoot.matchAll(/<td(?:\s([^>]*))?>/g)].reduce((acc, m) => {
  const span = (m[1] || '').match(/colspan="(\d+)"/);
  return acc + (span ? Number(span[1]) : 1);
}, 0);

console.log(`\n[表格] 表头 ${parts.ths.length} 列，数据 ${parts.tds.length} 列，合计行 ${spanSum} 格`);
eq(parts.ths.length, parts.tds.length, '表头列数与数据列数一致');
eq(parts.ths.length, 7, '项目表共 7 列');
eq(spanSum, parts.ths.length, '合计行 colspan 总和与列数一致');

const colNames = ['复选框', '项目', '分类', '金额/周期', '下次扣费', '状态', '操作'];
parts.ths.forEach((th, i) => {
  eq(isRightAligned(parts.tds[i] || ''), isRightAligned(th),
    `「${colNames[i]}」列表头与数据的对齐方式一致`);
  if (isRightAligned(parts.tds[i] || '') !== isRightAligned(th)) {
    console.log(`      th=${th.trim()} | td=${(parts.tds[i] || '').trim()}`);
  }
});

// ---------- 输出 ----------
console.log(`\n第 3 轮 · 前端计算逻辑：通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('\n发现问题：');
  fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
