'use strict';

/* =========================================================
 * 番茄钟 —— 计时 + 记录 + 日/周/月/年统计
 * 数据全部保存在 localStorage
 * ======================================================= */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const KEY = { records: 'tc.records', settings: 'tc.settings', timer: 'tc.timer' };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const DEFAULT_SETTINGS = { focus: 25, short: 5, long: 15, longEvery: 4, autoBreak: false, sound: true, notify: false };
const settings = Object.assign({}, DEFAULT_SETTINGS, load(KEY.settings, {}));

/** 记录：{ id, task, mode: 'focus'|'free', start, end, dur(秒) } */
let records = load(KEY.records, []);

const DEFAULT_TIMER = { mode: 'focus', status: 'idle', acc: 0, segStart: null, sessionStart: null, cycle: 0, task: '' };
const timer = Object.assign({}, DEFAULT_TIMER, load(KEY.timer, {}));

const MODE_NAME = { focus: '专注', short: '短休息', long: '长休息', free: '自由计时' };
const RING_LEN = 2 * Math.PI * 100;
const UNNAMED = '未命名';

const saveRecords = () => save(KEY.records, records);
const saveTimer = () => save(KEY.timer, timer);
const saveSettings = () => save(KEY.settings, settings);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------------- 格式化工具 ---------------- */
const pad = n => String(n).padStart(2, '0');

function fmtClock(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 秒 → "1小时20分" / "35分钟" */
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 100) return `${h}小时`; // 数字很大时省略分钟，避免换行
  return r ? `${h}小时${r}分` : `${h}小时`;
}

const fmtTime = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/* ---------------- 时间区间 ---------------- */
function startOf(period, date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  if (period === 'week') d.setDate(d.getDate() - (d.getDay() + 6) % 7); // 周一为一周开始
  if (period === 'month') d.setDate(1);
  if (period === 'year') d.setMonth(0, 1);
  return d;
}
function shift(period, date, n) {
  const d = new Date(date);
  if (period === 'day') d.setDate(d.getDate() + n);
  if (period === 'week') d.setDate(d.getDate() + 7 * n);
  if (period === 'month') d.setMonth(d.getMonth() + n, 1);
  if (period === 'year') d.setFullYear(d.getFullYear() + n, 0, 1);
  return d;
}
function rangeOf(period, date) {
  const a = startOf(period, date);
  return [a.getTime(), shift(period, a, 1).getTime()];
}

/** 记录实际占用的时间段：[end - dur, end]（暂停时间不计入） */
const recSpan = r => [r.end - r.dur * 1000, r.end];
/** 记录落在 [a, b) 内的秒数 */
function overlap(r, a, b) {
  const [s, e] = recSpan(r);
  return Math.max(0, Math.min(b, e) - Math.max(a, s)) / 1000;
}
function sumRange(a, b) {
  let total = 0, count = 0;
  for (const r of records) {
    const o = overlap(r, a, b);
    if (o > 0) total += o;
    const s = recSpan(r)[0];
    if (s >= a && s < b) count++;
  }
  return { total, count };
}

/* =========================================================
 * 计时器
 * ======================================================= */
const modeDurMs = mode => mode === 'free' ? 0 : settings[mode] * 60000;
const elapsed = () => timer.acc + (timer.status === 'running' ? Date.now() - timer.segStart : 0);

let ticker = null;

function start() {
  if (timer.status === 'idle') {
    timer.acc = 0;
    timer.sessionStart = Date.now();
  }
  timer.status = 'running';
  timer.segStart = Date.now();
  saveTimer();
  ensureTicker();
  unlockAudio();
  render();
}

function pause() {
  timer.acc = elapsed();
  timer.segStart = null;
  timer.status = 'paused';
  saveTimer();
  render();
}

function resetTimer(nextMode = timer.mode) {
  Object.assign(timer, { mode: nextMode, status: 'idle', acc: 0, segStart: null, sessionStart: null });
  saveTimer();
  render();
}

function currentTask() {
  return $('#task').value.trim() || UNNAMED;
}

function addRecord(mode, durSec, end) {
  const rec = { id: uid(), task: currentTask(), mode, start: timer.sessionStart || end - durSec * 1000, end, dur: Math.round(durSec) };
  records.push(rec);
  saveRecords();
  return rec;
}

