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

const DEFAULT_SETTINGS = { focus: 25, short: 5, long: 15, longEvery: 4, goal: 120, autoBreak: false, sound: true, notify: false, keepAwake: true };
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
  wakeFailed = false;
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

/* ---------------- 屏幕常亮 ----------------
 * 手机锁屏或切到后台后，网页会被系统暂停，到点无法响铃。
 * 计时进行中保持屏幕常亮，页面就一直在运行，提醒才能准时。
 * 页面被隐藏时浏览器会自动释放常亮，回到页面时重新申请。 */
const wakeSupported = 'wakeLock' in navigator;
let wakeLock = null, wakeBusy = false, wakeFailed = false;

const wantWake = () => settings.keepAwake && wakeSupported && timer.status === 'running' && !document.hidden;

async function syncWakeLock() {
  if (wakeBusy) return;
  wakeBusy = true;
  try {
    if (wantWake() && !wakeLock && !wakeFailed) {
      try {
        const lock = await navigator.wakeLock.request('screen');
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; renderWakeHint(); });
      } catch {
        wakeFailed = true; // 例如省电模式下被拒绝；下次开始计时再试
      }
    } else if (!wantWake() && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      try { await lock.release(); } catch {}
    }
  } finally {
    wakeBusy = false;
  }
  // 等待期间状态可能变了，再对齐一次
  if (wantWake() !== !!wakeLock && !(wantWake() && wakeFailed)) syncWakeLock();
  renderWakeHint();
}

