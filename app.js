'use strict';
/* ================= Telegram и хранилище ================= */
const tg = window.Telegram && window.Telegram.WebApp;
const inTG = !!(tg && tg.initData);
if (inTG) {
  document.documentElement.setAttribute('data-tg', '');
  tg.ready(); tg.expand();
  try { if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes(); } catch (e) {}
}
const hasCloud = inTG && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9');

function lsGet(k){ try { return localStorage.getItem('kw_' + k) || ''; } catch (e) { return ''; } }
function lsSet(k, v){ try { localStorage.setItem('kw_' + k, v); } catch (e) {} }
function lsDel(k){ try { localStorage.removeItem('kw_' + k); } catch (e) {} }

const Store = {
  get(keys){
    if (!hasCloud) { const o = {}; keys.forEach(k => o[k] = lsGet(k)); return Promise.resolve(o); }
    return new Promise(res => tg.CloudStorage.getItems(keys, (err, v) => res(err ? null : (v || {}))));
  },
  set(k, v){
    lsSet(k, v);
    if (!hasCloud) return Promise.resolve(true);
    return new Promise(res => tg.CloudStorage.setItem(k, v, err => res(!err)));
  },
  del(keys){
    keys.forEach(lsDel);
    if (!hasCloud || !keys.length) return Promise.resolve(true);
    return new Promise(res => tg.CloudStorage.removeItems(keys, err => res(!err)));
  }
};

/* ================= Константы ================= */
const DEF_SET = { salary:0, salaryDay:10, giglyCap:0, cushionPct:20, cushionGoal:500, setup:false, since:0, hasCard:false, bills:[], tut:false, v:2 };
const DEF_CATS = ['Еда','Такси','Кафе','Ребёнок','Транспорт','Телефон','Реквизит','Gigly','Дом','Сигареты','Другое'];
const EMO = {'Еда':'🛒','Такси':'🚕','Кафе':'☕','Ребёнок':'🧸','Транспорт':'⛽','Телефон':'📱','Реквизит':'🎩','Gigly':'🚀','Дом':'🏠','Сигареты':'🚬','Другое':'•','Неучтено':'❔','Аренда':'🔑','Жене':'👨‍👧','Одежда':'👕','Здоровье':'💊','Подарки':'🎁','Шаурма':'🌯'};
const IN_TYPES = [['salary','Зарплата'],['prepay','Предоплата'],['fee','Гонорар'],['tips','Чаевые'],['gigly','От Gigly'],['other','Другое']];
const IN_NAME = Object.fromEntries(IN_TYPES.concat([['start','Стартовый остаток']]));
const ACC = { cash:'💵 Наличные', card:'💳 Карта' };
const MONTHS = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const DAY = 864e5;

/* ================= Состояние ================= */
let S = { set:{...DEF_SET, bills:[]}, cats:{}, tx:[], wish:{items:[], skipped:[]}, ev:[], txParts:0 };
let tab = 'home';

async function load(){
  let base = await Store.get(['s','c','w','e','txn']);
  if (base === null) {
    base = {}; ['s','c','w','e','txn'].forEach(k => base[k] = lsGet(k));
    toast('Нет связи с облаком Telegram, показываю локальную копию');
  }
  try { if (base.s) { const raw = JSON.parse(base.s); S.set = {...DEF_SET, bills:[], ...raw, v:raw.v || 1}; } } catch (e) {}
  try { if (base.c) S.cats = JSON.parse(base.c); } catch (e) {}
  try { if (base.w) S.wish = {items:[], skipped:[], ...JSON.parse(base.w)}; } catch (e) {}
  try { if (base.e) S.ev = JSON.parse(base.e); } catch (e) {}
  const n = parseInt(base.txn || '0', 10) || 0;
  S.txParts = n;
  if (n) {
    const keys = Array.from({length:n}, (_, i) => 'tx' + i);
    const parts = (await Store.get(keys)) || {};
    try { S.tx = JSON.parse(keys.map(k => parts[k] || lsGet(k)).join('')); } catch (e) { S.tx = []; toast('Не удалось прочитать историю'); }
  }
  if (!Array.isArray(S.set.bills)) S.set.bills = [];
  DEF_CATS.forEach(c => { if (!S.cats[c]) S.cats[c] = { n:0, last:0, ac:'cash' }; });
  if (S.set.v !== 2) migrate();
}

// Переход с первой версии: аренда/жене стали отдельными конвертами-платежами
function migrate(){
  const s = S.set;
  if (s.rent > 0) s.bills.push({ id:'rent', name:'Аренда', amount:s.rent, day:s.rentDay || 10, from:s.since || Date.now() });
  if (s.wife > 0) s.bills.push({ id:'wife', name:'Жене', amount:s.wife, day:s.wifeDay || 10, from:s.since || Date.now() });
  ['rent','rentDay','wife','wifeDay'].forEach(k => delete s[k]);
  // Теперь всё на наличных: остаток карты переводим в наличные, карту прячем
  s.v = 2; s.hasCard = false;
  const card = r0(balances().acc.card);
  if (card !== 0) S.tx.push({ i:uid(), t:Date.now(), k:'xfer', a:card, f:'card', to:'cash' });
  let m = balances().env.m || 0;
  if (m > 0) {
    for (const b of billStatus()) {
      const take = Math.min(m, b.remaining);
      if (take > 0) { S.tx.push({ i:uid(), t:Date.now(), k:'move', a:take, f:'m', to:b.id }); m -= take; }
    }
    if (m > 0) S.tx.push({ i:uid(), t:Date.now(), k:'move', a:m, f:'m', to:'l' });
  }
  if (S.set.setup) save();
}

let saving = Promise.resolve();
function save(){
  saving = saving.then(async () => {
    const txs = JSON.stringify(S.tx);
    const parts = [];
    for (let i = 0; i < txs.length; i += 3800) parts.push(txs.slice(i, i + 3800));
    if (!parts.length) parts.push('[]');
    await Promise.all([
      Store.set('s', JSON.stringify(S.set)),
      Store.set('c', JSON.stringify(S.cats)),
      Store.set('w', JSON.stringify(S.wish)),
      Store.set('e', JSON.stringify(S.ev)),
      ...parts.map((p, i) => Store.set('tx' + i, p))
    ]);
    await Store.set('txn', String(parts.length));
    if (S.txParts > parts.length) await Store.del(Array.from({length:S.txParts - parts.length}, (_, i) => 'tx' + (parts.length + i)));
    S.txParts = parts.length;
  }).catch(() => toast('Не сохранилось, попробуй ещё раз'));
  return saving;
}

/* ================= Утилиты ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const r0 = n => Math.round(n);
const fmt = n => r0(n).toLocaleString('ru-RU') + ' zł';
const num = v => { const x = parseFloat(String(v).replace(',', '.').replace(/\s/g, '')); return isFinite(x) ? x : 0; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const clampDay = (y, m, d) => new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate()));
const ddmm = d => new Date(d).toLocaleDateString('ru-RU', {day:'numeric', month:'long'});
const wday = d => new Date(d).toLocaleDateString('ru-RU', {weekday:'short'});
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const daysTo = d => Math.round((sod(d) - sod(new Date())) / DAY);
function plural(n, a, b, c){ n = Math.abs(n) % 100; const n1 = n % 10; if (n > 10 && n < 20) return c; if (n1 > 1 && n1 < 5) return b; if (n1 === 1) return a; return c; }
const dn = n => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
function when(d){ const n = daysTo(d); return n < 0 ? `просрочено на ${dn(-n)}` : n === 0 ? 'сегодня' : n === 1 ? 'завтра' : `через ${dn(n)}`; }
function haptic(t){ try { if (inTG) tg.HapticFeedback.notificationOccurred(t || 'success'); } catch (e) {} }
function tap(){ try { if (inTG) tg.HapticFeedback.selectionChanged(); } catch (e) {} }
function billEmoji(b){ return b.emoji || EMO[b.name] || '📌'; }
function envName(k){
  if (k === 'l') return 'Кошелёк'; if (k === 'c') return 'Подушка'; if (k === 'g') return 'Gigly'; if (k === 'm') return 'Обязательное';
  const b = S.set.bills.find(x => x.id === k); return b ? b.name : 'Конверт';
}
function envEmoji(k){
  if (k === 'l') return '👛'; if (k === 'c') return '🛟'; if (k === 'g') return '🚀'; if (k === 'm') return '🔑';
  const b = S.set.bills.find(x => x.id === k); return b ? billEmoji(b) : '✉️';
}
const emo = c => EMO[c] || (c ? c[0].toUpperCase() : '•');

/* ================= Финансовая логика ================= */
function cycle(now = new Date()){
  const d = S.set.salaryDay || 1, y = now.getFullYear(), m = now.getMonth();
  const thisM = clampDay(y, m, d);
  return sod(now) >= thisM ? { start:thisM, next:clampDay(y, m + 1, d) } : { start:clampDay(y, m - 1, d), next:thisM };
}
// Горизонт: до следующей зарплаты; если зарплаты нет, 30 дней вперёд
function horizon(){
  if (S.set.salary > 0) return cycle();
  const n = sod(new Date()); return { start:n, next:new Date(+n + 30 * DAY) };
}

function balances(){
  const env = { l:0, c:0, g:0 }, acc = { cash:0, card:0 };
  const add = (e, v) => env[e] = (env[e] || 0) + v;
  for (const t of S.tx) {
    if (t.k === 'in') { for (const e in t.s) add(e, t.s[e]); acc[t.ac] += t.a; }
    else if (t.k === 'out' || t.k === 'pay') { for (const e in t.s) add(e, -t.s[e]); acc[t.ac] -= t.a; }
    else if (t.k === 'move') { add(t.f, -t.a); add(t.to, t.a); }
    else if (t.k === 'xfer') { acc[t.f] -= t.a; acc[t.to] += t.a; }
    else if (t.k === 'adj') { add('l', t.a); acc[t.ac] += t.a; }
  }
  return { env, acc, total: acc.cash + acc.card };
}

// Состояние каждого платежа: ближайшая дата, сколько уже в конверте, сколько осталось
function billStatus(){
  const { next } = horizon(), env = balances().env;
  return S.set.bills.filter(b => b.amount > 0).map(b => {
    const pays = S.tx.filter(t => t.k === 'pay' && t.c === b.id && t.d).sort((x, y) => x.d - y.d);
    const last = pays[pays.length - 1];
    let due;
    if (last) { const d = new Date(last.d); due = clampDay(d.getFullYear(), d.getMonth() + 1, b.day); }
    else {
      const since = sod(b.from || S.set.since || Date.now());
      due = clampDay(since.getFullYear(), since.getMonth(), b.day);
      if (due < since) due = clampDay(since.getFullYear(), since.getMonth() + 1, b.day);
    }
    const saved = Math.max(0, env[b.id] || 0);
    const remaining = Math.max(0, b.amount - saved);
    const days = daysTo(due);
    const done = due >= next; // платёж в день зарплаты или позже закрывается следующей зарплатой
    const perDay = remaining > 0 ? Math.ceil(remaining / Math.max(1, days)) : 0;
    return { ...b, due, saved, remaining, days, done, perDay, last };
  }).sort((a, b) => a.due - b.due);
}

function giglyThisMonth(){
  const n = new Date(), from = +new Date(n.getFullYear(), n.getMonth(), 1);
  return S.tx.filter(t => t.k === 'in' && t.t >= from).reduce((a, t) => a + (t.s.g || 0), 0);
}