/** 倒计时自然结束 */
function complete() {
  const dur = modeDurMs(timer.mode);
  const overshoot = elapsed() - dur;              // 页面关闭期间可能已超时
  const endAt = Date.now() - Math.max(0, overshoot);
  const mode = timer.mode;

  if (mode === 'focus') {
    addRecord('focus', dur / 1000, endAt);
    timer.cycle++;
    const isLong = timer.cycle % settings.longEvery === 0;
    const next = isLong ? 'long' : 'short';
    alertUser('专注完成 🍅', `「${currentTask()}」${settings.focus} 分钟，休息一下吧`);
    resetTimer(next);
    if (settings.autoBreak && overshoot < 5000) start();
  } else {
    if (mode === 'long') timer.cycle = 0;
    alertUser('休息结束', '开始下一个番茄吧');
    resetTimer('focus');
  }
}

/** 「完成」按钮：提前结束并记录 */
function finishEarly() {
  if (timer.status === 'idle') return;
  const ms = elapsed();
  if (timer.mode === 'focus' || timer.mode === 'free') {
    if (ms < 60000) {
      if (!confirm('不足 1 分钟，不会记录。确定结束吗？')) return;
      resetTimer();
      return;
    }
    addRecord(timer.mode, ms / 1000, Date.now());
    toast(`已记录 ${fmtDur(ms / 1000)}`);
    resetTimer(timer.mode === 'focus' ? 'short' : 'free');
  } else {
    if (timer.mode === 'long') timer.cycle = 0;
    resetTimer('focus'); // 跳过休息
  }
}

function discard() {
  if (timer.status === 'idle') return;
  if (elapsed() > 60000 && !confirm('放弃本次计时？已用时间不会被记录。')) return;
  resetTimer();
}

function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(tick, 250);
}

function tick() {
  if (timer.status !== 'running') { clearInterval(ticker); ticker = null; return; }
  const dur = modeDurMs(timer.mode);
  if (dur && elapsed() >= dur) { complete(); return; }
  renderClock();
}

/* ---------------- 提醒：声音 + 通知 ---------------- */
let audioCtx = null;
function unlockAudio() {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}
function beep() {
  if (!settings.sound) return;
  unlockAudio();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [0, 0.35, 0.7].forEach(off => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0 + off);
    g.gain.exponentialRampToValueAtTime(0.3, t0 + off + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.28);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + off); o.stop(t0 + off + 0.3);
  });
}
function alertUser(title, body) {
  beep();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (settings.notify && 'Notification' in window && Notification.permission === 'granted') {
    const opts = { body, icon: 'icon.svg', tag: 'tomato-clock' };
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts)).catch(() => {});
    } else {
      try { new Notification(title, opts); } catch {}
    }
  }
  toast(title);
}

let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 16px;border-radius:999px;font-size:14px;z-index:50;transition:opacity .3s;max-width:90vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2400);
}

/* ---------------- 计时页渲染 ---------------- */
function renderClock() {
  const dur = modeDurMs(timer.mode);
  const el = elapsed();
  const shown = dur ? dur - el : el;
  $('#clock').textContent = fmtClock(shown);

  const ring = $('#ring');
  ring.style.strokeDasharray = RING_LEN;
  if (dur) ring.style.strokeDashoffset = RING_LEN * Math.min(1, el / dur);
  else ring.style.strokeDashoffset = RING_LEN * (1 - (el % 3600000) / 3600000); // 自由计时：每小时绕一圈

  document.title = timer.status === 'idle' ? '番茄钟' : `${fmtClock(shown)} · ${MODE_NAME[timer.mode]}`;
}

function renderTimer() {
  document.body.dataset.mode = timer.mode;
  const busy = timer.status !== 'idle';
  $$('.mode').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === timer.mode);
    b.disabled = busy && b.dataset.mode !== timer.mode;
  });

  const main = $('#btn-main');
  main.textContent = timer.status === 'running' ? '暂停' : timer.status === 'paused' ? '继续' : '开始';
  $('#btn-reset').disabled = !busy;
  $('#btn-finish').disabled = !busy;
  $('#btn-finish').textContent = (timer.mode === 'short' || timer.mode === 'long') ? '跳过' : '完成';

  const isBreak = timer.mode === 'short' || timer.mode === 'long';
  const statusText = {
    idle: isBreak ? '休息一下' : '准备开始',
    running: isBreak ? '休息中…' : (($('#task').value.trim()) || '专注中…'),
    paused: '已暂停',
  }[timer.status];
  $('#status').textContent = statusText;

  // 今日
  const [a, b] = rangeOf('day', new Date());
  const today = sumRange(a, b);
  $('#today-total').textContent = fmtDur(today.total);
  $('#today-count').textContent = records.filter(r => r.mode === 'focus' && recSpan(r)[0] >= a && recSpan(r)[0] < b).length;
  $('#cycle').textContent = `${timer.cycle % settings.longEvery} / ${settings.longEvery}`;

  renderRecent();
  renderClock();
}