function renderWakeHint() {
  const el = $('#wake-hint');
  if (timer.status !== 'running') { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = wakeLock
    ? '🔆 屏幕保持常亮中 · 请不要锁屏，到点才能准时提醒'
    : '提示：锁屏或切到其他 App 后，到点不会提醒（回来时会自动补上记录）';
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

  const goalSec = settings.goal * 60;
  $('#goal-meter').hidden = !goalSec;
  if (goalSec) {
    const pct = Math.min(100, today.total / goalSec * 100);
    $('#goal-text').textContent = `${fmtDur(today.total)} / ${fmtDur(goalSec)}${today.total >= goalSec ? ' · 已达成 🎉' : ` · ${Math.floor(pct)}%`}`;
    $('#goal-fill').style.width = `${pct}%`;
  }

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
const stats = { period: 'day', anchor: new Date(), table: false };
const PREV_WORD = { day: '昨日', week: '上周', month: '上月', year: '去年' };
const SLOTS = 7;                 // 事项颜色数量，其余归入「其他」
const DAY_MS = 86400000;
const GAP = 2;                   // 堆叠段之间的留白

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = ts => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`; };

/** 与 shift 类似，但保留日内时间（用于「同期」对比） */
function shiftKeep(period, date, n) {
  const d = new Date(date);
  if (period === 'day') d.setDate(d.getDate() + n);
  else if (period === 'week') d.setDate(d.getDate() + 7 * n);
  else {
    const day = d.getDate();
    d.setDate(1);
    if (period === 'month') d.setMonth(d.getMonth() + n); else d.setFullYear(d.getFullYear() + n);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return d;
}

/* ---------------- 聚合 ---------------- */

/** 每天的累计秒数：Map<当天0点时间戳, 秒>，跨天的记录会被拆开 */
function dayTotals() {
  const map = new Map();
  for (const r of records) {
    let [s, e] = recSpan(r);
    while (s < e) {
      const d0 = startOf('day', s);
      const next = shift('day', d0, 1).getTime();
      const t = Math.min(e, next);
      map.set(d0.getTime(), (map.get(d0.getTime()) || 0) + (t - s) / 1000);
      s = t;
    }
  }
  return map;
}

/** [a, b) 内按「一天中的小时」汇总 */
function hourDist(list, a, b) {
  const h = new Array(24).fill(0);
  for (const r of list) {
    let [s, e] = recSpan(r);
    s = Math.max(s, a); e = Math.min(e, b);
    while (s < e) {
      const d = new Date(s);
      const next = new Date(d); next.setMinutes(60, 0, 0);
      const t = Math.min(e, next.getTime());
      h[d.getHours()] += (t - s) / 1000;
      s = t;
    }
  }
  return h;
}

/** 连续打卡：当前连续天数（今天还没记录也不算断）和历史最长 */
function streaks(dt) {
  const active = new Set([...dt].filter(([, v]) => v >= 60).map(([k]) => k));
  const today = startOf('day', new Date());
  let d = active.has(today.getTime()) ? today : shift('day', today, -1);
  let cur = 0;
  while (active.has(d.getTime())) { cur++; d = shift('day', d, -1); }
  let best = 0;
  for (const k of active) {
    if (active.has(shift('day', k, -1).getTime())) continue; // 不是一段的开头
    let n = 0, x = new Date(k);
    while (active.has(x.getTime())) { n++; x = shift('day', x, 1); }
    best = Math.max(best, n);
  }
  return { cur, best };
}

/** 事项颜色：按全部记录的累计时长排名，前 7 名各占一个固定颜色，其余为「其他」。
 *  颜色跟随事项本身，不随当前查看的时间段变化。 */
let taskSlot = new Map();
function computeTaskSlots() {
  const tot = new Map();
  for (const r of records) tot.set(r.task, (tot.get(r.task) || 0) + r.dur);
  taskSlot = new Map([...tot].sort((x, y) => y[1] - x[1]).slice(0, SLOTS).map(([t], i) => [t, i]));
}
const slotOf = task => taskSlot.has(task) ? taskSlot.get(task) : SLOTS;
const slotColor = i => i < SLOTS ? `var(--c${i + 1})` : 'var(--c-other)';
const slotName = i => { const hit = [...taskSlot].find(([, v]) => v === i); return hit ? hit[0] : '其他'; };

/* ---------------- 通用：柱状图（支持堆叠） ---------------- */
function niceMax(minutes) {
  const steps = [10, 15, 30, 60, 90, 120, 180, 240, 300, 360, 480, 600, 900, 1200, 1800, 2400, 3000, 3600, 4800, 6000, 9000, 12000];
  return steps.find(s => s >= minutes) || Math.ceil(minutes / 6000) * 6000;
}
const fmtAxisMin = m => m === 0 ? '0' : m >= 60 ? `${+(m / 60).toFixed(1)}h` : `${m}m`;
const topRounded = (x, y, w, h, r) => r > 0
  ? `M${x},${y + h}V${y + r}q0,-${r} ${r},-${r}h${w - 2 * r}q${r},0 ${r},${r}V${y + h}Z`
  : `M${x},${y}h${w}v${h}h-${w}Z`;

/** 把 tooltip 放到 svg 坐标 (x, y) 的上方 */
function placeTip(svg, tip, html, x, y, W) {
  tip.innerHTML = html;
  tip.hidden = false;
  const rect = svg.getBoundingClientRect();
  const k = rect.width / W;
  const half = tip.offsetWidth / 2 + 4;
  tip.style.left = `${Math.min(Math.max(x * k, half), rect.width - half)}px`;
  tip.style.top = `${Math.max(y * k - 6, tip.offsetHeight)}px`;
}

function bindHover(svg, tip, onShow, onPick) {
  const clear = () => { tip.hidden = true; svg.classList.remove('hovering'); svg.querySelectorAll('.on').forEach(n => n.classList.remove('on')); };
  const show = e => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i == null) { clear(); return; }
    svg.classList.add('hovering');
    svg.querySelectorAll('.on').forEach(n => n.classList.remove('on'));
    svg.querySelectorAll(`[data-g="${i}"]`).forEach(n => n.classList.add('on'));
    onShow(+i);
  };
  svg.onpointermove = show;
  svg.onpointerdown = show;
  svg.onpointerleave = clear;
  svg.onclick = e => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i != null && onPick) { clear(); onPick(+i); }
  };
}

/**
 * items: [{ label, tip, segs: [{ color, val(秒), name }] }]
 * opts: { height, goal(秒), onPick(i) }
 */
function drawBars(svg, items, { height = 180, goal = 0, onPick } = {}) {
  const tip = svg.nextElementSibling;
  const W = svg.clientWidth || 320, H = height;
  const padL = 34, padB = 20, padT = goal ? 16 : 8, padR = 4;
  const cw = W - padL - padR, ch = H - padT - padB;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = `${H}px`;

  const totals = items.map(it => it.segs.reduce((s, x) => s + x.val, 0));
  const max = niceMax(Math.max(...totals.map(t => t / 60), goal / 60, 1));
  const yOf = sec => padT + ch * (1 - sec / 60 / max);

  let html = '';
  [0, 0.5, 1].forEach(f => {
    const y = padT + ch * (1 - f);
    html += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
    html += `<text class="axis" x="${padL - 6}" y="${y + 3}" text-anchor="end">${fmtAxisMin(Math.round(max * f))}</text>`;
  });

  const slot = cw / items.length;
  const bw = Math.max(2, Math.min(24, slot * 0.62));
  const tops = [];
  items.forEach((it, i) => {
    const cx = padL + slot * (i + 0.5), x = cx - bw / 2;
    html += `<rect class="hit" data-i="${i}" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${ch}"/>`;
    const tot = totals[i];
    let top = padT + ch;
    if (tot > 0) {
      const full = Math.max(2, ch * tot / 60 / max);   // 再小也至少 2px
      const k = full / (ch * tot / 60 / max);
      const segs = it.segs.filter(s => s.val > 0);
      let base = padT + ch;
      html += `<g class="bar-g" data-g="${i}">`;
      segs.forEach((s, j) => {
        const h = ch * s.val / 60 / max * k;
        const bottom = j ? base - GAP : base;
        const y = base - h;
        const hh = bottom - y;
        if (hh > 0.5) {
          const r = j === segs.length - 1 ? Math.min(4, bw / 2, hh) : 0;
          html += `<path data-i="${i}" fill="${s.color}" d="${topRounded(x, y, bw, hh, r)}"/>`;
        }
        base = y;
      });
      html += '</g>';
      top = base;
    }
    tops.push(top);
    if (it.label) html += `<text class="axis" x="${cx}" y="${H - 5}" text-anchor="middle">${it.label}</text>`;
  });

  if (goal) {
    const y = yOf(goal);
    html += `<line class="goal" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
    html += `<text class="goal-label" x="${W - padR}" y="${y - 4}" text-anchor="end">目标 ${fmtDur(goal)}</text>`;
  }
  svg.innerHTML = html;

  bindHover(svg, tip, i => {
    const it = items[i];
    const segs = it.segs.filter(s => s.val > 0).sort((p, q) => q.val - p.val);
    let body = `<div class="tip-h">${esc(it.tip)} · ${fmtDur(totals[i])}</div>`;
    if (segs.length > 1 || (segs[0] && segs[0].name)) {
      body += segs.slice(0, 5).map(s => `<div><i style="background:${s.color}"></i>${esc(s.name)} ${fmtDur(s.val)}</div>`).join('');
      if (segs.length > 5) body += `<div class="muted-tip">等 ${segs.length} 项</div>`;
    }
    placeTip(svg, tip, body, padL + slot * (i + 0.5), tops[i], W);
  }, onPick && (i => onPick(i)));
}

/* ---------------- 日视图：时间线 ---------------- */
function drawTimeline(svg, list, a) {
  const tip = svg.nextElementSibling;
  const b = a + DAY_MS, now = Date.now();
  const W = svg.clientWidth || 320, H = 74;
  const padL = 6, padR = 6, rowY = 10, rowH = 36;
  const cw = W - padL - padR;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = `${H}px`;

  // 自适应显示范围：从最早的记录到最晚的记录，至少 8 小时
  let h0 = 24, h1 = 0;
  const spans = list.map(r => { const [s, e] = recSpan(r); return [Math.max(s, a), Math.min(e, b), r]; });
  for (const [s, e] of spans) { h0 = Math.min(h0, Math.floor((s - a) / 3600000)); h1 = Math.max(h1, Math.ceil((e - a) / 3600000)); }
  if (now >= a && now < b) { const hn = (now - a) / 3600000; h0 = Math.min(h0, Math.floor(hn)); h1 = Math.max(h1, Math.ceil(hn)); }
  if (h0 > h1) { h0 = 8; h1 = 20; }
  while (h1 - h0 < 8) { if (h1 < 24) h1++; if (h1 - h0 < 8 && h0 > 0) h0--; }
  const t0 = a + h0 * 3600000, span = (h1 - h0) * 3600000;
  const xOf = t => padL + (t - t0) / span * cw;

  let html = `<rect class="tl-track" x="${padL}" y="${rowY}" width="${cw}" height="${rowH}" rx="6"/>`;
  const step = Math.max(1, Math.ceil(44 / (cw / (h1 - h0)))); // 刻度标签至少间隔 44px
  for (let h = h0; h <= h1; h++) {
    if ((h - h0) % step) continue;
    const x = xOf(a + h * 3600000);
    html += `<line class="grid" x1="${x}" x2="${x}" y1="${rowY + rowH}" y2="${rowY + rowH + 4}"/>`;
    const anchor = h === h0 ? 'start' : h === h1 ? 'end' : 'middle';
    html += `<text class="axis" x="${x}" y="${H - 6}" text-anchor="${anchor}">${h}:00</text>`;
  }
  spans.forEach(([s, e, r], i) => {
    const x1 = xOf(s), x2 = xOf(e);
    const w = Math.max(2, x2 - x1 - (x2 - x1 > 4 ? GAP : 0));
    html += `<rect class="hit" data-i="${i}" x="${(x1 + x2) / 2 - Math.max(w, 14) / 2}" y="${rowY - 6}" width="${Math.max(w, 14)}" height="${rowH + 12}"/>`;
    html += `<rect data-i="${i}" data-g="${i}" class="block" x="${x1}" y="${rowY}" width="${w}" height="${rowH}" rx="${Math.min(4, w / 2)}" fill="${slotColor(slotOf(r.task))}"/>`;
  });
  if (now >= a && now < b) {
    const x = xOf(now);
    html += `<line class="now-line" x1="${x}" x2="${x}" y1="${rowY - 5}" y2="${rowY + rowH + 5}"/>`;
  }
  svg.innerHTML = html;

  bindHover(svg, tip, i => {
    const [s, e, r] = spans[i];
    placeTip(svg, tip, `<div class="tip-h"><i style="background:${slotColor(slotOf(r.task))}"></i>${esc(r.task)}</div><div>${fmtTime(s)} – ${fmtTime(e)} · ${fmtDur(r.dur)}</div>`, (xOf(s) + xOf(e)) / 2, rowY, W);
  });
}

/* ---------------- 主图：分桶 ---------------- */
function buckets(period, d) {
  const out = [];
  const a0 = startOf(period, d);
  if (period === 'week' || period === 'month') {
    const n = period === 'week' ? 7 : new Date(a0.getFullYear(), a0.getMonth() + 1, 0).getDate();
    for (let i = 0; i < n; i++) {
      const a = shift('day', a0, i), b = shift('day', a0, i + 1);
      const label = period === 'week' ? WEEK[a.getDay()] : (i === 0 || (i + 1) % 5 === 0) ? String(i + 1) : '';
      out.push({ a: +a, b: +b, label, tip: fmtDate(a), drill: { period: 'day', date: a } });
    }
  } else {
    for (let i = 0; i < 12; i++) {
      const a = new Date(a0.getFullYear(), i, 1), b = new Date(a0.getFullYear(), i + 1, 1);
      out.push({ a: +a, b: +b, label: `${i + 1}月`, tip: `${a0.getFullYear()}年${i + 1}月`, drill: { period: 'month', date: a } });
    }
  }
  return out;
}

function renderMainChart(period, a, b, list) {
  const svg = $('#chart');
  const legend = $('#legend'), table = $('#chart-table');
  $('#chart-title').textContent = { day: '时间线', week: '每天', month: '每天', year: '每月' }[period];
  $('#btn-table').textContent = stats.table ? '图表' : '表格';
  $('#chart-box').hidden = stats.table;
  table.hidden = !stats.table;

  // 本时段出现的颜色（按固定槽位顺序），用于图例
  const used = [...new Set(list.map(r => slotOf(r.task)))].sort((x, y) => x - y);
  legend.innerHTML = used.length > 1 || period === 'day'
    ? used.map(i => `<span><i style="background:${slotColor(i)}"></i>${esc(slotName(i))}</span>`).join('')
    : '';
  legend.hidden = stats.table || !legend.innerHTML;

  if (period === 'day') {
    if (!list.length) {
      svg.innerHTML = ''; svg.style.height = '0px';
      table.innerHTML = '';
      legend.innerHTML = '<span class="empty-inline">这一天还没有记录</span>';
      legend.hidden = false;
      return;
    }
    drawTimeline(svg, list, a);
    const rows = [...list].sort((x, y) => x.end - y.end);
    table.innerHTML = `<table><thead><tr><th>时间</th><th>事项</th><th>时长</th></tr></thead><tbody>${rows.map(r => {
      const [s] = recSpan(r);
      return `<tr><td>${fmtTime(s)}–${fmtTime(r.end)}</td><td><i style="background:${slotColor(slotOf(r.task))}"></i>${esc(r.task)}</td><td>${fmtDur(r.dur)}</td></tr>`;
    }).join('')}</tbody></table>`;
    return;
  }

  const bks = buckets(period, a);
  for (const k of bks) {
    k.bySlot = new Array(SLOTS + 1).fill(0);
    k.byTask = new Map();
  }
  for (const r of list) {
    const sl = slotOf(r.task);
    for (const k of bks) {
      const o = overlap(r, k.a, k.b);
      if (o <= 0) continue;
      k.bySlot[sl] += o;
      k.byTask.set(r.task, (k.byTask.get(r.task) || 0) + o);
    }
  }
  const items = bks.map(k => ({
    label: k.label, tip: k.tip,
    segs: k.bySlot.map((val, i) => ({ val, i })).filter(s => s.val > 0).map(({ val, i }) => ({ val, color: slotColor(i), name: slotName(i) })),
  }));
  const goal = (period === 'week' || period === 'month') ? settings.goal * 60 : 0;
  drawBars(svg, items, {
    goal,
    onPick: i => { stats.anchor = bks[i].drill.date; stats.period = bks[i].drill.period; renderStats(); },
  });

  const rows = bks.filter(k => k.bySlot.some(v => v > 0));
  table.innerHTML = rows.length ? `<table><thead><tr><th>${period === 'year' ? '月份' : '日期'}</th><th>时长</th><th>主要事项</th></tr></thead><tbody>${rows.map(k => {
    const tot = k.bySlot.reduce((s, v) => s + v, 0);
    const [topTask] = [...k.byTask].sort((x, y) => y[1] - x[1])[0];
    return `<tr><td>${k.tip}</td><td>${fmtDur(tot)}</td><td><i style="background:${slotColor(slotOf(topTask))}"></i>${esc(topTask)}</td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">没有记录</div>';
}

/* ---------------- 日历热力图 ---------------- */
function heatLevel(sec, ref) {
  if (sec < 60) return 0;
  const f = sec / ref;
  return f < 0.25 ? 1 : f < 0.5 ? 2 : f < 1 ? 3 : 4;
}

function renderHeatmap(period, anchor, dt) {
  const svg = $('#heatmap');
  const tip = svg.nextElementSibling;
  const W = svg.clientWidth || 320;
  const goalSec = settings.goal * 60;
  const todayK = startOf('day', new Date()).getTime();
  const cells = []; // { k, x, y, w, h, text }
  let H = 0, html = '';

  if (period === 'month') {
    $('#heat-title').textContent = '本月日历';
    const a0 = startOf('month', anchor);
    const days = new Date(a0.getFullYear(), a0.getMonth() + 1, 0).getDate();
    const off = (a0.getDay() + 6) % 7;
    const gap = 4, cwid = (W - gap * 6) / 7, chgt = Math.min(cwid, 40);
    WEEK.slice(1).concat('日').forEach((w, i) => { html += `<text class="axis" x="${i * (cwid + gap) + cwid / 2}" y="10" text-anchor="middle">${w}</text>`; });
    for (let i = 0; i < days; i++) {
      const pos = off + i, col = pos % 7, row = Math.floor(pos / 7);
      cells.push({ k: shift('day', a0, i).getTime(), x: col * (cwid + gap), y: 18 + row * (chgt + gap), w: cwid, h: chgt, text: String(i + 1) });
    }
    H = 18 + Math.ceil((off + days) / 7) * (chgt + gap);
  } else if (period === 'year') {
    $('#heat-title').textContent = '全年日历';
    const y = startOf('year', anchor).getFullYear();
    const labelW = 30, gap = 2;
    const cs = Math.min(14, Math.floor((W - labelW) / 31) - gap);
    const rh = Math.max(cs, 12);
    [1, 10, 20, 31].forEach(d => { html += `<text class="axis" x="${labelW + (d - 1) * (cs + gap) + cs / 2}" y="10" text-anchor="middle">${d}</text>`; });
    for (let m = 0; m < 12; m++) {
      const yy = 16 + m * (rh + gap);
      html += `<text class="axis" x="${labelW - 6}" y="${yy + rh / 2 + 3.5}" text-anchor="end">${m + 1}月</text>`;
      const days = new Date(y, m + 1, 0).getDate();
      for (let d = 1; d <= days; d++) cells.push({ k: new Date(y, m, d).getTime(), x: labelW + (d - 1) * (cs + gap), y: yy, w: cs, h: rh });
    }
    H = 16 + 12 * (rh + gap);
  } else {
    $('#heat-title').textContent = '最近 20 周';
    const weeks = 20, labelW = 18, gap = 3;
    const cs = Math.min(16, Math.floor((W - labelW) / weeks) - gap);
    const first = shift('week', startOf('week', anchor), -(weeks - 1));
    ['一', '', '三', '', '五', '', '日'].forEach((w, i) => { if (w) html += `<text class="axis" x="0" y="${16 + i * (cs + gap) + cs - 2}">${w}</text>`; });
    let lastMonth = -1, lastLabel = -9;
    for (let c = 0; c < weeks; c++) {
      const wk = shift('week', first, c);
      if (wk.getMonth() !== lastMonth) {
        lastMonth = wk.getMonth();
        // 标签之间至少隔 3 列，避免重叠
        const nextChange = shift('week', first, c + 2).getMonth() !== lastMonth;
        if (c - lastLabel >= 3 && c < weeks - 1 && !(c === 0 && nextChange)) {
          html += `<text class="axis" x="${labelW + c * (cs + gap)}" y="10">${lastMonth + 1}月</text>`;
          lastLabel = c;
        }
      }
      for (let r = 0; r < 7; r++) cells.push({ k: shift('day', wk, r).getTime(), x: labelW + c * (cs + gap), y: 16 + r * (cs + gap), w: cs, h: cs });
    }
    H = 16 + 7 * (cs + gap);
  }

  const ref = goalSec || Math.max(60, ...cells.map(c => dt.get(c.k) || 0));
  cells.forEach((c, i) => {
    const sec = dt.get(c.k) || 0;
    const future = c.k > todayK;
    const lv = future ? 'future' : `lv${heatLevel(sec, ref)}`;
    html += `<rect data-i="${i}" class="cell ${lv}${c.k === todayK ? ' today' : ''}" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${Math.min(4, c.w / 4)}"/>`;
    if (c.text) html += `<text class="cell-num ${heatLevel(sec, ref) >= 3 && !future ? 'inv' : ''}" x="${c.x + c.w / 2}" y="${c.y + c.h / 2 + 4}" text-anchor="middle">${c.text}</text>`;
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = `${H}px`;
  svg.innerHTML = html;

  $('#heat-legend').innerHTML = `少 ${[0, 1, 2, 3, 4].map(l => `<i class="lv${l}"></i>`).join('')} 多`;
  $('#heat-note').textContent = goalSec ? `最深色 = 达成每日目标（${fmtDur(goalSec)}）· 点击某天查看详情` : '颜色按本视图中最多的一天分级 · 点击某天查看详情';

  bindHover(svg, tip, i => {
    const c = cells[i];
    const sec = dt.get(c.k) || 0;
    placeTip(svg, tip, `<div class="tip-h">${fmtDate(c.k)}</div><div>${c.k > todayK ? '还没到' : sec >= 60 ? fmtDur(sec) : '无记录'}</div>`, c.x + c.w / 2, c.y, W);
  }, i => { stats.period = 'day'; stats.anchor = new Date(cells[i].k); renderStats(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
}

/* ---------------- 习惯：时段 & 星期 ---------------- */
function renderHabits(period, a, b, list, dt) {
  const panel = $('#habit-panel');
  panel.hidden = period === 'day';
  if (period === 'day') return;

  const hours = hourDist(list, a, b);
  const peak = hours.indexOf(Math.max(...hours));
  $('#peak-hour').textContent = hours[peak] > 0 ? `· 最集中 ${peak}:00–${peak + 1}:00` : '';
  drawBars($('#hour-chart'), hours.map((v, h) => ({
    label: h % 6 === 0 ? String(h) : '',
    tip: `${h}:00–${h + 1}:00`,
    segs: [{ val: v, color: 'var(--accent)', name: '' }],
  })), { height: 130 });

  const wdWrap = $('#wd-wrap');
  wdWrap.hidden = period === 'week';
  if (period === 'week') return;
  const sum = new Array(7).fill(0), cnt = new Array(7).fill(0);
  const end = Math.min(b, startOf('day', new Date()).getTime() + DAY_MS);
  for (let d = new Date(a); d.getTime() < end; d = shift('day', d, 1)) {
    const i = (d.getDay() + 6) % 7;
    sum[i] += dt.get(d.getTime()) || 0;
    cnt[i]++;
  }
  const avg = sum.map((s, i) => cnt[i] ? s / cnt[i] : 0);
  const best = avg.indexOf(Math.max(...avg));
  $('#peak-wd').textContent = avg[best] > 0 ? `· 周${WEEK[(best + 1) % 7]}最多` : '';
  drawBars($('#wd-chart'), avg.map((v, i) => ({
    label: `周${WEEK[(i + 1) % 7]}`,
    tip: `周${WEEK[(i + 1) % 7]} 日均`,
    segs: [{ val: v, color: 'var(--accent)', name: '' }],
  })), { height: 130 });
}

/* ---------------- 环形图：事项占比 ---------------- */
function renderPie(tasks, total) {
  const box = $('#pie');
  if (!tasks.length || total <= 0) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;

  // 按颜色槽位合并（前 7 名各自一块，其余并入「其他」），大的在前，「其他」放最后
  const bySlot = new Map();
  for (const t of tasks) {
    const i = slotOf(t.task);
    const it = bySlot.get(i) || { i, name: slotName(i), sec: 0, n: 0 };
    it.sec += t.sec; it.n++;
    bySlot.set(i, it);
  }
  const slices = [...bySlot.values()].sort((x, y) => (x.i === SLOTS) - (y.i === SLOTS) || y.sec - x.sec);

  const S = 150, cx = S / 2, cy = S / 2, R = 70, r = 46;
  const pt = (rad, ang) => `${(cx + rad * Math.sin(ang)).toFixed(2)},${(cy - rad * Math.cos(ang)).toFixed(2)}`;
  const arc = (a0, a1) => {
    if (a1 - a0 >= Math.PI * 2 - 1e-6) { // 只有一块：画完整圆环
      return `M${pt(R, 0)}A${R},${R} 0 1 1 ${pt(R, Math.PI)}A${R},${R} 0 1 1 ${pt(R, 0)}Z` +
             `M${pt(r, 0)}A${r},${r} 0 1 0 ${pt(r, Math.PI)}A${r},${r} 0 1 0 ${pt(r, 0)}Z`;
    }
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M${pt(R, a0)}A${R},${R} 0 ${large} 1 ${pt(R, a1)}L${pt(r, a1)}A${r},${r} 0 ${large} 0 ${pt(r, a0)}Z`;
  };

  let a = 0, paths = '';
  slices.forEach((s, k) => {
    const a1 = a + s.sec / total * Math.PI * 2;
    paths += `<path class="slice" data-i="${k}" data-g="${k}" fill="${slotColor(s.i)}" d="${arc(a, a1)}" fill-rule="evenodd"/>`;
    a = a1;
  });

  const pct = s => { const v = s.sec / total * 100; return v < 1 ? '<1%' : `${Math.round(v)}%`; };
  box.innerHTML = `
    <div class="pie-chart">
      <svg viewBox="0 0 ${S} ${S}" role="img" aria-label="各事项时长占比">${paths}</svg>
      <div class="pie-center"><b>${fmtDur(total)}</b><small>${tasks.length} 项</small></div>
    </div>
    <div class="pie-legend">${slices.map((s, k) => `
      <div class="pl-row" data-i="${k}"><i style="background:${slotColor(s.i)}"></i><span class="pl-name">${esc(s.name)}${s.i === SLOTS ? ` (${s.n})` : ''}</span><span class="pl-pct">${pct(s)}</span></div>`).join('')}
    </div>`;

  const svg = box.querySelector('svg');
  const center = box.querySelector('.pie-center');
  const reset = () => {
    center.innerHTML = `<b>${fmtDur(total)}</b><small>${tasks.length} 项</small>`;
    svg.classList.remove('hovering');
    box.querySelectorAll('.on').forEach(n => n.classList.remove('on'));
  };
  const show = k => {
    const s = slices[k];
    svg.classList.add('hovering');
    box.querySelectorAll('.on').forEach(n => n.classList.remove('on'));
    box.querySelectorAll(`[data-g="${k}"], .pl-row[data-i="${k}"]`).forEach(n => n.classList.add('on'));
    center.innerHTML = `<b>${pct(s)}</b><small class="pc-name">${esc(s.name)}</small><small>${fmtDur(s.sec)}</small>`;
  };
  const onEvt = e => { const k = e.target.closest('[data-i]')?.dataset.i; if (k == null) reset(); else show(+k); };
  for (const el of [svg, box.querySelector('.pie-legend')]) {
    el.onpointermove = onEvt;
    el.onpointerdown = onEvt;
    el.onpointerleave = reset;
  }
}

/* ---------------- 洞察 ---------------- */
function renderInsights(period, a, b, list, dt, total) {
  const now = Date.now();
  const goalSec = settings.goal * 60;
  const { cur, best } = streaks(dt);
  const longest = list.reduce((m, r) => (!m || r.dur > m.dur ? r : m), null);
  const tiles = [];

  if (period === 'day') {
    if (goalSec) {
      const pct = Math.round(total / goalSec * 100);
      tiles.push({ label: '目标完成', value: `${pct}%`, sub: `${fmtDur(total)} / ${fmtDur(goalSec)}`, good: pct >= 100 });
    } else {
      tiles.push({ label: '番茄数', value: list.filter(r => r.mode === 'focus').length, sub: '完整的专注' });
    }
    tiles.push({ label: '最长单次', value: longest ? fmtDur(longest.dur) : '—', sub: longest ? esc(longest.task) : '' });
    if (list.length) {
      const first = Math.min(...list.map(r => recSpan(r)[0])), last = Math.max(...list.map(r => r.end));
      tiles.push({ label: '时间跨度', value: `${fmtTime(first)}–${fmtTime(last)}`, sub: `专注占 ${Math.round(total * 1000 / Math.max(1, last - first) * 100)}%` });
    } else {
      tiles.push({ label: '时间跨度', value: '—', sub: '' });
    }
    tiles.push({ label: '连续打卡', value: `${cur}天`, sub: `最长 ${best} 天` });
  } else {
    const end = Math.min(b, startOf('day', new Date()).getTime() + DAY_MS);
    let days = 0, activeDays = 0, met = 0, bestDay = null;
    for (let d = new Date(a); d.getTime() < end; d = shift('day', d, 1)) {
      const v = dt.get(d.getTime()) || 0;
      days++;
      if (v >= 60) activeDays++;
      if (goalSec && v >= goalSec) met++;
      if (!bestDay || v > bestDay.v) bestDay = { k: d.getTime(), v };
    }
    const hours = hourDist(list, a, b);
    const peak = hours.indexOf(Math.max(...hours));
    tiles.push({ label: '连续打卡', value: `${cur}天`, sub: `最长 ${best} 天` });
    tiles.push({ label: '最佳一天', value: bestDay && bestDay.v >= 60 ? fmtDur(bestDay.v) : '—', sub: bestDay && bestDay.v >= 60 ? fmtDate(bestDay.k) : '' });
    tiles.push({ label: '最长单次', value: longest ? fmtDur(longest.dur) : '—', sub: longest ? esc(longest.task) : '' });
    tiles.push({ label: '活跃天数', value: days ? `${activeDays} / ${days}天` : '—', sub: days ? `${Math.round(activeDays / days * 100)}% 的日子有记录` : '' });
    if (goalSec) tiles.push({ label: '目标达成', value: days ? `${met} / ${days}天` : '—', sub: `每日 ${fmtDur(goalSec)}`, good: days && met === days });
    else tiles.push({ label: '番茄数', value: list.filter(r => r.mode === 'focus').length, sub: '完整的专注' });
    tiles.push({ label: '最专注时段', value: hours[peak] > 0 ? `${peak}:00–${peak + 1}:00` : '—', sub: hours[peak] > 0 && total ? `占 ${Math.round(hours[peak] / total * 100)}%` : '' });
  }
  $('#insights').innerHTML = tiles.map(t =>
    `<div class="ins"><small>${t.label}</small><b>${t.value}${t.good ? ' <em class="badge">达成</em>' : ''}</b><span>${t.sub || ''}</span></div>`).join('');
}

/* ---------------- 同期对比 ---------------- */
function deltaHtml(cur, prev, word) {
  if (!prev) return cur ? `<span class="muted-d">${word}无记录</span>` : '';
  const pct = Math.round((cur - prev) / prev * 100);
  if (pct === 0) return `<span class="muted-d">与${word}持平</span>`;
  return `<span class="${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '↑' : '↓'}${Math.abs(pct)}%</span> <span class="muted-d">较${word}</span>`;
}

function renderSummary() {
  const now = new Date();
  for (const p of ['day', 'week', 'month', 'year']) {
    const a = startOf(p, now).getTime();
    const cur = sumRange(a, now.getTime()).total;
    const pa = startOf(p, shiftKeep(p, now, -1)).getTime();
    const prev = sumRange(pa, shiftKeep(p, now, -1).getTime()).total;
    $(`#sum-${p}`).textContent = fmtDur(sumRange(...rangeOf(p, now)).total);
    $(`#dl-${p}`).innerHTML = deltaHtml(cur, prev, `${PREV_WORD[p]}同期`);
  }
}

/* ---------------- 统计页 ---------------- */
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

function renderStats() {
  computeTaskSlots();
  renderSummary();
  const now = new Date();
  const { period, anchor } = stats;
  $$('#period button').forEach(b => b.classList.toggle('active', b.dataset.p === period));
  $('#period-label').textContent = periodLabel(period, anchor);
  const [a, b] = rangeOf(period, anchor);
  $('#next').disabled = b > now.getTime();

  const list = records.filter(r => overlap(r, a, b) > 0);
  const dt = dayTotals();
  const { total, count } = sumRange(a, b);
  $('#p-total').textContent = fmtDur(total);
  $('#p-count').textContent = count;
  if (period === 'day') {
    $('#p-avg-label').textContent = '平均每次';
    $('#p-avg').textContent = count ? fmtDur(total / count) : '—';
  } else {
    const end = Math.min(b, startOf('day', now).getTime() + DAY_MS);
    const days = Math.max(1, Math.round((end - a) / DAY_MS));
    $('#p-avg-label').textContent = '日均';
    $('#p-avg').textContent = end > a ? fmtDur(total / days) : '—';
  }

  // 与上一时段对比：当前时段比「同期」，过去的时段比整段
  const isCurrent = a <= now.getTime() && now.getTime() < b;
  const pa = shift(period, a, -1).getTime();
  const curT = isCurrent ? sumRange(a, now.getTime()).total : total;
  const prevT = isCurrent ? sumRange(pa, shiftKeep(period, now, -1).getTime()).total : sumRange(pa, a).total;
  const word = PREV_WORD[period] + (isCurrent ? '同期' : '');
  let dHtml = '';
  if (prevT) {
    const diff = curT - prevT;
    const pct = Math.round(diff / prevT * 100);
    dHtml = Math.abs(diff) < 60 ? `与${word}持平`
      : `比${word}${diff > 0 ? '多' : '少'} ${fmtDur(Math.abs(diff))} <span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '↑' : '↓'}${Math.abs(pct)}%</span>`;
  } else if (curT) dHtml = `${word}没有记录`;
  $('#p-delta').innerHTML = dHtml;

  renderMainChart(period, a, b, list);
  renderInsights(period, a, b, list, dt, total);

  // 按事项汇总
  const map = new Map();
  for (const r of list) {
    const it = map.get(r.task) || { task: r.task, sec: 0, n: 0 };
    it.sec += overlap(r, a, b); it.n++;
    map.set(r.task, it);
  }
  const tasks = [...map.values()].sort((x, y) => y.sec - x.sec);
  renderPie(tasks, total);
  const box = $('#by-task');
  if (!tasks.length) box.innerHTML = '<div class="empty">这段时间还没有记录</div>';
  else {
    const top = tasks[0].sec;
    box.innerHTML = tasks.map(it => `
      <div class="row">
        <span class="name"><i style="background:${slotColor(slotOf(it.task))}"></i>${esc(it.task)}</span>
        <span class="val">${fmtDur(it.sec)} · ${it.n}次 · ${Math.round(it.sec / total * 100)}%</span>
        <div class="meter"><i style="width:${(it.sec / top * 100).toFixed(1)}%;background:${slotColor(slotOf(it.task))}"></i></div>
      </div>`).join('');
  }

  renderHeatmap(period, anchor, dt);
  renderHabits(period, a, b, list, dt);
}

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
  $('#s-goal').value = settings.goal;
  $('#s-auto').checked = settings.autoBreak;
  $('#s-sound').checked = settings.sound;
  $('#s-notify').checked = settings.notify;
  $('#s-awake').checked = settings.keepAwake && wakeSupported;
  $('#s-awake').disabled = !wakeSupported;
  if (!wakeSupported) $('#s-awake-note').textContent = '当前浏览器不支持（iPhone 需 iOS 16.4 以上）';
}

function bindNum(id, key, min, max) {
  $(id).addEventListener('change', e => {
    const n = parseInt(e.target.value, 10);
    const v = Math.max(min, Math.min(max, Number.isNaN(n) ? DEFAULT_SETTINGS[key] : n));
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
bindNum('#s-goal', 'goal', 0, 1440);
$('#s-auto').onchange = e => { settings.autoBreak = e.target.checked; saveSettings(); };
$('#s-sound').onchange = e => { settings.sound = e.target.checked; saveSettings(); if (settings.sound) beep(); };
$('#s-awake').onchange = e => { settings.keepAwake = e.target.checked; saveSettings(); render(); };
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
$('#btn-table').onclick = () => { stats.table = !stats.table; renderStats(); };

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && currentView === 'timer' && document.activeElement.tagName !== 'INPUT' && !$('#dlg').open) {
    e.preventDefault();
    $('#btn-main').click();
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); render(); } });
let resizeT = null;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (currentView === 'stats') renderStats(); }, 150); });
// 其他标签页修改了数据时同步
window.addEventListener('storage', e => {
  if (e.key === KEY.records) records = load(KEY.records, []);
  if (e.key === KEY.timer) Object.assign(timer, load(KEY.timer, {}));
  if (timer.status === 'running') ensureTicker();
  render();
});

function render() {
  syncWakeLock();
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