// Раскладка прихода: сначала ближайшие платежи, потом подушка, Gigly, остальное в кошелёк
function split(a, type){
  const s = {};
  let rest = a;
  for (const b of billStatus().filter(x => !x.done && x.remaining > 0)) {
    const take = Math.min(rest, b.remaining);
    if (take > 0) { s[b.id] = take; rest -= take; }
    if (rest <= 0) break;
  }
  if (!['salary','start'].includes(type) && rest > 0) {
    const toC = r0(rest * (S.set.cushionPct || 0) / 100);
    if (toC > 0) { s.c = toC; rest -= toC; }
  }
  if (rest > 0 && S.set.giglyCap > 0 && type !== 'start') {
    const toG = Math.min(Math.max(0, S.set.giglyCap - giglyThisMonth()), Math.floor(rest * 0.3));
    if (toG > 0) { s.g = toG; rest -= toG; }
  }
  if (rest > 0) s.l = rest;
  return s;
}

// Списание: сначала из выбранного конверта, нехватку берём из кошелька
function debit(a, pref){
  const b = balances().env, s = {};
  let rest = a;
  if (pref !== 'l') {
    const take = Math.min(rest, Math.max(0, b[pref] || 0));
    if (take > 0) { s[pref] = take; rest -= take; }
  }
  if (rest > 0) s.l = (s.l || 0) + rest;
  return s;
}

function today(){
  const { next } = horizon(), now = sod(new Date());
  const daysLeft = Math.max(1, Math.round((next - now) / DAY));
  const bal = balances(), env = bal.env;
  const spentToday = S.tx.filter(t => t.k === 'out' && t.t >= +now).reduce((a, t) => a + (t.s.l || 0), 0);
  const bills = billStatus();
  const short = bills.filter(b => !b.done).reduce((s, b) => s + b.remaining, 0); // ещё не отложено на ближайшие платежи
  const free = env.l - short;
  // Делим минимум на 7 дней: даже перед зарплатой не даём спустить всё за пару дней
  const daily = Math.max(0, Math.floor((free + spentToday) / Math.max(7, daysLeft)));
  const left = daily - spentToday;
  const dow = (now.getDay() + 6) % 7;
  const toSun = Math.min(7 - dow, daysLeft);
  const week = Math.max(0, Math.min(free, daily * toSun - spentToday));
  const busy = bills.reduce((s, b) => s + b.saved, 0) + short;
  return { daysLeft, daily, left, week, spentToday, free, short, next, env, total:bal.total, acc:bal.acc, bills, busy };
}

// Средний расход из кошелька в день за последние 14 дней
function avgDaily(){
  const now = Date.now(), from = Math.max(now - 14 * DAY, +sod(S.set.since || now));
  const days = Math.max(1, Math.ceil((now - from) / DAY));
  const sum = S.tx.filter(t => t.k === 'out' && t.t >= from).reduce((a, t) => a + (t.s.l || 0), 0);
  if (days < 3 && sum === 0) return null;
  return sum / days;
}

// Пока трат мало: обычный бюджет в день = зарплата минус платежи и Gigly, делённое на 30
function typicalDaily(d){
  if (S.set.salary > 0) {
    const bills = S.set.bills.reduce((s, b) => s + (b.amount || 0), 0);
    return Math.max(0, (S.set.salary - bills - (S.set.giglyCap || 0)) / 30);
  }
  return d.daily;
}

function evGot(ev){ return S.tx.filter(t => t.k === 'in' && t.ev === ev.i).reduce((a, t) => a + t.a, 0); }

// Прогноз наличных на N дней: зарплаты и мероприятия плюс, платежи минус, траты по среднему
function forecast(N = 45){
  const now = sod(new Date()), end = +now + N * DAY;
  const d = today();
  const avg = avgDaily() ?? typicalDaily(d);
  let C = (d.env.l || 0) + d.bills.reduce((s, b) => s + b.saved, 0);
  const items = [];
  for (const b of d.bills) {
    let due = new Date(b.due);
    while (+due < end) {
      items.push({ d:+due, label:`${billEmoji(b)} ${b.name}`, amt:-b.amount, kind:'bill' });
      due = clampDay(due.getFullYear(), due.getMonth() + 1, b.day);
    }
  }
  if (S.set.salary > 0) {
    let sd = cycle().next;
    while (+sd < end) {
      items.push({ d:+sd, label:'💼 Зарплата', amt:S.set.salary - Math.min(S.set.giglyCap || 0, S.set.salary * 0.3), kind:'in' });
      sd = clampDay(sd.getFullYear(), sd.getMonth() + 1, S.set.salaryDay);
    }
  }
  for (const ev of S.ev) {
    const rest = (ev.fee || 0) - evGot(ev);
    if (rest > 0 && ev.d < end) items.push({ d:Math.max(ev.d, +now), label:`🎩 ${ev.name}`, amt:rest * (1 - (S.set.cushionPct || 0) / 100), kind:'ev' });
  }
  // В один день сначала приходы, потом платежи
  items.sort((a, b) => sod(a.d) - sod(b.d) || (a.amt < 0) - (b.amt < 0));
  let prev = +now, gap = null;
  for (const it of items) {
    C -= avg * Math.max(0, (it.d - prev) / DAY);
    prev = Math.max(prev, it.d);
    C += it.amt;
    it.after = C;
    if (C < 0 && !gap) gap = { d:it.d, amount:-C, label:it.label };
  }
  C -= avg * Math.max(0, (end - prev) / DAY);
  return { items, gap, avg, endC:C };
}

function splitText(s){
  return Object.keys(s).filter(e => s[e]).map(e => `${envEmoji(e)} ${envName(e)} ${fmt(s[e])}`).join(' · ');
}

/* ================= Действия ================= */
function addIncome(a, type, ac, note, evId){
  const s = split(a, type);
  const t = { i:uid(), t:Date.now(), k:'in', a, c:type, ac:ac || 'cash', s, n:note || '' };
  if (evId) t.ev = evId;
  S.tx.push(t); save(); haptic();
  render();
  showSpread(t);
}

// После прихода: подсказка, сколько наличных в какой конверт положить
function showSpread(t){
  const rows = Object.keys(t.s).filter(e => t.s[e] > 0);
  openSheet(`
    <h3>✅ +${fmt(t.a)} записал</h3>
    ${rows.some(e => e !== 'l') ? `<p class="muted" style="margin:-4px 0 10px">Разложи наличные по конвертам прямо сейчас, пока они не стали «свободными»:</p>
    <div class="card stack" style="background:var(--bg2)">${rows.map(e => `<div class="kv"><span>${envEmoji(e)} ${esc(envName(e))}</span><b>${fmt(t.s[e])}</b></div>`).join('')}</div>`
    : `<p class="muted">Всё идёт в кошелёк: ${fmt(t.a)}.</p>`}
    <div class="row"><button class="btn pri grow" data-act="close">Разложил 👍</button><button class="btn sm" data-act="undoTx" data-id="${t.i}">Отменить</button></div>`);
}

function addExpense(a, cat, ac, pref){
  cat = cat || 'Другое';
  if (!pref) pref = cat === 'Gigly' ? 'g' : 'l';
  const s = debit(a, pref);
  const t = { i:uid(), t:Date.now(), k:'out', a, c:cat, ac:ac || 'cash', s };
  S.tx.push(t);
  const c = S.cats[cat] || (S.cats[cat] = { n:0, last:0, ac:t.ac });
  c.n++; c.last = a; c.ac = t.ac;
  save(); haptic();
  const d = today();
  toast(d.left >= 0 ? `−${fmt(a)} ${cat}. Сегодня ещё можно ${fmt(d.left)}`
                    : `−${fmt(a)} ${cat}. Сегодня уже сверх на ${fmt(-d.left)}. Не страшно: завтра лимит пересчитается`, [t.i]);
  render();
}

function addPay(id, a, ac){
  const b = billStatus().find(x => x.id === id);
  if (!b) return;
  const t = { i:uid(), t:Date.now(), k:'pay', a, c:id, ac:ac || 'cash', s:debit(a, id), d:+b.due };
  S.tx.push(t);
  const ids = [t.i];
  const leftover = balances().env[id] || 0; // заплатил меньше, чем откладывал
  if (leftover > 0) { const mv = { i:uid(), t:Date.now(), k:'move', a:leftover, f:id, to:'l' }; S.tx.push(mv); ids.push(mv.i); }
  save(); haptic();
  toast(`${b.name}: оплачено ${fmt(a)}` + (leftover > 0 ? `. Лишние ${fmt(leftover)} вернул в кошелёк` : '') + `. Следующий раз до ${ddmm(clampDay(b.due.getFullYear(), b.due.getMonth() + 1, b.day))}`, ids);
  render();
}

function addMove(a, f, to){
  const t = { i:uid(), t:Date.now(), k:'move', a, f, to };
  S.tx.push(t); save(); haptic();
  toast(`${envName(f)} → ${envName(to)}: ${fmt(a)}`, [t.i]);
  render();
}

function undo(ids){ S.tx = S.tx.filter(t => !ids.includes(t.i)); save(); haptic('warning'); render(); }

/* ================= Тост и шторка ================= */
let toastTimer, toastIds = null;
function toast(msg, ids){
  $('#toastMsg').textContent = msg;
  toastIds = ids || null;
  $('#toastUndo').style.display = ids ? '' : 'none';
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), ids ? 6000 : 3500);
}
$('#toastUndo').onclick = () => { if (toastIds) undo(toastIds); toastIds = null; $('#toast').classList.remove('show'); };

let sheetState = {}, E = null, amountCb = null;
function openSheet(html){
  $('#sheetBox').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  if (inTG) try { tg.BackButton.show(); } catch (e) {}
}
function closeSheet(){
  $('#sheet').classList.add('hidden'); sheetState = {}; E = null; amountCb = null;
  if (inTG) try { tg.BackButton.hide(); } catch (e) {}
}
if (inTG) try { tg.BackButton.onClick(closeSheet); } catch (e) {}
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

function confirmAsk(text){
  return new Promise(res => { if (inTG && tg.showConfirm) tg.showConfirm(text, ok => res(ok)); else res(window.confirm(text)); });
}

/* ================= Ввод суммы: своя клавиатура ================= */
function topCats(){
  return Object.entries(S.cats).sort((a, b) => b[1].n - a[1].n || DEF_CATS.indexOf(a[0]) - DEF_CATS.indexOf(b[0])).map(x => x[0]);
}

function openEntry(mode, o = {}){
  E = { mode, amt:o.amt ? String(r0(o.amt)) : '', cat:o.cat || '', type:o.type || 'fee', ac:'cash', env:'l', note:o.note || '', ev:o.ev || '' };
  if (E.cat && S.cats[E.cat]) { if (!E.amt && S.cats[E.cat].last) E.amt = String(S.cats[E.cat].last); E.ac = S.cats[E.cat].ac || 'cash'; }
  if (E.cat === 'Gigly') E.env = 'g';
  if (mode === 'in' && !o.type) E.type = 'fee';
  renderEntry();
}

function pendingEvents(){ return S.ev.filter(ev => (ev.fee || 0) - evGot(ev) > 0).sort((a, b) => a.d - b.d); }