function recentTasks(limit = 8) {
  const seen = new Set(), out = [];
  for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
    const t = records[i].task;
    if (t && t !== UNNAMED && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

function renderRecent() {
  const cur = $('#task').value.trim();
  const box = $('#recent');
  box.innerHTML = '';
  for (const t of recentTasks()) {
    const c = document.createElement('button');
    c.className = 'chip' + (t === cur ? ' on' : '');
    c.textContent = t;
    c.onclick = () => { $('#task').value = t; timer.task = t; saveTimer(); renderTimer(); };
    box.appendChild(c);
  }
}

/* =========================================================
 * 统计
 * ======================================================= */
const stats = { period: 'day', anchor: new Date() };

function periodLabel(period, d) {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  const now = new Date();
  const same = startOf(period, d).getTime() === startOf(period, now).getTime();
  if (period === 'day') {
    const tag = same ? '今天' : startOf('day', shift('day', now, -1)).getTime() === startOf('day', d).getTime() ? '昨天' : `周${WEEK[d.getDay()]}`;
    return `${y}年${m}月${d.getDate()}日 · ${tag}`;
  }
  if (period === 'week') {
    const a = startOf('week', d), b = shift('day', a, 6);
    return `${a.getMonth() + 1}月${a.getDate()}日 – ${b.getMonth() + 1}月${b.getDate()}日${same ? ' · 本周' : ''}`;
  }
  if (period === 'month') return `${y}年${m}月${same ? ' · 本月' : ''}`;
  return `${y}年${same ? ' · 今年' : ''}`;
}

/** 生成图表分桶：[{ a, b, label, tip }] */
function buckets(period, d) {
  const out = [];
  const a0 = startOf(period, d);
  if (period === 'day') {
    for (let h = 0; h < 24; h++) {
      const a = new Date(a0); a.setHours(h);
      const b = new Date(a0); b.setHours(h + 1);
      out.push({ a: +a, b: +b, label: h % 6 === 0 ? String(h) : '', tip: `${h}:00–${h + 1}:00` });
    }
  } else if (period === 'week' || period === 'month') {
    const n = period === 'week' ? 7 : new Date(a0.getFullYear(), a0.getMonth() + 1, 0).getDate();
    for (let i = 0; i < n; i++) {
      const a = shift('day', a0, i), b = shift('day', a0, i + 1);
      const label = period === 'week' ? WEEK[a.getDay()]
        : (i === 0 || (i + 1) % 5 === 0) ? String(i + 1) : '';
      out.push({ a: +a, b: +b, label, tip: `${a.getMonth() + 1}月${a.getDate()}日 周${WEEK[a.getDay()]}`, drill: { period: 'day', date: a } });
    }
  } else {
    for (let i = 0; i < 12; i++) {
      const a = new Date(a0.getFullYear(), i, 1), b = new Date(a0.getFullYear(), i + 1, 1);
      out.push({ a: +a, b: +b, label: `${i + 1}月`, tip: `${a0.getFullYear()}年${i + 1}月`, drill: { period: 'month', date: a } });
    }
  }
  return out;
}

function niceMax(minutes) {
  const steps = [10, 15, 30, 60, 90, 120, 180, 240, 300, 360, 480, 600, 900, 1200, 1800, 2400, 3000, 3600, 4800, 6000, 9000, 12000];
  return steps.find(s => s >= minutes) || Math.ceil(minutes / 6000) * 6000;
}
const fmtAxisMin = m => m === 0 ? '0' : m >= 60 ? `${+(m / 60).toFixed(1)}h` : `${m}m`;

function renderChart(bks) {
  const svg = $('#chart');
  const W = svg.clientWidth || 320, H = 180;
  const padL = 34, padB = 20, padT = 8, padR = 4;
  const cw = W - padL - padR, ch = H - padT - padB;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const mins = bks.map(k => k.val / 60);
  const max = niceMax(Math.max(...mins, 1));
  const now = Date.now();

  let html = '';
  [0, 0.5, 1].forEach(f => {
    const y = padT + ch * (1 - f);
    html += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
    html += `<text class="axis" x="${padL - 6}" y="${y + 3}" text-anchor="end">${fmtAxisMin(Math.round(max * f))}</text>`;
  });

  const slot = cw / bks.length;
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  bks.forEach((k, i) => {
    const cx = padL + slot * i + slot / 2;
    const h = mins[i] ? Math.max(2, ch * mins[i] / max) : 0;
    const x = cx - bw / 2, y = padT + ch - h;
    const r = Math.min(4, bw / 2, h);
    html += `<rect class="hit" data-i="${i}" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${ch}"/>`;
    if (h > 0) {
      html += `<path class="bar${k.a > now ? ' dim' : ''}" data-i="${i}" d="M${x},${y + h}V${y + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${y + h}Z"/>`;
    }
    if (k.label) html += `<text class="axis" x="${cx}" y="${H - 5}" text-anchor="middle">${k.label}</text>`;
  });
  svg.innerHTML = html;

  const tip = $('#tip');
  const show = e => {
    const i = e.target.dataset.i;
    if (i == null) return;
    const k = bks[i];
    tip.textContent = `${k.tip} · ${fmtDur(k.val)}`;
    const cx = padL + slot * i + slot / 2;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    const left = Math.min(Math.max(cx * scale, 60), rect.width - 60);
    tip.style.left = `${left}px`;
    tip.style.top = `${(padT + ch - (mins[i] ? Math.max(2, ch * mins[i] / max) : 0)) * scale - 6}px`;
    tip.hidden = false;
  };
  svg.onpointermove = show;
  svg.onpointerdown = show;
  svg.onpointerleave = () => { tip.hidden = true; };
  svg.onclick = e => {
    const i = e.target.dataset.i;
    if (i == null || !bks[i].drill) return;
    stats.period = bks[i].drill.period;
    stats.anchor = bks[i].drill.date;
    tip.hidden = true;
    renderStats();
  };
}

function renderStats() {
  const now = new Date();
  for (const p of ['day', 'week', 'month', 'year']) {
    const [a, b] = rangeOf(p, now);
    $(`#sum-${p}`).textContent = fmtDur(sumRange(a, b).total);
  }

  const { period, anchor } = stats;
  $$('#period button').forEach(b => b.classList.toggle('active', b.dataset.p === period));
  $('#period-label').textContent = periodLabel(period, anchor);
  const [a, b] = rangeOf(period, anchor);
  $('#next').disabled = a > now.getTime();

  const { total, count } = sumRange(a, b);
  $('#p-total').textContent = fmtDur(total);
  $('#p-count').textContent = count;
  if (period === 'day') {
    $('#p-avg-label').textContent = '平均每次';
    $('#p-avg').textContent = count ? fmtDur(total / count) : '—';
  } else {
    const end = Math.min(b, startOf('day', now).getTime() + 86400000);
    const days = Math.max(1, Math.round((end - a) / 86400000));
    $('#p-avg-label').textContent = '日均';
    $('#p-avg').textContent = end > a ? fmtDur(total / days) : '—';
  }

  const bks = buckets(period, anchor);
  for (const k of bks) k.val = records.reduce((s, r) => s + overlap(r, k.a, k.b), 0);
  renderChart(bks);

  // 按事项汇总
  const map = new Map();
  for (const r of records) {
    const o = overlap(r, a, b);
    if (o <= 0) continue;
    const it = map.get(r.task) || { task: r.task, sec: 0, n: 0 };
    it.sec += o; it.n++;
    map.set(r.task, it);
  }
  const list = [...map.values()].sort((x, y) => y.sec - x.sec);
  const box = $('#by-task');
  if (!list.length) { box.innerHTML = '<div class="empty">这段时间还没有记录</div>'; return; }
  const top = list[0].sec;
  box.innerHTML = list.map(it => `
    <div class="row">
      <span class="name">${esc(it.task)}</span>
      <span class="val">${fmtDur(it.sec)} · ${it.n}次 · ${Math.round(it.sec / total * 100)}%</span>
      <div class="meter"><i style="width:${(it.sec / top * 100).toFixed(1)}%"></i></div>
    </div>`).join('');
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* =========================================================
 * 记录列表
 * ======================================================= */
let historyDays = 14;

function renderHistory() {
  const box = $('#history');
  if (!records.length) {
    box.innerHTML = '<div class="empty">还没有记录。完成一个番茄，或点击「补录」手动添加。</div>';
    return;
  }
  const sorted = [...records].sort((x, y) => y.end - x.end);
  const groups = new Map();
  for (const r of sorted) {
    const k = startOf('day', recSpan(r)[0]).getTime();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()];
  let html = '';
  for (const k of keys.slice(0, historyDays)) {
    const list = groups.get(k);
    const d = new Date(k);
    const tot = list.reduce((s, r) => s + r.dur, 0);
    html += `<div class="day-group"><div class="day-title"><span>${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}</span><span>${fmtDur(tot)}</span></div>`;
    for (const r of list) {
      const [s] = recSpan(r);
      html += `<div class="rec">
        <div><div class="t">${esc(r.task)}${r.mode === 'free' ? '<span class="tag">自由</span>' : ''}</div>
        <div class="meta">${fmtTime(s)} – ${fmtTime(r.end)}</div></div>
        <span class="d">${fmtDur(r.dur)}</span>
        <button class="more" data-id="${r.id}" aria-label="编辑">⋯</button>
      </div>`;
    }
    html += '</div>';
  }
  if (keys.length > historyDays) html += '<button id="load-more" class="btn small load-more">加载更多</button>';
  box.innerHTML = html;
  box.querySelectorAll('.more').forEach(b => b.onclick = () => openDialog(records.find(r => r.id === b.dataset.id)));
  const more = $('#load-more');
  if (more) more.onclick = () => { historyDays += 14; renderHistory(); };
}

/* ---------------- 补录 / 编辑 ---------------- */
let editing = null;
const toLocalInput = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function openDialog(rec) {
  editing = rec || null;
  $('#dlg-title').textContent = rec ? '编辑记录' : '补录';
  $('#d-del').hidden = !rec;
  $('#d-task').value = rec ? rec.task : ($('#task').value.trim() || '');
  const defStart = rec ? recSpan(rec)[0] : Date.now() - settings.focus * 60000;
  $('#d-start').value = toLocalInput(defStart);
  $('#d-min').value = rec ? Math.round(rec.dur / 60) : settings.focus;
  $('#dlg').showModal();
}

$('#dlg').addEventListener('close', () => {
  const v = $('#dlg').returnValue;
  if (v === 'delete' && editing) {
    if (confirm(`删除「${editing.task}」这条记录？`)) {
      records = records.filter(r => r.id !== editing.id);
      saveRecords();
    }
  } else if (v === 'ok') {
    const task = $('#d-task').value.trim() || UNNAMED;
    const start = new Date($('#d-start').value).getTime();
    const min = Math.max(1, Math.min(1440, parseInt($('#d-min').value, 10) || 0));
    if (!Number.isFinite(start)) return;
    const dur = min * 60, end = start + dur * 1000;
    if (editing) Object.assign(editing, { task, start, end, dur });
    else records.push({ id: uid(), task, mode: 'free', start, end, dur });
    saveRecords();
  }
  editing = null;
  render();
});

/* =========================================================
 * 设置 & 数据
 * ======================================================= */
function renderSettings() {
  $('#s-focus').value = settings.focus;
  $('#s-short').value = settings.short;
  $('#s-long').value = settings.long;
  $('#s-every').value = settings.longEvery;
  $('#s-auto').checked = settings.autoBreak;
  $('#s-sound').checked = settings.sound;
  $('#s-notify').checked = settings.notify;
}

function bindNum(id, key, min, max) {
  $(id).addEventListener('change', e => {
    const v = Math.max(min, Math.min(max, parseInt(e.target.value, 10) || DEFAULT_SETTINGS[key]));
    settings[key] = v;
    e.target.value = v;
    saveSettings();
    render();
  });
}
bindNum('#s-focus', 'focus', 1, 180);
bindNum('#s-short', 'short', 1, 60);
bindNum('#s-long', 'long', 1, 90);
bindNum('#s-every', 'longEvery', 1, 12);
$('#s-auto').onchange = e => { settings.autoBreak = e.target.checked; saveSettings(); };
$('#s-sound').onchange = e => { settings.sound = e.target.checked; saveSettings(); if (settings.sound) beep(); };
$('#s-notify').onchange = async e => {
  if (e.target.checked) {
    if (!('Notification' in window)) { toast('当前浏览器不支持通知'); e.target.checked = false; return; }
    const p = await Notification.requestPermission();
    if (p !== 'granted') { toast('未获得通知权限'); e.target.checked = false; return; }
  }
  settings.notify = e.target.checked;
  saveSettings();
};

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };

$('#btn-export').onclick = () => {
  download(`tomato-clock-${stamp()}.json`, JSON.stringify({ app: 'tomato-clock', version: 1, settings, records }, null, 2), 'application/json');
};
$('#btn-csv').onclick = () => {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const fmt = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const rows = [['事项', '开始', '结束', '时长(分钟)', '类型']];
  for (const r of [...records].sort((x, y) => x.end - y.end)) {
    rows.push([q(r.task), fmt(recSpan(r)[0]), fmt(r.end), (r.dur / 60).toFixed(1), r.mode === 'focus' ? '番茄' : '自由']);
  }
  download(`tomato-clock-${stamp()}.csv`, '﻿' + rows.map(r => r.join(',')).join('\n'), 'text/csv');
};
$('#file-import').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(list)) throw new Error('bad');
    const ids = new Set(records.map(r => r.id));
    let added = 0;
    for (const r of list) {
      if (!r || typeof r.end !== 'number' || typeof r.dur !== 'number') continue;
      if (r.id && ids.has(r.id)) continue;
      records.push({ id: r.id || uid(), task: String(r.task || UNNAMED), mode: r.mode === 'focus' ? 'focus' : 'free', start: r.start || r.end - r.dur * 1000, end: r.end, dur: r.dur });
      added++;
    }
    saveRecords();
    render();
    toast(`已导入 ${added} 条记录`);
  } catch {
    toast('导入失败：文件格式不正确');
  }
};
$('#btn-clear').onclick = () => {
  if (!records.length) return;
  if (!confirm(`确定清空全部 ${records.length} 条记录？此操作无法撤销，建议先导出备份。`)) return;
  records = [];
  saveRecords();
  render();
};