function renderEntry(){
  const out = E.mode === 'out';
  const cats = topCats().slice(0, 11);
  const envs = ['l', 'c', 'g', ...S.set.bills.map(b => b.id)];
  const pe = pendingEvents();
  openSheet(`
    <div class="seg big" style="margin-bottom:6px"><button data-act="eMode" data-m="out" class="${out ? 'on out' : ''}">➖ Потратил</button><button data-act="eMode" data-m="in" class="${!out ? 'on in' : ''}">➕ Получил</button></div>
    <div class="amtView ${E.amt ? '' : 'empty'}" id="eAmt">${E.amt || '0'} <span>zł</span></div>
    ${out ? `<div class="catgrid">${cats.map(c => `<button data-act="eCat" data-cat="${esc(c)}" class="${c === E.cat ? 'on' : ''}"><b>${emo(c)}</b><span>${esc(c)}</span></button>`).join('')}<button data-act="eNewCat"><b>＋</b><span>Своя</span></button></div>
      <div id="eNewWrap" style="display:${E.cat && !cats.includes(E.cat) ? '' : 'none'}"><input id="eNewCat" placeholder="название, например «Шаурма»" value="${E.cat && !cats.includes(E.cat) ? esc(E.cat) : ''}"></div>`
    : `<div class="chips" style="justify-content:center;margin:8px 0">${IN_TYPES.map(([k, v]) => `<button class="chip ${k === E.type ? 'on' : ''}" data-act="eType" data-type="${k}">${v}</button>`).join('')}</div>
      ${pe.length ? `<div class="small muted" style="text-align:center">Это за мероприятие?</div><div class="chips" style="justify-content:center;margin:6px 0">${pe.slice(0, 4).map(ev => `<button class="chip ${E.ev === ev.i ? 'on' : ''}" data-act="eEv" data-id="${ev.i}">🎩 ${esc(ev.name)} · ждёт ${fmt(ev.fee - evGot(ev))}</button>`).join('')}</div>` : ''}`}
    <div class="opts">
      ${S.set.hasCard ? `<button class="chip" data-act="eAc">${ACC[E.ac]}</button>` : ''}
      ${out ? `<button class="chip" data-act="eEnv">из: ${envEmoji(E.env)} ${esc(envName(E.env))}</button>` : ''}
      <button class="chip" data-act="eNote">${E.note ? '✎ ' + esc(E.note) : '＋ комментарий'}</button>
    </div>
    <div id="eNoteWrap" style="display:none"><input id="eNoteIn" placeholder="комментарий" value="${esc(E.note)}"></div>
    ${!out && E.amt ? `<div class="small muted" style="text-align:center" id="ePrev">${esc(splitText(split(num(E.amt), E.type)))}</div>` : `<div class="small muted" style="text-align:center" id="ePrev">${!out ? 'Введи сумму, покажу, как разложу по конвертам' : ''}</div>`}
    <div class="pad">${['1','2','3','4','5','6','7','8','9',',','0','⌫'].map(k => `<button data-act="eKey" data-k="${k}">${k}</button>`).join('')}</div>
    <button class="btn pri full" data-act="eDone" style="${!out ? 'background:var(--ok);color:#fff' : ''}">${out ? 'Записать трату' : 'Записать приход'}</button>`);
  sheetState = { kind:'entry', envs };
}

function entryKey(k){
  tap();
  if (k === '⌫') E.amt = E.amt.slice(0, -1);
  else if (k === ',') { if (!E.amt.includes(',')) E.amt = (E.amt || '0') + ','; }
  else { if (E.amt.includes(',') && E.amt.split(',')[1].length >= 2) return; if (E.amt === '0') E.amt = ''; if (E.amt.replace(',', '').length < 7) E.amt += k; }
  const v = $('#eAmt'); v.innerHTML = `${E.amt || '0'} <span>zł</span>`; v.classList.toggle('empty', !E.amt);
  if (E.mode === 'in') $('#ePrev').textContent = E.amt ? splitText(split(num(E.amt), E.type)) : 'Введи сумму, покажу, как разложу по конвертам';
}

function entryDone(){
  const a = num(E.amt);
  if (a <= 0) { toast('Набери сумму на клавиатуре'); return; }
  const noteEl = $('#eNoteIn'); if (noteEl) E.note = noteEl.value.trim();
  const st = { ...E };
  if (st.mode === 'out') {
    const nc = $('#eNewCat') && $('#eNewCat').value.trim();
    const cat = nc ? cap(nc) : (st.cat || 'Другое');
    closeSheet(); addExpense(a, cat, st.ac, st.env);
  } else {
    closeSheet(); addIncome(a, st.type, st.ac, st.note, st.ev);
  }
}

document.addEventListener('keydown', e => {
  if (!E || e.target.tagName === 'INPUT') return;
  if (/^[0-9]$/.test(e.key)) entryKey(e.key);
  else if (e.key === ',' || e.key === '.') entryKey(',');
  else if (e.key === 'Backspace') entryKey('⌫');
  else if (e.key === 'Enter') entryDone();
});

/* Простая шторка для суммы (отложить, оплатить, взять) */
function askAmount(o, cb){
  amountCb = cb;
  openSheet(`
    <h3>${o.title}</h3>
    ${o.sub ? `<p class="muted" style="margin:-6px 0 10px">${o.sub}</p>` : ''}
    <div class="field"><input id="aAmt" class="amtView" style="font-size:34px;padding:8px" inputmode="decimal" value="${o.value ? r0(o.value) : ''}" placeholder="0"></div>
    ${o.chips && o.chips.length ? `<div class="chips" style="margin-bottom:12px">${o.chips.filter(c => c[1] > 0).map(([l, v]) => `<button class="chip" data-act="aChip" data-v="${r0(v)}">${l}</button>`).join('')}</div>` : ''}
    ${o.extra || ''}
    <button class="btn pri full" data-act="aOk">${o.btn || 'Готово'}</button>`);
  setTimeout(() => { const f = $('#aAmt'); if (f) f.focus(); }, 80);
}

/* ================= Быстрая строка ================= */
function quick(str){
  str = str.trim();
  const m = str.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) { toast('Напиши сумму, например «40 такси»'); return; }
  const a = num(m[1]);
  const word = str.replace(m[0], '').replace(/^\s*[+\-−]\s*/, '').replace(/\s*(zł|zl|злотых|зл)\b/i, '').trim();
  const low = word.toLowerCase();
  if (/^хочу/.test(low)) { wantVerdict(a, cap(word.replace(/^хочу\s*/i, ''))); return; }
  if (/^\s*\+/.test(str) || /^(пришл|получил|зп|зарплат|предопл|задат|аванс|чаев|гонорар|выступ|плюс|gigly доход)/.test(low)) {
    let type = 'other';
    if (/зарплат|^зп/.test(low)) type = 'salary';
    else if (/предопл|задат|аванс/.test(low)) type = 'prepay';
    else if (/чаев/.test(low)) type = 'tips';
    else if (/гонорар|выступ/.test(low)) type = 'fee';
    addIncome(a, type, 'cash', word);
    return;
  }
  let cat = 'Другое';
  if (word) {
    const keys = Object.keys(S.cats);
    cat = keys.find(c => c.toLowerCase() === low) || keys.find(c => c.length >= 4 && low.startsWith(c.toLowerCase().slice(0, 4))) || cap(word);
  }
  addExpense(a, cat, (S.cats[cat] && S.cats[cat].ac) || 'cash');
}

/* ================= «Хочу» ================= */
function wantVerdict(a, name){
  const d = today();
  sheetState = { kind:'want2', a, name };
  const days = d.daily > 0 ? a / d.daily : Infinity;
  const newDaily = Math.max(0, Math.floor((d.free - a) / d.daysLeft));
  let text, btns;
  if (a <= d.left && a <= 50) {
    text = `Влезает в сегодняшние ${fmt(d.left)}. Бери спокойно 🙂`;
    btns = `<button class="btn pri grow" data-act="wantBuy">Купил</button><button class="btn sm" data-act="close">Передумал</button>`;
  } else if (a <= d.free) {
    const dd = isFinite(days) ? `${days.toFixed(days < 10 ? 1 : 0).replace('.', ',')} ${plural(Math.ceil(days), 'день', 'дня', 'дней')}` : 'весь';
    text = `${esc(name || 'Покупка')} за ${fmt(a)} = <b>${dd}</b> твоего лимита.<br>После покупки до ${ddmm(d.next)} останется ${fmt(newDaily)} в день вместо ${fmt(d.daily)}.<br><br>Давай подождём 48 часов. Если желание останется, купишь без вины. Обычно оно проходит само.`;
    btns = `<button class="btn pri grow" data-act="wantWait">Подожду 48 ч</button><button class="btn sm" data-act="wantBuy">Всё-таки купил</button>`;
  } else {
    text = `Свободных сейчас ${fmt(Math.max(0, d.free))}. На ${fmt(a)} пришлось бы брать из конвертов платежей или подушки.<br><br>Положу в список желаний, вернёмся к этому после следующего прихода денег.`;
    btns = `<button class="btn pri grow" data-act="wantWait">В список желаний</button><button class="btn sm" data-act="close">Отмена</button>`;
  }
  openSheet(`<h3>🤔 ${esc(name || 'Хочу')} · ${fmt(a)}</h3><div class="note" style="background:var(--bg2);display:block">${text}</div><div class="row">${btns}</div>`);
}

function sheetWant(){
  let list = '';
  if (S.wish.items.length) list = `<div class="h" style="margin-top:16px">Ждут своего часа</div><div class="list">${S.wish.items.map(w => {
    const h = Math.max(0, 48 - (Date.now() - w.t) / 3600e3);
    return `<div class="it"><div class="em">⏳</div><div class="grow">${esc(w.name || 'Покупка')}<div class="meta">${h > 0 ? 'ещё ' + Math.ceil(h) + ' ч' : 'можно решать'}</div></div><b>${fmt(w.a)}</b><button class="del" data-act="wishSkip" data-id="${w.i}">×</button></div>`; }).join('')}</div>`;
  openSheet(`
    <h3>🤔 Хочу купить</h3>
    <div class="field"><input class="amtView" style="font-size:34px;padding:8px" id="fAmt" inputmode="decimal" placeholder="0"></div>
    <div class="field"><input id="fName" placeholder="что именно? (кроссовки)"></div>
    <button class="btn pri full" data-act="checkWant">Посмотреть, влезает ли</button>${list}`);
}

/* ================= Мероприятия ================= */
function sheetEvent(id){
  const ev = S.ev.find(x => x.i === id) || { i:'', name:'', d:Date.now() + 7 * DAY, fee:'', pre:'' };
  const iso = new Date(ev.d - new Date(ev.d).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const got = ev.i ? evGot(ev) : 0;
  openSheet(`
    <h3>🎩 ${ev.i ? 'Мероприятие' : 'Новое мероприятие'}</h3>
    <div class="field"><label>Что</label><input id="evName" placeholder="Свадьба Анны и Петра" value="${esc(ev.name)}"></div>
    <div class="field"><label>Когда</label><input id="evDate" type="date" value="${iso}"></div>
    <div class="half field"><div><label>Гонорар всего</label><input id="evFee" inputmode="decimal" value="${ev.fee || ''}" placeholder="0"></div><div><label>Предоплата</label><input id="evPre" inputmode="decimal" value="${ev.pre || ''}" placeholder="0"></div></div>
    ${ev.i ? `<p class="muted small">Уже получено: ${fmt(got)} из ${fmt(ev.fee || 0)}</p>` : ''}
    <div class="row"><button class="btn pri grow" data-act="evSave" data-id="${ev.i}">Сохранить</button>${ev.i ? `<button class="btn sm" data-act="evDel" data-id="${ev.i}" style="color:var(--bad)">Удалить</button>` : ''}</div>
    ${ev.i && (ev.fee || 0) - got > 0 ? `<button class="btn sm full" style="margin-top:8px" data-act="evGet" data-id="${ev.i}">➕ Получил деньги за это</button>` : ''}`);
}

/* ================= Экраны ================= */
function viewSetup(){
  const bills = S.set.bills.length ? S.set.bills : [{ id:'rent', name:'Аренда', amount:'', day:'' }, { id:'wife', name:'Жене', amount:'', day:'' }];
  return `
  <div class="card"><h2>👛 Кошелёк</h2>
  <p class="muted" style="margin:0 0 14px">Твой кошелёк и финансовый ассистент. Настройка за 2 минуты, потом всё меняется в «Ещё». Данные хранятся в твоём Telegram, видишь их только ты.</p>
  <div class="field"><label>Зарплата на руки, zł · какого числа (0, если нет)</label><div class="two"><input id="sSalary" inputmode="decimal" placeholder="например 6000" value="${S.set.salary || ''}"><input id="sSalaryDay" inputmode="numeric" placeholder="число" value="${S.set.salary ? S.set.salaryDay : ''}"></div></div>
  <div class="h" style="margin-top:16px">Обязательные платежи</div>
  <div id="billRows">${bills.map(billRow).join('')}</div>
  <button class="btn sm full" data-act="addBillRow" style="margin-bottom:14px">＋ Ещё платёж</button>
  <div class="field"><label>Gigly: максимум в месяц, zł</label><input id="sGigly" inputmode="decimal" placeholder="например 500" value="${S.set.giglyCap || ''}"></div>
  <div class="field"><label>Сколько у тебя сейчас денег всего, zł (вместе с конвертами)</label><input id="sCash" inputmode="decimal" placeholder="0"></div>
  <label class="check"><input type="checkbox" id="sHasCard"> У меня есть ещё деньги на карте</label>
  <div class="field" id="sCardWrap" style="display:none"><label>На карте, zł</label><input id="sCard" inputmode="decimal" placeholder="0"></div>
  <button class="btn pri full" data-act="saveSetup">Готово</button></div>`;
}

function billRow(b){
  return `<div class="billrow" data-bill="${esc(b.id || '')}">
    <div class="row"><input class="bName grow" placeholder="Название (Аренда)" value="${esc(b.name || '')}"><button class="del muted" data-act="delBillRow" style="padding:6px 8px;font-size:18px">×</button></div>
    <div class="half"><input class="bAmt" inputmode="decimal" placeholder="Сумма, zł" value="${b.amount || ''}"><input class="bDay" inputmode="numeric" placeholder="До какого числа" value="${b.day || ''}"></div>
    ${S.set.setup ? '' : `<input class="bSaved" inputmode="decimal" placeholder="Уже отложено в конверт, zł" style="margin-top:6px">`}
  </div>`;
}

function readBillRows(){
  return $$('#billRows .billrow').map(r => ({
    id: r.dataset.bill || 'b' + uid(),
    name: cap(r.querySelector('.bName').value.trim()),
    amount: num(r.querySelector('.bAmt').value),
    day: Math.min(31, Math.max(1, r0(num(r.querySelector('.bDay').value)) || 1)),
    saved: r.querySelector('.bSaved') ? num(r.querySelector('.bSaved').value) : 0
  })).filter(b => b.name && b.amount > 0);
}

function viewHome(){
  const d = today();
  const notes = [];
  if (!S.set.tut) notes.push(`<div class="note ok" style="display:block"><b>Как пользоваться</b>
    <div class="small" style="margin-top:6px;line-height:1.5">1. Потратил наличные → <b>➖ Потратил</b>, набери сумму, нажми категорию.<br>2. Получил деньги → <b>➕ Получил</b>, и я скажу, сколько положить в какой конверт.<br>3. Ещё быстрее: напиши внизу «40 такси» или надиктуй голосом.<br>4. Раз в неделю пересчитай наличные → <b>🧾 Сверка</b>.</div>
    <button class="btn sm" style="margin-top:8px" data-act="tutOk">Понятно</button></div>`);

  // Платежи: сроки и что переложить
  if (d.free < 0) {
    const nb = d.bills.find(x => !x.done && x.remaining > 0);
    notes.push(`<div class="note bad"><span class="ic">🧯</span><div class="grow">На платежи не хватает <b>${fmt(-d.free)}</b>${nb ? ` (ближайший: ${esc(nb.name)}, ${ddmm(nb.due)})` : ''}. Поэтому сейчас «можно» = 0. Каждый следующий приход сначала пойдёт туда, траты по минимуму: еда и дорога.</div></div>`);
  }
  const movable = Math.min(Math.max(0, d.env.l), d.short);
  if (movable > 0) {
    const first = d.bills.find(b => !b.done && b.remaining > 0);
    notes.push(`<div class="note warn"><span class="ic">📥</span><div class="grow">В кошельке лежат деньги платежей: <b>${fmt(movable)}</b>. Переложи их в конверт${first ? ' «' + esc(first.name) + '»' : ''}, чтобы случайно не потратить.</div><button class="btn sm" data-act="stash">Переложил</button></div>`);
  }
  d.bills.forEach(b => {
    if (b.days <= 5 && b.days >= -30) {
      const cls = b.remaining > 0 ? (b.days <= 1 ? 'bad' : 'warn') : 'ok';
      notes.push(`<div class="note ${cls}"><span class="ic">${billEmoji(b)}</span><div class="grow">${esc(b.name)} ${fmt(b.amount)} — <b>${when(b.due)}</b> (${ddmm(b.due)}). ${b.remaining > 0 ? (b.done ? 'Закроется из зарплаты.' : `В конверте ${fmt(b.saved)}, не хватает ${fmt(b.remaining)}.`) : 'В конверте всё есть ✅'}</div><button class="btn sm" data-act="payBill" data-id="${b.id}">Оплатил</button></div>`);
    }
  });
  // Мероприятия: забрать деньги
  S.ev.forEach(ev => {
    const rest = (ev.fee || 0) - evGot(ev), n = daysTo(ev.d);
    if (rest > 0 && n <= 0 && n >= -14) notes.push(`<div class="note"><span class="ic">🎩</span><div class="grow">${esc(ev.name)} прошло. Получил ${fmt(rest)}?</div><button class="btn sm" data-act="evGet" data-id="${ev.i}">Получил</button></div>`);
    else if (n > 0 && n <= 3) notes.push(`<div class="note"><span class="ic">🎩</span><div class="grow">${esc(ev.name)} ${when(ev.d)}. ${rest > 0 ? `Ждёт оплаты ${fmt(rest)}.` : 'Оплачено ✅'}</div></div>`);
  });
  const ready = S.wish.items.filter(w => Date.now() - w.t >= 48 * 3600e3);
  ready.forEach(w => notes.push(`<div class="note"><span class="ic">⏳</span><div class="grow">Прошло 2 дня. Всё ещё хочешь <b>${esc(w.name || 'покупку')}</b> за ${fmt(w.a)}?</div><div class="btns"><button class="btn sm" data-act="wishBuy" data-id="${w.i}">Купил</button><button class="btn sm" data-act="wishSkip" data-id="${w.i}">Не надо</button></div></div>`));
  const dow = new Date().getDay();
  if ((dow === 5 || dow === 6) && d.week > 0) notes.push(`<div class="note"><span class="ic">🎉</span><div>На выходные у тебя ${fmt(d.week)}. Платежи уже учтены, это свободные.</div></div>`);
  const lastCheck = [...S.tx].reverse().find(t => t.k === 'adj' || t.k === 'chk');
  if (S.tx.length > 10 && (!lastCheck || Date.now() - lastCheck.t > 7 * DAY)) notes.push(`<div class="note"><span class="ic">🧾</span><div class="grow">Неделю не сверялся. Пересчитай наличные, это 1 минута.</div><button class="btn sm" data-act="check">Сверка</button></div>`);

  const quickCats = topCats().slice(0, 8);
  const waiting = S.wish.items.length - ready.length;
  const nextBill = d.bills[0];
  return `
  <div class="card hero">
    <div class="lbl">Можно потратить сегодня</div>
    <div class="big">${d.left < 0 ? '0 zł' : fmt(d.left)}</div>
    <div class="sub">${d.left < 0 ? `сегодня сверх на ${fmt(-d.left)} · завтра лимит пересчитается<br>` : ''}лимит ${fmt(d.daily)} в день · до воскресенья ${fmt(d.week)}${S.set.salary > 0 ? ` · зарплата ${ddmm(d.next)}` : ''}</div>
    <div class="tri">
      <div><small>Всего денег</small><b>${fmt(d.total)}</b></div>
      <div><small>На платежи</small><b>${fmt(d.busy)}</b></div>
      <div><small>Свободно</small><b class="${d.free < 0 ? 'minus' : ''}">${fmt(d.free)}</b></div>
    </div>
  </div>
  <div class="main2">
    <button class="btn out" data-act="out">➖ Потратил</button>
    <button class="btn in" data-act="in">➕ Получил</button>
  </div>
  <div class="acts">
    <button class="btn" data-act="want"><b>🤔</b>Хочу${waiting ? ` (${waiting})` : ''}</button>
    <button class="btn" data-act="stashAny"><b>📥</b>Отложить</button>
    <button class="btn" data-act="check"><b>🧾</b>Сверка</button>
    <button class="btn" data-act="newEv"><b>🎩</b>Заказ</button>
  </div>
  ${notes.join('')}
  ${nextBill ? `<div class="card" data-act="goEnv" style="cursor:pointer"><div class="h">Ближайший платёж <span class="pill ${nextBill.remaining > 0 && nextBill.days <= 5 ? 'warn' : ''}">${when(nextBill.due)}</span></div>
    <div class="row"><div class="env-ic">${billEmoji(nextBill)}</div><div class="grow"><b>${esc(nextBill.name)} · ${fmt(nextBill.amount)}</b><div class="small muted">оплатить до ${ddmm(nextBill.due)} · в конверте ${fmt(nextBill.saved)}</div></div></div>
    <div class="bar ${nextBill.remaining ? '' : 'ok'}"><i style="width:${Math.min(100, nextBill.saved / nextBill.amount * 100)}%"></i></div>
    ${nextBill.remaining > 0 ? `<div class="small muted" style="margin-top:6px">${nextBill.done ? `Закроется из зарплаты ${ddmm(today().next)}` : `Осталось отложить ${fmt(nextBill.remaining)}: это по ${fmt(nextBill.perDay)} в день`}</div>` : ''}</div>` : ''}
  <div class="card"><div class="h">Частые траты · одно нажатие</div><div class="chips">${quickCats.map(c => `<button class="chip" data-act="outCat" data-cat="${esc(c)}">${emo(c)} ${esc(c)}${S.cats[c].last ? ' · ' + r0(S.cats[c].last) : ''}</button>`).join('')}</div>
    <form class="quick" id="quickForm" style="margin-top:10px"><input id="quickIn" placeholder="или напиши: 40 такси · +500 предоплата" autocomplete="off" enterkeyhint="done"><button class="btn sm pri" style="padding:0 14px">↵</button></form>
  </div>`;
}

function viewEnv(){
  const d = today(), env = d.env;
  const bills = d.bills;
  const stack = [['l', env.l], ...bills.map(b => [b.id, b.saved]), ['c', env.c], ['g', env.g]];
  if (Math.abs(env.m || 0) > 0.5) stack.push(['m', env.m]);
  return `
  <div class="card"><div class="h">Всего денег <b style="color:var(--tx);font-size:17px;text-transform:none">${fmt(d.total)}</b></div>
    <div class="stack">${stack.map(([k, v]) => `<div class="kv"><span>${envEmoji(k)} ${esc(envName(k))}</span><b>${fmt(v)}</b></div>`).join('')}</div>
    ${S.set.hasCard ? `<div class="small muted" style="margin-top:8px">💵 наличные ${fmt(d.acc.cash)} · 💳 карта ${fmt(d.acc.card)}</div>` : ''}
    <div class="row" style="margin-top:10px"><button class="btn sm grow" data-act="move">↔ Переложить</button><button class="btn sm grow" data-act="check">🧾 Сверка</button>${S.set.hasCard ? '<button class="btn sm grow" data-act="xfer">⇄ Снял</button>' : ''}</div>
  </div>
  <div class="card"><div class="h">Платежи <button data-act="goSet">＋ добавить</button></div>
  ${bills.length ? bills.map(b => {
    const pct = Math.min(100, b.saved / b.amount * 100);
    const pill = b.days < 0 ? `<span class="pill bad">просрочено</span>` : b.remaining === 0 ? `<span class="pill ok">собрано</span>` : b.days <= 5 ? `<span class="pill warn">${when(b.due)}</span>` : `<span class="pill">${when(b.due)}</span>`;
    return `<div class="env-item">
      <div class="env-top"><div class="env-ic">${billEmoji(b)}</div><div class="grow"><b>${esc(b.name)}</b> ${pill}<div class="small muted">до ${ddmm(b.due)} (${wday(b.due)}) · ${fmt(b.amount)}</div></div><b>${fmt(b.saved)}</b></div>
      <div class="bar ${b.remaining ? '' : 'ok'}"><i style="width:${pct}%"></i></div>
      ${b.remaining > 0 ? `<div class="small muted" style="margin-top:6px">${b.done
        ? `Закроется из зарплаты ${ddmm(d.next)}. Для подстраховки можно откладывать по ${fmt(b.perDay)} в день.`
        : `Осталось ${fmt(b.remaining)} → откладывай по <b style="color:var(--tx)">${fmt(b.perDay)}</b> в день. Каждый приход сначала идёт сюда.`}</div>` : ''}
      <div class="env-act"><button class="btn sm pri" data-act="stashBill" data-id="${b.id}">📥 Отложить</button><button class="btn sm" data-act="payBill" data-id="${b.id}">✅ Оплатил</button>${b.saved > 0 ? `<button class="btn sm" data-act="takeEnv" data-id="${b.id}">↩ Взять</button>` : ''}</div>
    </div>`; }).join('') : '<p class="muted">Платежей нет. Добавь аренду и другие обязательные платежи.</p>'}
  </div>
  <div class="card"><div class="h">Свои конверты</div>
    <div class="env-item"><div class="env-top"><div class="env-ic">🛟</div><div class="grow"><b>Подушка</b><div class="small muted">цель ${fmt(S.set.cushionGoal)} · ${S.set.cushionPct}% с каждого нерегулярного прихода</div></div><b>${fmt(env.c)}</b></div>
      <div class="bar ok"><i style="width:${Math.min(100, Math.max(0, env.c) / (S.set.cushionGoal || 1) * 100)}%"></i></div>
      <div class="env-act"><button class="btn sm" data-act="stashEnv" data-id="c">📥 Отложить</button>${env.c > 0 ? '<button class="btn sm" data-act="takeEnv" data-id="c">↩ Взять</button>' : ''}</div></div>
    <div class="env-item"><div class="env-top"><div class="env-ic">🚀</div><div class="grow"><b>Gigly</b><div class="small muted">${S.set.giglyCap ? `в этом месяце ${fmt(giglyThisMonth())} из ${fmt(S.set.giglyCap)}` : 'лимит не задан'}</div></div><b>${fmt(env.g)}</b></div>
      <div class="env-act"><button class="btn sm" data-act="outCat" data-cat="Gigly">➖ Потратил на Gigly</button>${env.g > 0 ? '<button class="btn sm" data-act="takeEnv" data-id="g">↩ Взять</button>' : ''}</div></div>
  </div>`;
}

let statPeriod = '30', aiSec = 'plan';
function viewAI(){
  return `<div class="seg tabs">${[['plan','План'],['spend','Траты'],['biz','Бизнес']].map(([k, v]) => `<button data-act="aiSec" data-s="${k}" class="${aiSec === k ? 'on' : ''}">${v}</button>`).join('')}</div>` +
    (aiSec === 'plan' ? viewPlan() : aiSec === 'spend' ? viewSpend() : viewBiz());
}

function viewPlan(){
  const d = today(), fc = forecast(45), avg = fc.avg;
  const tips = [];
  // Главный вывод
  if (fc.gap) tips.push(['⚠️', `Около ${ddmm(fc.gap.d)} (${esc(fc.gap.label)}) может не хватить ~${fmt(fc.gap.amount)}. Есть ${dn(Math.max(0, daysTo(fc.gap.d)))}: если тратить на ${fmt(fc.gap.amount / Math.max(1, daysTo(fc.gap.d)))} в день меньше, дыры не будет.`]);
  else tips.push(['✅', `На 45 дней вперёд дыр не видно при расходе ~${fmt(avg)} в день.`]);
  if (d.free > 0 && avg > 0) {
    const lasts = Math.floor(d.free / avg);
    tips.push(['⏱️', `Свободных ${fmt(d.free)} при твоём темпе хватит на ${dn(lasts)}${lasts < d.daysLeft ? `, а до ${ddmm(d.next)} ещё ${dn(d.daysLeft)}. Держись лимита ${fmt(d.daily)} в день` : ' — с запасом до ' + ddmm(d.next)}.`]);
  }
  const unpaid = d.bills.filter(b => b.remaining > 0 && !b.done);
  d.bills.filter(b => b.remaining > 0 && b.done && b.days <= 7).forEach(b => tips.push([billEmoji(b), `${esc(b.name)} ${ddmm(b.due)} закроется из зарплаты: отложи ${fmt(b.remaining)} в конверт сразу, как она придёт.`]));
  unpaid.slice(0, 3).forEach(b => tips.push([billEmoji(b), `${esc(b.name)}: до ${ddmm(b.due)} осталось отложить ${fmt(b.remaining)}, по ${fmt(b.perDay)} в день.`]));
  if (d.env.c < S.set.cushionGoal) tips.push(['🛟', `Подушка ${fmt(Math.max(0, d.env.c))} из ${fmt(S.set.cushionGoal)}. Это деньги на непредвиденное, чтобы не трогать аренду.`]);
  const up = S.ev.filter(ev => ev.d >= +sod(new Date()) && (ev.fee || 0) - evGot(ev) > 0);
  if (up.length) tips.push(['🎩', `Ждёшь денег за мероприятия: ${fmt(up.reduce((s, ev) => s + ev.fee - evGot(ev), 0))} (${up.length} шт.). В прогнозе они учтены за вычетом подушки.`]);

  const evList = [...S.ev].sort((a, b) => a.d - b.d).filter(ev => ev.d >= Date.now() - 30 * DAY || (ev.fee || 0) - evGot(ev) > 0);
  return `
  <div class="card"><div class="h">Ассистент говорит</div>${tips.map(([i, t]) => `<div class="tip"><span class="ic">${i}</span><span>${t}</span></div>`).join('')}</div>
  <div class="card tl"><div class="h">Календарь на 45 дней <span class="small" style="text-transform:none">в кошельке и конвертах после события</span></div>
  ${fc.items.length ? `<div class="list">${fc.items.map(it => {
    const dt = new Date(it.d);
    return `<div class="it"><div class="date"><b>${dt.getDate()}</b>${MONTHS[dt.getMonth()]}</div><div class="grow">${esc(it.label)}<div class="meta">≈ останется ${fmt(it.after)}</div></div><b class="${it.amt < 0 ? '' : 'plus'} ${it.after < 0 ? 'minus' : ''}">${it.amt < 0 ? '−' : '+'}${fmt(Math.abs(it.amt))}</b></div>`; }).join('')}</div>
  <p class="small muted" style="margin:8px 0 0">Между событиями вычитаю твой средний расход ~${fmt(avg)} в день. Это прогноз, не обещание.</p>` : '<p class="muted">Добавь платежи и мероприятия, и здесь появится календарь.</p>'}</div>
  <div class="card"><div class="h">Мероприятия <button data-act="newEv">＋ добавить</button></div>
  ${evList.length ? `<div class="list">${evList.map(ev => {
    const got = evGot(ev), rest = (ev.fee || 0) - got;
    return `<div class="it" data-act="openEv" data-id="${ev.i}" style="cursor:pointer"><div class="em">🎩</div><div class="grow">${esc(ev.name)}<div class="meta">${ddmm(ev.d)} · ${when(ev.d)}</div></div><div style="text-align:right"><b>${fmt(ev.fee || 0)}</b><div class="meta">${rest > 0 ? 'ждёт ' + fmt(rest) : 'оплачено ✅'}</div></div></div>`; }).join('')}</div>`
  : '<p class="muted small">Записывай заказы с датой, гонораром и предоплатой. Я напомню забрать деньги и учту их в прогнозе.</p>'}</div>`;
}

function viewSpend(){
  const now = Date.now(), { start } = cycle();
  const periods = { '7':7 * DAY, '30':30 * DAY, 'cycle':now - +start };
  const len = Math.max(DAY, periods[statPeriod]);
  const from = statPeriod === 'cycle' ? +start : +sod(now - len + DAY);
  const prevFrom = from - len;
  const firstT = S.tx.length ? S.tx[0].t : now;
  const realFrom = Math.max(from, +sod(Math.min(S.set.since || firstT, firstT)));
  const days = Math.max(1, Math.ceil((now - realFrom) / DAY));
  const inP = (t, a, b) => t.t >= a && t.t < b;
  const cur = S.tx.filter(t => inP(t, from, now + 1)), prev = S.tx.filter(t => inP(t, prevFrom, from));
  const outs = cur.filter(t => t.k === 'out');
  const spent = outs.reduce((a, t) => a + t.a, 0);
  const lifeSpent = outs.reduce((a, t) => a + (t.s.l || 0), 0);
  const income = cur.filter(t => t.k === 'in' && t.c !== 'start').reduce((a, t) => a + t.a, 0);
  const paid = cur.filter(t => t.k === 'pay').reduce((a, t) => a + t.a, 0);
  const unrec = cur.filter(t => t.k === 'adj' && t.a < 0).reduce((a, t) => a - t.a, 0);
  const byCat = {}; outs.forEach(t => byCat[t.c] = (byCat[t.c] || 0) + t.a);
  const prevCat = {}; prev.filter(t => t.k === 'out').forEach(t => prevCat[t.c] = (prevCat[t.c] || 0) + t.a);
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 1;
  const wd = [0,0,0,0,0,0,0], wdN = [0,0,0,0,0,0,0];
  for (let x = sod(realFrom); x <= now; x = new Date(+x + DAY)) wdN[(x.getDay() + 6) % 7]++;
  outs.forEach(t => wd[(new Date(t.t).getDay() + 6) % 7] += t.a);
  const wdAvg = wd.map((v, i) => wdN[i] ? v / wdN[i] : 0);
  const wdMax = Math.max(1, ...wdAvg);
  const d = today();
  const avg = lifeSpent / days;
  const small = outs.filter(t => t.a <= 30);
  const smallSum = small.reduce((a, t) => a + t.a, 0);
  const skipped = S.wish.skipped.filter(w => w.t >= from).reduce((a, w) => a + w.a, 0);
  const ins = [];
  if (!outs.length) ins.push(['📝', 'За этот период трат ещё нет. Записывай, и через пару дней здесь появятся выводы.']);
  else {
    if (avg > d.daily && d.daily > 0) ins.push(['📈', `В среднем ${fmt(avg)} в день при лимите ${fmt(d.daily)}. Срежь ${fmt(avg - d.daily)} в день, и дотянешь до ${ddmm(d.next)} спокойно.`]);
    else ins.push(['👍', `Темп в норме: в среднем ${fmt(avg)} в день, лимит ${fmt(d.daily)}.`]);
    if (cats.length > 1 && cats[0][1] / spent > 0.35) ins.push([emo(cats[0][0]), `${esc(cats[0][0])} — ${r0(cats[0][1] / spent * 100)}% всех трат. Если срезать треть, это ${fmt(cats[0][1] / 3)} за период.`]);
    if (small.length >= 5) ins.push(['🪙', `Мелочь до 30 zł: ${small.length} раз, вместе ${fmt(smallSum)}. По одной незаметно, вместе заметно.`]);
    const wkEnd = (wdAvg[5] + wdAvg[6]) / 2, wkDay = wdAvg.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    if (wkDay > 0 && wkEnd / wkDay >= 1.5) ins.push(['🎉', `В выходные тратишь в ${(wkEnd / wkDay).toFixed(1).replace('.', ',')} раза больше, чем в будни. В пятницу бери с собой только выходную сумму, остальное оставь дома.`]);
    const grow = cats.filter(([c, v]) => prevCat[c] && v > prevCat[c] * 1.4 && v - prevCat[c] > 50)[0];
    if (grow && statPeriod !== 'cycle') ins.push(['↗️', `${esc(grow[0])}: ${fmt(grow[1])}, в прошлом периоде было ${fmt(prevCat[grow[0]])}.`]);
  }
  if (skipped > 0) ins.push(['💪', `Удержался от покупок на ${fmt(skipped)}.`]);
  if (unrec > 0) ins.push(['❔', `При сверке не нашлось ${fmt(unrec)}. Это траты, которые прошли мимо записей. Попробуй записывать сразу у кассы.`]);
  return `
  <div class="seg" style="margin-bottom:10px;background:var(--bg)">${[['7','7 дней'],['30','30 дней'],['cycle','С зарплаты']].map(([k, v]) => `<button data-act="period" data-p="${k}" class="${k === statPeriod ? 'on' : ''}">${v}</button>`).join('')}</div>
  <div class="card"><div class="stats">
    <div><small>Пришло</small><b class="plus">${fmt(income)}</b></div>
    <div><small>Потрачено</small><b>${fmt(spent)}</b></div>
    <div><small>Платежи</small><b>${fmt(paid)}</b></div>
  </div></div>
  <div class="card"><div class="h">Выводы</div>${ins.map(([i, t]) => `<div class="tip"><span class="ic">${i}</span><span>${t}</span></div>`).join('')}</div>
  ${cats.length ? `<div class="card"><div class="h">Куда ушло</div>${cats.map(([c, v]) => `
    <div class="cat"><div class="row"><span class="grow">${emo(c)} ${esc(c)}</span><span class="muted">${r0(v / spent * 100)}%</span>&nbsp;<b>${fmt(v)}</b></div><div class="bar"><i style="width:${v / maxCat * 100}%"></i></div></div>`).join('')}</div>` : ''}
  ${outs.length ? `<div class="card"><div class="h">Средний расход по дням недели</div><div class="cols">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((n, i) => `<div><span>${wdAvg[i] ? r0(wdAvg[i]) : ''}</span><i style="height:${wdAvg[i] / wdMax * 66}px"></i>${n}</div>`).join('')}</div></div>` : ''}`;
}