/* =========================================================
 * 事件绑定 & 启动
 * ======================================================= */
$$('.mode').forEach(b => b.onclick = () => { if (timer.status === 'idle') resetTimer(b.dataset.mode); });
$('#btn-main').onclick = () => timer.status === 'running' ? pause() : start();
$('#btn-finish').onclick = finishEarly;
$('#btn-reset').onclick = discard;
$('#task').addEventListener('input', () => { timer.task = $('#task').value; saveTimer(); renderRecent(); if (timer.status === 'running') renderTimer(); });
$('#task').addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); if (timer.status === 'idle') start(); } });

let currentView = 'timer';
$$('.tabbar button').forEach(b => b.onclick = () => {
  currentView = b.dataset.view;
  $$('.tabbar button').forEach(x => x.classList.toggle('active', x === b));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${currentView}`));
  if (currentView === 'stats') stats.anchor = stats.anchor || new Date();
  render();
});

$$('#period button').forEach(b => b.onclick = () => { stats.period = b.dataset.p; stats.anchor = new Date(); renderStats(); });
$('#prev').onclick = () => { stats.anchor = shift(stats.period, startOf(stats.period, stats.anchor), -1); renderStats(); };
$('#next').onclick = () => { stats.anchor = shift(stats.period, startOf(stats.period, stats.anchor), 1); renderStats(); };
$('#period-label').onclick = () => { stats.anchor = new Date(); renderStats(); };
$('#btn-add').onclick = () => openDialog(null);

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && currentView === 'timer' && document.activeElement.tagName !== 'INPUT' && !$('#dlg').open) {
    e.preventDefault();
    $('#btn-main').click();
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); render(); } });
window.addEventListener('resize', () => { if (currentView === 'stats') renderStats(); });
// 其他标签页修改了数据时同步
window.addEventListener('storage', e => {
  if (e.key === KEY.records) records = load(KEY.records, []);
  if (e.key === KEY.timer) Object.assign(timer, load(KEY.timer, {}));
  if (timer.status === 'running') ensureTicker();
  render();
});

function render() {
  if (currentView === 'timer') renderTimer();
  if (currentView === 'stats') renderStats();
  if (currentView === 'history') renderHistory();
  if (currentView === 'settings') renderSettings();
}

$('#task').value = timer.task || '';
render();
if (timer.status === 'running') { ensureTicker(); tick(); }

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