// Сезонность рынка мероприятий в Польше (оценка: свадьбы май–сентябрь, студниовки янв–фев, корпоративы и Sylwester в декабре)
const SEASON = [3, 3, 1, 2, 4, 5, 5, 5, 5, 3, 2, 4];
const MONTH_TIP = [
  'Студниовки в разгаре, а пары ищут подрядчиков на лето. Отвечай на заявки в тот же день: кто ответил первым, того и бронируют.',
  'Последние студниовки и пик поиска подрядчиков на свадьбы. Зафиксируй цены на сезон и бери предоплату сразу при бронировании.',
  'Самый тихий месяц. Живи на подушке и не трать предоплаты за лето заранее. Хорошее время для Gigly и контента.',
  'Подготовка к сезону: реквизит, костюм, техника. В мае комунии: предложи детское шоу родителям и площадкам.',
  'Старт сезона свадеб и комуний. Деньги начинают приходить: каждый раз сразу часть в подушку.',
  'Сезон. С каждого прихода сначала подушка: зима будет тише, деньги лета должны дожить до марта. Проси отзыв и видео после каждой свадьбы.',
  'Пик сезона. Не поднимай расходы вслед за доходами: держи прежний лимит, разницу в подушку.',
  'Пик сезона. Начинай продавать декабрь: корпоративы (wigilie firmowe) и Sylwester бронируют за 2–4 месяца.',
  'Последние свадьбы. Активно продавай декабрь и январь: корпоративы, Sylwester, студниовки. И свадьбы следующего года.',
  'Хэллоуин и осенние вечеринки. Сейчас главное — продать декабрь и январь. Пары, которые женятся следующим летом, выбирают подрядчиков уже сейчас.',
  'Andrzejki и первые корпоративы. Свадеб почти нет: держи траты ниже лимита, подушка нужна на февраль–март.',
  'Корпоративы и Sylwester, гонорары выше обычного. Отложи больше в подушку: впереди спокойные февраль и март.'
];

function viewBiz(){
  const now = new Date(), m = now.getMonth();
  // Доход по месяцам за последние 12 месяцев (без зарплаты и стартового остатка)
  const inc = Array(12).fill(0);
  S.tx.filter(t => t.k === 'in' && !['salary','start'].includes(t.c) && t.t > Date.now() - 365 * DAY).forEach(t => inc[new Date(t.t).getMonth()] += t.a);
  const hasInc = inc.some(v => v > 0);
  const maxInc = Math.max(1, ...inc);
  const fees = S.ev.filter(ev => ev.fee > 0).map(ev => ev.fee);
  const avgFee = fees.length ? fees.reduce((a, b) => a + b, 0) / fees.length : 0;
  const gIn = S.tx.filter(t => t.k === 'in' && t.c === 'gigly').reduce((a, t) => a + t.a, 0);
  const gOut = S.tx.filter(t => t.k === 'out' && (t.c === 'Gigly' || t.s.g)).reduce((a, t) => a + t.a, 0);
  const mFrom = +new Date(now.getFullYear(), now.getMonth(), 1);
  const gOutM = S.tx.filter(t => t.k === 'out' && t.t >= mFrom && (t.c === 'Gigly' || t.s.g)).reduce((a, t) => a + t.a, 0);
  const nextMonths = [1, 2, 3].map(k => (m + k) % 12);
  const lowAhead = nextMonths.filter(x => SEASON[x] <= 2);
  const tips = [
    ['📅', `<b>${cap(now.toLocaleDateString('ru-RU', {month:'long'}))}:</b> ${MONTH_TIP[m]}`],
  ];
  if (lowAhead.length) tips.push(['🧊', `Впереди тихие месяцы (${lowAhead.map(x => MONTHS[x]).join(', ')}). Сейчас лучше откладывать в подушку больше обычного: подними процент в «Ещё» до 30%.`]);
  tips.push(['💰', `Средняя цена иллюзиониста в Польше около 2 800 zł нетто, обычно от 1 800 до 3 900 (Oferteo, 2026). ${avgFee ? `Твой средний гонорар по записанным заказам: ${fmt(avgFee)}.` : 'Записывай заказы, и я сравню твой средний гонорар с рынком.'} Ведущий и шоу в одном пакете стоят дороже, чем по отдельности.`]);
  tips.push(['📝', 'Предоплату фиксируй в договоре как невозвратный задаток (zadatek). Тогда при отмене деньги остаются у тебя.']);
  tips.push(['🎬', 'После каждого мероприятия проси у пары отзыв и 1–2 видео. Это бесплатная реклама на следующий сезон.']);
  tips.push(['📦', 'Сделай 3 пакета: «ведущий», «ведущий + фокусы», «всё + детское шоу». Большинство клиентов выбирает средний.']);
  tips.push(['🤝', 'Раз в квартал напиши площадкам, где уже работал. Площадки приводят повторные заказы без затрат на рекламу.']);
  return `
  <div class="card"><div class="h">Сезонность рынка мероприятий</div>
    <div class="cols">${SEASON.map((v, i) => `<div class="${i === m ? 'now' : ''}"><i style="height:${v / 5 * 66}px"></i>${MONTHS[i]}</div>`).join('')}</div>
    <p class="small muted" style="margin:8px 0 0">Примерный спрос: свадьбы май–сентябрь, студниовки январь–февраль, корпоративы и Sylwester в декабре.</p>
  </div>
  ${hasInc ? `<div class="card"><div class="h">Твой доход от мероприятий по месяцам</div><div class="cols">${inc.map((v, i) => `<div class="${i === m ? 'now' : ''}"><span>${v ? r0(v / 100) / 10 + 'k' : ''}</span><i style="height:${v / maxInc * 66}px"></i>${MONTHS[i]}</div>`).join('')}</div></div>` : ''}
  <div class="card"><div class="h">Советы для бизнеса</div>${tips.map(([i, t]) => `<div class="tip"><span class="ic">${i}</span><span>${t}</span></div>`).join('')}</div>
  <div class="card"><div class="h">Gigly: вложено и вернулось</div>
    <div class="stats"><div><small>Вложено всего</small><b>${fmt(gOut)}</b></div><div><small>Вернулось</small><b class="plus">${fmt(gIn)}</b></div><div><small>В этом месяце</small><b>${fmt(gOutM)}</b></div></div>
    <p class="small muted" style="margin:10px 0 0">${S.set.giglyCap ? `Лимит ${fmt(S.set.giglyCap)} в месяц: проект растёт, а аренда и еда защищены.` : 'Задай лимит Gigly в «Ещё», чтобы проект не съедал деньги на жизнь.'} Доход от проекта записывай как «От Gigly», тогда здесь будет видно, когда он начнёт окупаться.</p>
  </div>`;
}

function txLine(t){
  let icon, title, amount, meta = [];
  if (t.k === 'in') { icon = '➕'; title = IN_NAME[t.c] || 'Пришло'; amount = `<b class="plus">+${fmt(t.a)}</b>`; meta.push(splitText(t.s)); if (t.n) meta.unshift(esc(t.n)); if (t.ev) { const ev = S.ev.find(x => x.i === t.ev); if (ev) meta.unshift('🎩 ' + esc(ev.name)); } }
  else if (t.k === 'out') { icon = emo(t.c); title = esc(t.c); amount = `<b>−${fmt(t.a)}</b>`; if (!t.s.l || Object.keys(t.s).length > 1) meta.push('из ' + Object.keys(t.s).map(e => envName(e)).join(' + ')); }
  else if (t.k === 'pay') { const b = S.set.bills.find(x => x.id === t.c); icon = b ? billEmoji(b) : (t.c === 'rent' ? '🔑' : '📌'); title = b ? esc(b.name) : (t.c === 'rent' ? 'Аренда' : t.c === 'wife' ? 'Жене' : 'Платёж'); amount = `<b>−${fmt(t.a)}</b>`; if (t.d) meta.push('за ' + ddmm(t.d)); }
  else if (t.k === 'move') { icon = '↔'; title = `${esc(envName(t.f))} → ${esc(envName(t.to))}`; amount = fmt(t.a); }
  else if (t.k === 'xfer') { icon = '⇄'; title = t.f === 'card' ? 'Снял наличные' : 'Положил на карту'; amount = fmt(t.a); }
  else if (t.k === 'adj') { icon = '❔'; title = 'Сверка: ' + (t.a < 0 ? 'неучтённое' : 'нашлось'); amount = `<b class="${t.a > 0 ? 'plus' : ''}">${t.a > 0 ? '+' : '−'}${fmt(Math.abs(t.a))}</b>`; }
  else if (t.k === 'chk') { icon = '🧾'; title = 'Сверка: всё сошлось'; amount = ''; }
  if (S.set.hasCard && t.ac) meta.push(t.ac === 'cash' ? 'нал' : 'карта');
  const time = new Date(t.t).toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'});
  return `<div class="it"><div class="em">${icon}</div><div class="grow"><div>${title}</div><div class="meta">${time}${meta.length ? ' · ' + meta.join(' · ') : ''}</div></div>${amount}<button class="del" data-act="delTx" data-id="${t.i}">×</button></div>`;
}

let histFilter = 'all';
function viewHist(){
  const f = { all:() => true, out:t => t.k === 'out', in:t => t.k === 'in', env:t => ['pay','move','adj','xfer','chk'].includes(t.k) }[histFilter];
  const txs = [...S.tx].reverse().filter(f).slice(0, 400);
  const seg = `<div class="seg" style="margin-bottom:10px;background:var(--bg)">${[['all','Всё'],['out','Траты'],['in','Приходы'],['env','Конверты']].map(([k, v]) => `<button data-act="hf" data-f="${k}" class="${k === histFilter ? 'on' : ''}">${v}</button>`).join('')}</div>`;
  if (!txs.length) return seg + `<div class="card muted">Пока пусто. Нажми «➖ Потратил» на главной.</div>`;
  const out = [seg]; let lastDay = '';
  txs.forEach(t => {
    const day = new Date(t.t).toLocaleDateString('ru-RU', {weekday:'short', day:'numeric', month:'long'});
    if (day !== lastDay) {
      if (lastDay) out.push('</div>');
      const sum = txs.filter(x => x.k === 'out' && new Date(x.t).toDateString() === new Date(t.t).toDateString()).reduce((a, x) => a + x.a, 0);
      out.push(`<div class="day">${day}${sum ? ' · потрачено ' + fmt(sum) : ''}</div><div class="card list">`); lastDay = day;
    }
    out.push(txLine(t));
  });
  out.push('</div>');
  return out.join('');
}

function viewSet(){
  const s = S.set;
  return `
  <div class="card"><div class="h">Доход</div>
    <div class="field"><label>Зарплата на руки · какого числа (0 — нет зарплаты)</label><div class="two"><input id="sSalary" inputmode="decimal" value="${s.salary}"><input id="sSalaryDay" inputmode="numeric" value="${s.salaryDay}"></div></div>
  </div>
  <div class="card"><div class="h">Обязательные платежи</div>
    <div id="billRows">${s.bills.map(billRow).join('')}</div>
    <button class="btn sm full" data-act="addBillRow">＋ Ещё платёж</button>
  </div>
  <div class="card"><div class="h">Конверты</div>
    <div class="field"><label>Gigly, максимум в месяц</label><input id="sGigly" inputmode="decimal" value="${s.giglyCap}"></div>
    <div class="field"><label>% в подушку с нерегулярных доходов · цель подушки</label><div class="half"><input id="sCushPct" inputmode="numeric" value="${s.cushionPct}"><input id="sCushGoal" inputmode="decimal" value="${s.cushionGoal}"></div></div>
    <label class="check"><input type="checkbox" id="sHasCard" ${s.hasCard ? 'checked' : ''}> Учитывать ещё и карту</label>
  </div>
  <button class="btn pri full" data-act="saveSet" style="margin-bottom:10px">Сохранить настройки</button>
  <div class="card"><div class="h">Категории · нажми, чтобы убрать</div><div class="chips">${topCats().map(c => `<button class="chip" data-act="delCat" data-cat="${esc(c)}">${emo(c)} ${esc(c)} <span class="muted">${S.cats[c].n}</span></button>`).join('')}</div>
    <p class="muted small" style="margin:10px 0 0">Новые категории появляются сами, когда пишешь «35 шаурма» или жмёшь «＋ Своя». Чем чаще трата, тем выше её кнопка.</p></div>
  <div class="card"><div class="h">Данные</div>
    <p class="muted small" style="margin:0 0 10px">${hasCloud ? 'Хранятся в облаке Telegram и привязаны к твоему аккаунту. Сервера нет, сторонним сервисам ничего не отправляется.' : 'Сейчас открыто вне Telegram: данные только в этом браузере.'} Записей: ${S.tx.length}.</p>
    <div class="row"><button class="btn sm grow" data-act="export">Скопировать копию</button><button class="btn sm grow" data-act="import">Вставить копию</button></div>
    <button class="btn sm full" data-act="reset" style="color:var(--bad);margin-top:8px">Стереть всё</button>
  </div>
  <p class="muted small" style="text-align:center">Кошелёк v2</p>`;
}

function render(){
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#nav').style.display = S.set.setup ? '' : 'none';
  const v = !S.set.setup ? viewSetup() : tab === 'home' ? viewHome() : tab === 'env' ? viewEnv() : tab === 'ai' ? viewAI() : tab === 'hist' ? viewHist() : viewSet();
  $('#app').innerHTML = v;
  const qf = $('#quickForm');
  if (qf) qf.onsubmit = e => { e.preventDefault(); const q = $('#quickIn'); if (q.value.trim()) { quick(q.value); const q2 = $('#quickIn'); if (q2) q2.value = ''; } };
  const hc = $('#sHasCard');
  if (hc && !S.set.setup) hc.onchange = () => { $('#sCardWrap').style.display = hc.checked ? '' : 'none'; };
}

/* ================= Обработчики ================= */
function readSettings(){
  const g = id => { const el = $('#' + id); return el ? num(el.value) : 0; };
  S.set.salary = g('sSalary');
  S.set.salaryDay = Math.min(31, Math.max(1, r0(g('sSalaryDay')) || 1));
  S.set.giglyCap = g('sGigly');
  if ($('#sCushPct')) { S.set.cushionPct = Math.min(90, Math.max(0, r0(g('sCushPct')))); S.set.cushionGoal = g('sCushGoal') || 500; }
  if ($('#sHasCard')) S.set.hasCard = $('#sHasCard').checked;
  const rows = readBillRows();
  const keep = new Set(rows.map(r => r.id));
  const old = S.set.bills;
  S.set.bills = rows.map(r => { const o = old.find(b => b.id === r.id); return { id:r.id, name:r.name, amount:r.amount, day:r.day, from:(o && o.from) || Date.now(), emoji:o && o.emoji }; });
  // Деньги из удалённых конвертов возвращаем в кошелёк
  const env = balances().env;
  old.filter(b => !keep.has(b.id) && (env[b.id] || 0) > 0).forEach(b => S.tx.push({ i:uid(), t:Date.now(), k:'move', a:env[b.id], f:b.id, to:'l' }));
  return rows;
}

document.addEventListener('click', async e => {
  const navB = e.target.closest('#nav button');
  if (navB) { tab = navB.dataset.tab; render(); window.scrollTo(0, 0); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;

  switch (act) {
    case 'close': closeSheet(); break;
    case 'tutOk': S.set.tut = true; save(); render(); break;
    case 'goEnv': tab = 'env'; render(); window.scrollTo(0, 0); break;
    case 'goSet': tab = 'set'; render(); window.scrollTo(0, 0); break;

    /* ввод */
    case 'out': openEntry('out'); break;
    case 'in': openEntry('in'); break;
    case 'outCat': openEntry('out', { cat:b.dataset.cat }); break;
    case 'eMode': { const keep = E.amt; openEntry(b.dataset.m); E.amt = keep; renderEntry(); break; }
    case 'eKey': entryKey(b.dataset.k); break;
    case 'eCat': {
      tap(); E.cat = b.dataset.cat;
      const c = S.cats[E.cat];
      if (c && c.last && !E.amt) E.amt = String(c.last);
      if (c && c.ac) E.ac = c.ac;
      E.env = E.cat === 'Gigly' ? 'g' : 'l';
      renderEntry(); break;
    }
    case 'eNewCat': { $('#eNewWrap').style.display = ''; $$('.catgrid button').forEach(x => x.classList.remove('on')); b.classList.add('on'); E.cat = ''; setTimeout(() => $('#eNewCat').focus(), 50); break; }
    case 'eType': tap(); E.type = b.dataset.type; renderEntry(); break;
    case 'eEv': {
      tap();
      const ev = S.ev.find(x => x.i === id);
      if (E.ev === id) E.ev = '';
      else { E.ev = id; const got = evGot(ev); E.type = got === 0 && ev.pre ? 'prepay' : 'fee'; if (!E.amt) E.amt = String(r0(got === 0 && ev.pre ? ev.pre : ev.fee - got)); }
      renderEntry(); break;
    }
    case 'eAc': E.ac = E.ac === 'cash' ? 'card' : 'cash'; b.textContent = ACC[E.ac]; break;
    case 'eEnv': { const list = sheetState.envs; E.env = list[(list.indexOf(E.env) + 1) % list.length]; b.textContent = `из: ${envEmoji(E.env)} ${envName(E.env)}`; break; }
    case 'eNote': { const w = $('#eNoteWrap'); w.style.display = ''; setTimeout(() => $('#eNoteIn').focus(), 50); break; }
    case 'eDone': entryDone(); break;
    case 'undoTx': undo([id]); closeSheet(); break;

    /* суммы */
    case 'aChip': $('#aAmt').value = b.dataset.v; break;
    case 'aOk': { const a = num($('#aAmt').value); if (a <= 0) { toast('Введи сумму'); return; } const cb = amountCb; const extra = {}; $$('#sheetBox [data-pick].on').forEach(x => extra[x.dataset.pick] = x.dataset.v); closeSheet(); cb && cb(a, extra); break; }
    case 'pick': { $$(`#sheetBox [data-pick="${b.dataset.pick}"]`).forEach(x => x.classList.toggle('on', x === b)); break; }

    /* конверты */
    case 'stash': {
      const d = today();
      let money = Math.min(Math.max(0, d.env.l), d.short);
      for (const bl of d.bills.filter(x => !x.done && x.remaining > 0)) { const take = Math.min(money, bl.remaining); if (take > 0) { S.tx.push({ i:uid(), t:Date.now(), k:'move', a:take, f:'l', to:bl.id }); money -= take; } }
      save(); haptic(); toast('Записал. Наличные в конверте — их нет в кошельке 👍'); render(); break;
    }
    case 'stashAny': {
      const d = today();
      const opts = [...d.bills.map(x => [x.id, `${billEmoji(x)} ${x.name}`]), ['c', '🛟 Подушка']];
      const first = d.bills.find(x => x.remaining > 0);
      askAmount({ title:'📥 Отложить из кошелька', sub:`В кошельке ${fmt(d.env.l)}. Куда кладёшь?`, value:first ? Math.min(first.perDay, Math.max(0, d.env.l)) : '',
        extra:`<div class="chips" style="margin-bottom:12px">${opts.map(([k, l], i) => `<button class="chip ${(first ? k === first.id : i === opts.length - 1) ? 'on' : ''}" data-act="pick" data-pick="to" data-v="${k}">${esc(l)}</button>`).join('')}</div>`, btn:'Отложил' },
        (a, x) => addMove(a, 'l', x.to || 'c'));
      break;
    }
    case 'stashBill': {
      const bl = billStatus().find(x => x.id === id), d = today();
      askAmount({ title:`📥 В конверт «${esc(bl.name)}»`, sub:`Нужно ${fmt(bl.amount)} до ${ddmm(bl.due)}, уже есть ${fmt(bl.saved)}. В кошельке ${fmt(d.env.l)}.`, value:Math.min(bl.perDay || bl.remaining, Math.max(0, d.env.l)) || '',
        chips:[[`по плану ${fmt(bl.perDay)}`, bl.perDay], [`всё, что осталось ${fmt(bl.remaining)}`, bl.remaining]], btn:'Отложил' }, a => addMove(a, 'l', id));
      break;
    }
    case 'stashEnv': {
      const d = today();
      askAmount({ title:`📥 В конверт «${envName(id)}»`, sub:`В кошельке ${fmt(d.env.l)}, свободных ${fmt(Math.max(0, d.free))}.`, chips:[['50 zł', 50], ['100 zł', 100], ['200 zł', 200]], btn:'Отложил' }, a => addMove(a, 'l', id));
      break;
    }
    case 'takeEnv': {
      const have = balances().env[id] || 0;
      askAmount({ title:`↩ Взять из «${esc(envName(id))}»`, sub:`В конверте ${fmt(have)}. Деньги вернутся в кошелёк.${S.set.bills.find(x => x.id === id) ? ' Помни: это деньги на платёж.' : ''}`, value:'', chips:[[`всё ${fmt(have)}`, have]], btn:'Взял' }, a => addMove(Math.min(a, have), id, 'l'));
      break;
    }
    case 'payBill': {
      const bl = billStatus().find(x => x.id === id);
      if (!bl) return;
      askAmount({ title:`✅ ${esc(bl.name)}: оплатил`, sub:`За ${ddmm(bl.due)}. В конверте ${fmt(bl.saved)}${bl.saved < bl.amount ? ', остальное возьму из кошелька' : ''}.`, value:bl.amount, chips:[[`${fmt(bl.amount)}`, bl.amount]], btn:'Оплачено' }, a => addPay(id, a, 'cash'));
      break;
    }
    case 'move': {
      const env = balances().env;
      const keys = ['l', ...S.set.bills.map(x => x.id), 'c', 'g'];
      const seg = k => `<div class="chips" style="margin-bottom:10px">${keys.map((x, i) => `<button class="chip ${(k === 'f' ? i === 0 : i === 1) ? 'on' : ''}" data-act="pick" data-pick="${k}" data-v="${x}">${envEmoji(x)} ${esc(envName(x))} ${k === 'f' ? r0(env[x] || 0) : ''}</button>`).join('')}</div>`;
      askAmount({ title:'↔ Переложить', extra:`<div class="small muted">Откуда</div>${seg('f')}<div class="small muted">Куда</div>${seg('to')}`, btn:'Переложить' }, (a, x) => {
        if (!x.f || !x.to || x.f === x.to) { toast('Выбери разные конверты'); return; }
        addMove(a, x.f, x.to);
      });
      break;
    }
    case 'check': {
      const { acc } = balances();
      openSheet(`
        <h3>🧾 Сверка</h3>
        <p class="muted" style="margin-top:-6px">Пересчитай все наличные: кошелёк и конверты вместе. Разницу запишу как «неучтённое», без упрёков.</p>
        <div class="field"><label>💵 Наличных всего (по записям ${fmt(acc.cash)})</label><input id="fCash" inputmode="decimal" placeholder="${r0(acc.cash)}"></div>
        ${S.set.hasCard ? `<div class="field"><label>💳 Карта (по записям ${fmt(acc.card)})</label><input id="fCard" inputmode="decimal" placeholder="${r0(acc.card)}"></div>` : ''}
        <button class="btn pri full" data-act="doCheck">Свести</button>`);
      setTimeout(() => $('#fCash').focus(), 80);
      break;
    }
    case 'doCheck': {
      const { acc } = balances(), ids = [];
      [['cash', '#fCash'], ['card', '#fCard']].forEach(([k, sel]) => {
        const el = $(sel); if (!el || el.value.trim() === '') return;
        const diff = r0(num(el.value) - acc[k]);
        if (diff !== 0) { const t = { i:uid(), t:Date.now(), k:'adj', a:diff, ac:k }; S.tx.push(t); ids.push(t.i); }
      });
      closeSheet();
      if (ids.length) { save(); haptic(); toast('Свёл. Разница записана в кошелёк', ids); }
      else { S.tx.push({ i:uid(), t:Date.now(), k:'chk' }); save(); toast('Всё сходится 👌'); }
      render(); break;
    }
    case 'xfer': {
      askAmount({ title:'⇄ Снял / положил', extra:`<div class="chips" style="margin-bottom:12px"><button class="chip on" data-act="pick" data-pick="f" data-v="card">Снял с карты → нал</button><button class="chip" data-act="pick" data-pick="f" data-v="cash">Нал → на карту</button></div>`, btn:'Записать' },
        (a, x) => { const f = x.f || 'card'; const t = { i:uid(), t:Date.now(), k:'xfer', a, f, to:f === 'card' ? 'cash' : 'card' }; S.tx.push(t); save(); haptic(); toast('Записал', [t.i]); render(); });
      break;
    }

    /* хочу */
    case 'want': sheetWant(); setTimeout(() => $('#fAmt').focus(), 80); break;
    case 'checkWant': { const a = num($('#fAmt').value); if (a <= 0) { toast('Введи сумму'); return; } wantVerdict(a, cap($('#fName').value.trim())); break; }
    case 'wantBuy': { const { a, name } = sheetState; closeSheet(); openEntry('out', { amt:a, cat:name && S.cats[name] ? name : '' }); break; }
    case 'wantWait': { S.wish.items.push({ i:uid(), t:Date.now(), a:sheetState.a, name:sheetState.name }); save(); closeSheet(); haptic(); toast('Записал. Через 48 часов спрошу ещё раз на главном экране'); render(); break; }
    case 'wishBuy': { const w = S.wish.items.find(x => x.i === id); if (!w) return; S.wish.items = S.wish.items.filter(x => x !== w); save(); openEntry('out', { amt:w.a }); break; }
    case 'wishSkip': { const w = S.wish.items.find(x => x.i === id); if (!w) return; S.wish.items = S.wish.items.filter(x => x !== w); S.wish.skipped.push({ a:w.a, t:Date.now() }); save(); haptic(); closeSheet(); toast(`Сэкономил ${fmt(w.a)} 💪`); render(); break; }

    /* мероприятия */
    case 'newEv': sheetEvent(); break;
    case 'openEv': sheetEvent(id); break;
    case 'evSave': {
      const name = $('#evName').value.trim(); if (!name) { toast('Напиши название'); return; }
      const dv = $('#evDate').value; const dt = dv ? new Date(dv + 'T12:00').getTime() : Date.now();
      const data = { name, d:dt, fee:num($('#evFee').value), pre:num($('#evPre').value) };
      if (id) Object.assign(S.ev.find(x => x.i === id), data); else S.ev.push({ i:uid(), ...data });
      save(); haptic(); closeSheet(); toast('Мероприятие сохранено'); render(); break;
    }
    case 'evDel': if (await confirmAsk('Удалить мероприятие? Записанные деньги останутся.')) { S.ev = S.ev.filter(x => x.i !== id); save(); closeSheet(); render(); } break;
    case 'evGet': {
      const ev = S.ev.find(x => x.i === id); if (!ev) return;
      const got = evGot(ev);
      closeSheet();
      openEntry('in', { ev:id, type:got === 0 && ev.pre ? 'prepay' : 'fee', amt:got === 0 && ev.pre ? ev.pre : ev.fee - got });
      break;
    }

    /* ассистент и история */
    case 'aiSec': aiSec = b.dataset.s; render(); break;
    case 'period': statPeriod = b.dataset.p; render(); break;
    case 'hf': histFilter = b.dataset.f; render(); break;
    case 'delTx': if (await confirmAsk('Удалить эту запись?')) { S.tx = S.tx.filter(t => t.i !== id); save(); render(); } break;

    /* настройки */
    case 'addBillRow': $('#billRows').insertAdjacentHTML('beforeend', billRow({ id:'', name:'', amount:'', day:'' })); break;
    case 'delBillRow': b.closest('.billrow').remove(); break;
    case 'saveSetup': {
      const rows = readSettings();
      const total = num($('#sCash').value), card = $('#sHasCard').checked ? num($('#sCard').value) : 0;
      if (!rows.length && !S.set.salary) { toast('Заполни хотя бы аренду или зарплату'); return; }
      S.set.setup = true; S.set.since = Date.now(); S.set.v = 2;
      S.set.bills.forEach(x => x.from = Date.now());
      // Стартовый остаток: то, что уже лежит в конвертах платежей, и остальное в кошелёк
      const s = {}; let restCash = total;
      rows.forEach(r => { const v = Math.min(r.saved, restCash); if (v > 0) { s[r.id] = v; restCash -= v; } });
      if (restCash > 0) s.l = restCash;
      if (total > 0) S.tx.push({ i:uid(), t:Date.now(), k:'in', a:total, c:'start', ac:'cash', s });
      if (card > 0) S.tx.push({ i:uid(), t:Date.now(), k:'in', a:card, c:'start', ac:'card', s:{ l:card } });
      save(); haptic(); render(); break;
    }
    case 'saveSet': readSettings(); save(); haptic(); toast('Сохранил'); render(); break;
    case 'delCat': { const c = b.dataset.cat; if (await confirmAsk(`Убрать категорию «${c}» из кнопок? Старые записи останутся.`)) { delete S.cats[c]; save(); render(); } break; }
    case 'export': {
      const data = JSON.stringify({ set:S.set, cats:S.cats, wish:S.wish, ev:S.ev, tx:S.tx });
      try { await navigator.clipboard.writeText(data); toast('Копия в буфере. Сохрани её в «Избранное» Telegram'); } catch (err) { toast('Не получилось скопировать'); }
      break;
    }
    case 'import': {
      openSheet(`<h3>Вставить копию</h3><p class="muted small">Вставь текст копии. Текущие данные заменятся.</p><textarea id="impText" style="width:100%;height:140px;border-radius:12px;padding:10px;background:var(--bg2);color:var(--tx);border:1px solid var(--line)"></textarea><button class="btn pri full" style="margin-top:10px" data-act="doImport">Загрузить</button>`);
      break;
    }
    case 'doImport': {
      try {
        const d = JSON.parse($('#impText').value);
        if (!d.set || !Array.isArray(d.tx)) throw 0;
        S.set = { ...DEF_SET, bills:[], ...d.set, v:d.set.v || 1 }; S.cats = d.cats || {}; S.wish = d.wish || { items:[], skipped:[] }; S.ev = d.ev || []; S.tx = d.tx;
        if (S.set.v !== 2) migrate();
        await save(); closeSheet(); toast('Загрузил'); render();
      } catch (err) { toast('Это не похоже на копию кошелька'); }
      break;
    }
    case 'reset': {
      if (await confirmAsk('Стереть все записи и настройки? Это нельзя отменить.')) {
        S = { set:{ ...DEF_SET, bills:[] }, cats:{}, tx:[], wish:{ items:[], skipped:[] }, ev:[], txParts:S.txParts };
        DEF_CATS.forEach(c => S.cats[c] = { n:0, last:0, ac:'cash' });
        await save(); tab = 'home'; render();
      }
      break;
    }
  }
});

load().then(render);
