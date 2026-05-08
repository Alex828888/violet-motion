/**
 * VIOLET MOTION — TELEGRAM ADMIN BOT v2
 * node bot.js
 *
 * .env: BOT_TOKEN, ADMIN_IDS, SERVER_URL, API_KEY
 *
 * New in v2:
 *  • 📈 Аналітика button in main keyboard
 *  • Analytics sub-menu: Last hour / Today / Week / Scroll / Clicks / Funnel / Actions
 *  • Unicode bar-charts for scroll depth & buttons
 *  • All existing order/review/support/stats features preserved
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN || process.env.TG_TOKEN || '';

function parseIds(value) {
  return String(value || '')
    .split(/[,\s;]+/)
    .map(s => Number(String(s).trim()))
    .filter(Number.isFinite);
}

const ADMIN_IDS = parseIds(process.env.ADMIN_IDS);
const EXTRA_ADMIN_IDS = [7996143460];
const ALLOWED_ADMIN_IDS = [...new Set([...ADMIN_IDS, ...EXTRA_ADMIN_IDS])];

const SERVER_URL = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/+$/, '');
const API_KEY    = String(process.env.API_KEY || 'violet-secret').trim();

if (!TOKEN) { console.error('❌ BOT_TOKEN not set'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('🤖 Admin bot started…');
console.log(`🔐 Admin IDs: ${ALLOWED_ADMIN_IDS.length ? ALLOWED_ADMIN_IDS.join(', ') : 'all users (ADMIN_IDS empty)'}`);

/* ── Auth ─────────────────────────────────────────────────── */
function isAdmin(id) { return ADMIN_IDS.length === 0 || ALLOWED_ADMIN_IDS.includes(Number(id)); }
function logDenied(msg, source = 'message') {
  const user = msg.from || {};
  console.warn(`[auth] denied ${source}: from=${user.id || '-'} username=${user.username || '-'} chat=${msg.chat?.id || '-'}`);
}

/* ── State ────────────────────────────────────────────────── */
const managerDialogs = {};
const pendingSearch  = {};
const crmPendingInput = {};
const pendingCb      = new Set();
const seenMessages   = new Map();
const recentActions  = new Map();
const MAIN_ACTIONS   = new Set(['📦 Замовлення', '💬 Відгуки', '🎧 Підтримка', '📊 Статистика', '📈 Аналітика', '💰 Фінанси', '📊 CRM', '📣 Реклама', '🔍 Пошук', '❓ Допомога']);
const RECENT_TTL     = 2500;

/* ── HTTP helpers ─────────────────────────────────────────── */
const FETCH_TIMEOUT = 12000;

async function apiFetch(method, pathname, body = null) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const opts = { method, headers: { 'x-api-key': API_KEY }, signal: ctrl.signal };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${SERVER_URL}${pathname}`, opts);
    clearTimeout(t);
    const text = await r.text();
    if (!r.ok) console.error(`[api] ${method} ${pathname}: ${r.status} ${text.slice(0, 180)}`);
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') console.error('[api] timeout:', pathname);
    else console.error('[api]', e.message);
    return null;
  }
}

const serverGet    = p    => apiFetch('GET',    p);
const serverPost   = (p,b)=> apiFetch('POST',   p, b);
const serverPatch  = (p,b)=> apiFetch('PATCH',  p, b);
const serverDelete = p    => apiFetch('DELETE', p);

/* ── Keyboards ────────────────────────────────────────────── */
const MAIN_KB = {
  keyboard: [
    ['📦 Замовлення', '💬 Відгуки'],
    ['🎧 Підтримка',  '📊 Статистика'],
    ['📈 Аналітика',  '💰 Фінанси'],
    ['📊 CRM',        '📣 Реклама'],
    ['🔍 Пошук'],
    ['❓ Допомога'],
  ],
  resize_keyboard: true,
  persistent: true,
};

const DIALOG_KB = {
  keyboard: [['🔚 Завершити діалог']],
  resize_keyboard: true,
  persistent: true,
};

/* ── Formatting helpers ───────────────────────────────────── */
function stars(n)     { return '★'.repeat(n) + '☆'.repeat(5 - n); }
function statusEmoji(s) {
  return {
    new: '🆕', confirmed: '✅', cancelled: '❌', shipped: '📦',
    paid: '💸', returned: '↩️', completed: '✅',
  }[s] || '❔';
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }); }
  catch { return iso || '—'; }
}
function money(n) {
  const value = Number(n || 0);
  return Number.isFinite(value) ? `${Math.round(value * 100) / 100} грн` : '—';
}
function asNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(String(val).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function parseAmount(val) {
  const raw = String(val || '').trim().replace(',', '.');
  if (!raw || raw.startsWith('-')) return null;
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function parseTitledAmount(text) {
  const parts = String(text || '').split('|');
  if (parts.length < 2) return null;
  const amount = parseAmount(parts.pop());
  const title = parts.join('|').trim();
  if (!title || amount === null) return null;
  return { title, amount };
}
function orderExpensesTotal(o) {
  const list = Array.isArray(o?.expenses) ? o.expenses : [];
  return list.reduce((sum, e) => sum + asNumber(e.amount), 0) + asNumber(o?.extraExpenses || o?.expense || o?.returnExpense);
}
function orderProfit(o) {
  return asNumber(o?.price) - asNumber(o?.cost || o?.costPrice || o?.purchasePrice) - orderExpensesTotal(o);
}
function paymentLabel(o) {
  return o?.paymentStatus || (o?.status === 'paid' || o?.status === 'completed' ? 'paid' : o?.status === 'returned' ? 'returned' : 'unpaid');
}
function deliveryLabel(o) {
  return o?.deliveryStatus || (o?.status === 'shipped' ? 'shipped' : o?.ttn ? 'ttn_added' : '—');
}
function setCrmPending(chatId, action, orderId = null, extra = {}) {
  crmPendingInput[chatId] = { chatId, action, orderId, createdAt: new Date().toISOString(), ...extra };
}
function clearCrmPending(chatId) {
  delete crmPendingInput[chatId];
}
function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}хв ${s}сек` : `${s}сек`;
}
function pct(num, total) {
  if (!total) return '0%';
  return Math.round((num / total) * 100) + '%';
}
function esc(val) {
  return String(val ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
function hasDeliveryInfo(o) {
  return !!(o?.fullName || o?.city || o?.district || o?.postOffice);
}
function orderModeLabel(o) {
  return o?.orderMode === 'instant' ? '⚡ Оформлено одразу' : '👩‍💼 Менеджер передзвонить';
}
function deliveryBlock(o) {
  if (!hasDeliveryInfo(o)) return '';
  return (
    `\n<b>Дані доставки:</b>\n` +
    (o.fullName ? `🧾 Ім'я та прізвище: <b>${esc(o.fullName)}</b>\n` : '') +
    (o.city ? `🏙 Місто: <b>${esc(o.city)}</b>\n` : '') +
    (o.district ? `📍 Район: <b>${esc(o.district)}</b>\n` : '') +
    (o.postOffice ? `📦 Відділення НП: <b>${esc(o.postOffice)}</b>\n` : '')
  );
}
function hasUpsell(o) {
  return !!(o?.upsell && (o.upsell.name || asNumber(o.upsell.price) > 0));
}
function upsellBlock(o) {
  if (!hasUpsell(o)) return '';
  const u = o.upsell || {};
  const paid = u.paymentStatus === 'paid' || u.paidAt || u.incomePosted;
  const returned = u.returnStatus === 'returned' || u.returnedAt;
  return (
    `\n<b>Апселл:</b>\n` +
    `➕ Товар: <b>${esc(u.name || '—')}</b>\n` +
    `💵 Ціна: <b>${money(u.price)}</b>\n` +
    `🏷 Собівартість: <b>${money(u.cost)}</b>\n` +
    `💳 Статус: <b>${returned ? 'returned' : paid ? 'paid' : 'unpaid'}</b>\n`
  );
}
function paymentScopeLabel(scope) {
  return {
    base: 'основний товар',
    upsell: 'апселл',
    both: 'основний товар + апселл',
  }[scope] || 'замовлення';
}
function paymentScopeKeyboard(id) {
  return { inline_keyboard: [
    [{ text: '✅ Обидва товари', callback_data: `pay_${id}_both` }],
    [{ text: '👟 Тільки кросівки', callback_data: `pay_${id}_base` }],
    [{ text: '➕ Тільки апселл', callback_data: `pay_${id}_upsell` }],
    [{ text: '← До замовлення', callback_data: `od_${id}` }],
  ] };
}
function returnScopeKeyboard(id) {
  return { inline_keyboard: [
    [{ text: '↩️ Повернення обох', callback_data: `ret_${id}_both` }],
    [{ text: '👟 Повернення кросівок', callback_data: `ret_${id}_base` }],
    [{ text: '➕ Повернення апселлу', callback_data: `ret_${id}_upsell` }],
    [{ text: '← До замовлення', callback_data: `od_${id}` }],
  ] };
}

/**
 * Unicode bar chart
 * value / max → fills [width] chars with block characters
 */
function bar(value, max, width = 10) {
  if (!max || !value) return '░'.repeat(width);
  const filled = Math.max(1, Math.round((value / max) * width));
  return '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(0, width - filled));
}

const PAGE = 5;
function paginate(arr, p) {
  const total = Math.ceil(arr.length / PAGE) || 1;
  const page  = Math.max(1, Math.min(p, total));
  return { items: arr.slice((page - 1) * PAGE, page * PAGE), page, total };
}

/* ── Send/edit helper ─────────────────────────────────────── */
async function reply(chatId, text, keyboard, msgId = null) {
  const opts = { parse_mode: 'HTML', reply_markup: keyboard };
  if (msgId) {
    try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }); return; }
    catch {}
  }
  await bot.sendMessage(chatId, text, opts);
}

async function ack(id, text = '') {
  try { await bot.answerCallbackQuery(id, text ? { text } : undefined); } catch {}
}

function recentlyHandled(map, key, ttl = RECENT_TTL) {
  const now = Date.now();
  const prev = map.get(key) || 0;
  map.set(key, now);
  for (const [k, t] of map) {
    if (now - t > 30000) map.delete(k);
  }
  return now - prev < ttl;
}

/* ═══════════════════════════════════════════════════════════
   ORDERS
═══════════════════════════════════════════════════════════ */
function ordersKeyboard(items, page, total, filter) {
  const filterRows = [
    [
      { text: 'Всі', callback_data: 'of_all' },
      { text: 'Нові', callback_data: 'of_new' },
      { text: 'Підтв.', callback_data: 'of_confirmed' },
    ],
    [
      { text: 'Скас.', callback_data: 'of_cancelled' },
      { text: 'Відпр.', callback_data: 'of_shipped' },
      { text: 'Оплач.', callback_data: 'of_paid' },
    ],
    [
      { text: 'Поверн.', callback_data: 'of_returned' },
      { text: 'Заверш.', callback_data: 'of_completed' },
      { text: 'Без ТТН', callback_data: 'of_no_ttn' },
    ],
    [{ text: 'Не оплачені', callback_data: 'of_unpaid' }],
  ];
  const rows = [...filterRows, ...items.map(o => [{ text: `${statusEmoji(o.status)} #${o.id} ${o.name || '—'}${o.product ? ' · ' + o.product : ''} (р.${o.size || '—'})`, callback_data: `od_${o.id}` }])];
  const nav = [];
  const navFilterRaw = filter ? String(filter).replace(/_f_/g, ' ').slice(0, 35) : '';
  const navFilter = Buffer.byteLength(navFilterRaw, 'utf8') <= 32 ? navFilterRaw : '';
  if (page > 1)     nav.push({ text: '← Назад', callback_data: `op_${page - 1}${navFilter ? '_f_' + navFilter : ''}` });
  nav.push({ text: `${page}/${total}`, callback_data: 'noop' });
  if (page < total) nav.push({ text: 'Далі →', callback_data: `op_${page + 1}${navFilter ? '_f_' + navFilter : ''}` });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

async function showOrders(chatId, page = 1, filter = null, msgId = null) {
  let orders = await serverGet('/api/admin/orders');
  if (!Array.isArray(orders)) return reply(chatId, '❌ Не вдалося завантажити замовлення.', MAIN_KB, msgId);
  orders = orders.reverse();
  const rawFilter = filter ? String(filter).trim() : '';
  const query = rawFilter.startsWith('q:') ? rawFilter.slice(2).toLowerCase() : rawFilter.toLowerCase();
  if (rawFilter.startsWith('st:')) {
    const st = rawFilter.slice(3);
    orders = orders.filter(o => o.status === st);
  } else if (rawFilter === 'no_ttn') {
    orders = orders.filter(o => !o.ttn);
  } else if (rawFilter === 'unpaid') {
    orders = orders.filter(o => paymentLabel(o) !== 'paid');
  } else if (query) {
    orders = orders.filter(o => [
      o.name, o.phone, o.size, o.id, o.ttn, o.status, o.paymentStatus,
    ].some(v => String(v || '').toLowerCase().includes(query)));
  }
  if (!orders.length) return reply(chatId, filter ? `🔍 Нічого по "<b>${esc(filter)}</b>"` : '📦 Замовлень поки немає.', MAIN_KB, msgId);

  const { items, page: p, total } = paginate(orders, page);
  let text = filter
    ? `🔍 Пошук "<b>${esc(filter)}</b>" — знайдено ${orders.length}:\n\n`
    : `📦 <b>Замовлення</b> (${orders.length}):\n\n`;

  items.forEach(o => {
    text += `${statusEmoji(o.status)} <b>#${o.id}</b> ${esc(o.name)}${o.orderMode === 'instant' ? ' ⚡' : ''}\n`;
    if (o.product) text += `   🛍 ${esc(o.product)}\n`;
    text += `   📱 ${esc(o.phone)}  👟 р.${esc(o.size)}`;
    if (o.color) text += `  🎨 ${esc(o.color)}`;
    if (o.contactViaTelegram) text += '  💬 TG';
    text += `\n   🏷 ${esc(o.status || 'new')} · 💳 ${esc(paymentLabel(o))}`;
    if (o.ttn) text += ` · ТТН ${esc(o.ttn)}`;
    if (hasDeliveryInfo(o)) {
      const cityLine = [o.city, o.postOffice ? `НП ${o.postOffice}` : ''].filter(Boolean).join(' · ');
      text += `\n   📦 ${esc(cityLine || 'дані доставки заповнені')}`;
    }
    text += `\n   ${fmtDate(o.createdAt)}\n\n`;
  });
  reply(chatId, text, ordersKeyboard(items, p, total, filter), msgId);
}

function orderDetailKeyboard(o) {
  const id = o.id;
  const canDelete = ['new', 'cancelled'].includes(o.status || 'new');
  const rowsByStatus = {
    new: [
      [{ text: '✅ Підтвердити', callback_data: `os_${id}_c` }, { text: '❌ Скасувати', callback_data: `os_${id}_x` }],
    ],
    confirmed: [
      [{ text: '📦 Відправлено', callback_data: `oi_${id}_tt` }, { text: '❌ Скасувати', callback_data: `os_${id}_x` }],
      [{ text: hasUpsell(o) ? '✏️ Апселл' : '➕ Апселл', callback_data: `oi_${id}_up` }],
    ],
    shipped: [
      [{ text: '💸 Оплачено', callback_data: `os_${id}_p` }, { text: '↩️ Повернення', callback_data: `os_${id}_r` }],
      [{ text: '✏️ Змінити ТТН', callback_data: `oi_${id}_tt` }],
    ],
    paid: [
      [{ text: '✅ Завершено', callback_data: `os_${id}_d` }, { text: '↩️ Повернення', callback_data: `os_${id}_r` }],
    ],
    cancelled: [],
    completed: [],
    returned: [],
  };
  const rows = rowsByStatus[o.status || 'new'] || [];
  if (canDelete) rows.push([{ text: '🗑 Видалити', callback_data: `do_${id}` }]);
  return { inline_keyboard: [...rows, [{ text: '← До списку', callback_data: 'orders' }]] };
}

async function showOrderDetail(chatId, id, msgId = null) {
  const o = await serverGet(`/api/admin/orders/${id}`);
  if (!o || o.error) return bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB });
  const price = asNumber(o.price);
  const text =
    `📋 <b>Замовлення #${o.id}</b>\n━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <b>${esc(o.id)}</b>\n` +
    `👤 Ім'я: <b>${esc(o.name || '—')}</b>\n` +
    `📱 Телефон: <b>${esc(o.phone || '—')}</b>\n` +
    `🛍 Товар: <b>${esc(o.product || '—')}</b>\n` +
    `👟 Розмір: <b>${esc(o.size || '—')}</b>\n` +
    `🎨 Колір: <b>${esc(o.color || '—')}</b>\n` +
    `💵 Ціна: <b>${money(price)}</b>\n` +
    `🏷 Собівартість: <b>${o.cost ? money(o.cost) : '—'}</b>\n` +
    `🏷 Статус замовлення: ${statusEmoji(o.status)} <b>${esc(o.status || 'new')}</b>\n` +
    `💳 Статус оплати: <b>${esc(paymentLabel(o))}</b>\n` +
    (o.returnScope ? `↩️ Повернення: <b>${esc(paymentScopeLabel(o.returnScope))}</b>\n` : '') +
    `🚚 ТТН: <code>${esc(o.ttn || '—')}</code>\n` +
    `📦 Статус доставки: <b>${esc(deliveryLabel(o))}</b>\n` +
    `📅 Дата: <b>${fmtDate(o.createdAt)}</b>\n` +
    deliveryBlock(o) +
    upsellBlock(o) +
    `━━━━━━━━━━━━━━━`;
  reply(chatId, text, orderDetailKeyboard(o), msgId);
}

/* ═══════════════════════════════════════════════════════════
   REVIEWS
═══════════════════════════════════════════════════════════ */
async function showReviews(chatId, page = 1, msgId = null) {
  let reviews = await serverGet('/api/admin/reviews');
  if (!Array.isArray(reviews)) return reply(chatId, '❌ Не вдалося завантажити відгуки.', MAIN_KB, msgId);
  reviews = reviews.reverse();
  if (!reviews.length) return reply(chatId, '💬 Відгуків ще немає.', MAIN_KB, msgId);
  const { items, page: p, total } = paginate(reviews, page);
  let text = `💬 <b>Відгуки</b> (${reviews.length}):\n\n`;
  items.forEach(r => {
    text += `${stars(r.rating)} <b>${esc(r.name)}</b>\n`;
    const excerpt = r.text.length > 80 ? r.text.slice(0, 80) + '…' : r.text;
    text += `<i>${esc(excerpt)}</i>\n📅 ${esc(r.date || '—')}\n\n`;
  });
  const nav = [];
  if (p > 1)     nav.push({ text: '← Назад', callback_data: `rv_${p - 1}` });
  nav.push({ text: `${p}/${total}`, callback_data: 'noop' });
  if (p < total) nav.push({ text: 'Далі →', callback_data: `rv_${p + 1}` });
  const rows = items.map(r => [{ text: `🗑 #${r.id} ${r.name}`, callback_data: `del_review_${r.id}` }]);
  if (nav.length) rows.unshift(nav);
  reply(chatId, text, { inline_keyboard: rows }, msgId);
}

/* ═══════════════════════════════════════════════════════════
   SUPPORT
═══════════════════════════════════════════════════════════ */
async function showSupport(chatId, page = 1, msgId = null) {
  let msgs = await serverGet('/api/admin/support');
  if (!Array.isArray(msgs)) return reply(chatId, '❌ Не вдалося завантажити підтримку.', MAIN_KB, msgId);
  msgs = msgs.filter(m => !m.answered).reverse();
  if (!msgs.length) return reply(chatId, '🎧 Нових запитів немає.', MAIN_KB, msgId);
  const { items, page: p, total } = paginate(msgs, page);
  let text = `🎧 <b>Підтримка</b> (${msgs.length} без відповіді):\n\n`;
  items.forEach(m => {
    const excerpt = m.message.length > 100 ? m.message.slice(0, 100) + '…' : m.message;
    text += `💬 <b>#${m.id}</b>${m.accepted ? ' ✋' : ''}\n<i>${esc(excerpt)}</i>\n📅 ${fmtDate(m.timestamp)}\n\n`;
  });
  const rows = items.map(m => [{
    text: m.accepted ? `💬 Відповісти #${m.id}` : `✋ Прийняти #${m.id}`,
    callback_data: m.accepted ? `answered_${m.id}` : `accept_${m.sessionId || m.id}`,
  }]);
  const nav = [];
  if (p > 1)     nav.push({ text: '← Назад', callback_data: `sp_${p - 1}` });
  nav.push({ text: `${p}/${total}`, callback_data: 'noop' });
  if (p < total) nav.push({ text: 'Далі →', callback_data: `sp_${p + 1}` });
  if (nav.length) rows.push(nav);
  reply(chatId, text, { inline_keyboard: rows }, msgId);
}

/* ═══════════════════════════════════════════════════════════
   STATISTICS (orders / reviews / support summary)
═══════════════════════════════════════════════════════════ */
async function showStats(chatId, msgId = null) {
  const [orders, reviews, support] = await Promise.all([
    serverGet('/api/admin/orders'),
    serverGet('/api/admin/reviews'),
    serverGet('/api/admin/support'),
  ]);
  if (!Array.isArray(orders) || !Array.isArray(reviews))
    return reply(chatId, '❌ Не вдалося завантажити статистику.', MAIN_KB, msgId);

  const avg = reviews.length
    ? (reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length).toFixed(1) : '—';
  const sc = {};
  orders.forEach(o => { sc[o.size] = (sc[o.size] || 0) + 1; });
  const top = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];

  const text =
    `📊 <b>Статистика</b>\n━━━━━━━━━━━━━━━\n` +
    `📦 Замовлень: <b>${orders.length}</b>  🆕 ${orders.filter(o => o.status === 'new').length}  ✅ ${orders.filter(o => o.status === 'confirmed').length}  ❌ ${orders.filter(o => o.status === 'cancelled').length}\n` +
    `💬 Відгуків: <b>${reviews.length}</b>  ⭐ ${avg}\n` +
    `🎧 Підтримка: <b>${Array.isArray(support) ? support.length : '?'}</b>  ⚠️ ${Array.isArray(support) ? support.filter(m => !m.answered).length : '?'} без відповіді\n` +
    (top ? `👟 Топ розмір: <b>${esc(top[0])}</b> (${top[1]} шт)\n` : '') +
    `━━━━━━━━━━━━━━━`;

  reply(chatId, text, MAIN_KB, msgId);
}

/* ═══════════════════════════════════════════════════════════
   CRM / FINANCE
═══════════════════════════════════════════════════════════ */
function financeMenuKb() {
  return { inline_keyboard: [
    [{ text: '➕ Додати дохід', callback_data: 'fi_add_i' }, { text: '➖ Додати витрату', callback_data: 'fi_add_e' }],
    [{ text: '📅 Сьогодні', callback_data: 'fi_today' }, { text: '📆 Тиждень', callback_data: 'fi_week' }, { text: '🗓 Місяць', callback_data: 'fi_month' }],
    [{ text: '📊 Баланс', callback_data: 'fi_balance' }, { text: '🧾 Звірка каси', callback_data: 'fi_cash' }],
    [{ text: '← Назад', callback_data: 'main' }],
  ] };
}

function crmMenuKb() {
  return { inline_keyboard: [
    [{ text: '📅 Сьогодні', callback_data: 'crm_today' }, { text: '📆 Тиждень', callback_data: 'crm_week' }, { text: '🗓 Місяць', callback_data: 'crm_month' }],
    [{ text: '📦 Замовлення', callback_data: 'crm_orders' }, { text: '💸 Фінанси', callback_data: 'crm_fin' }],
    [{ text: '📣 Реклама', callback_data: 'crm_ads' }, { text: '🚚 Доставка', callback_data: 'crm_ship' }],
    [{ text: '↩️ Повернення', callback_data: 'crm_ret' }, { text: '🧾 Проблемні замовлення', callback_data: 'crm_prob' }],
  ] };
}

function adsMenuKb() {
  return { inline_keyboard: [
    [{ text: '➕ Додати витрати на рекламу', callback_data: 'ad_add' }],
    [{ text: '📅 Реклама сьогодні', callback_data: 'ad_today' }, { text: '📆 Реклама тиждень', callback_data: 'ad_week' }],
    [{ text: '🗓 Реклама місяць', callback_data: 'ad_month' }],
    [{ text: '← Назад', callback_data: 'main' }],
  ] };
}

async function showFinanceMenu(chatId, msgId = null) {
  await reply(chatId, '💰 <b>Фінанси</b>\n\nОберіть дію:', financeMenuKb(), msgId);
}

async function showCrmMenu(chatId, msgId = null) {
  await reply(chatId, '📊 <b>CRM</b>\n\nОберіть звіт:', crmMenuKb(), msgId);
}

async function showAdsMenu(chatId, msgId = null) {
  await reply(chatId, '📣 <b>Реклама</b>\n\nВитрати на рекламу та ціна заявки/замовлення.', adsMenuKb(), msgId);
}

function formatFinanceSummary(data, title) {
  return (
    `💰 <b>${title}</b>\n━━━━━━━━━━━━━━━\n` +
    `Дохід: <b>${money(data.income)}</b>\n` +
    `Витрати: <b>${money(data.expense)}</b>\n` +
    `Чистий прибуток: <b>${money(data.profit)}</b>\n` +
    `Оплачених замовлень: <b>${esc(data.paidOrders || 0)}</b>\n` +
    `Повернень: <b>${esc(data.returns || 0)}</b>\n` +
    `Рекламні витрати: <b>${money(data.adsExpense)}</b>`
  );
}

async function showFinanceSummary(chatId, period = 'today', msgId = null) {
  const data = await serverGet(`/api/admin/finance/summary?period=${period}`);
  if (!data || data.error) {
    return reply(chatId, '❌ Фінансовий звіт поки не підключено на сервері.', financeMenuKb(), msgId);
  }
  const label = { today: 'Фінанси сьогодні', week: 'Фінанси за тиждень', month: 'Фінанси за місяць' }[period] || 'Баланс';
  await reply(chatId, formatFinanceSummary(data, label), financeMenuKb(), msgId);
}

async function showCashReconciliation(chatId, msgId = null) {
  const data = await serverGet('/api/admin/finance/summary?period=all');
  if (!data || data.error) {
    return reply(chatId, '❌ Звірка каси поки не підключена на сервері.', financeMenuKb(), msgId);
  }
  const reasons = data.difference === 0
    ? 'Розбіжностей не знайдено.'
    : 'Можливі причини: не внесли оплату в журнал, дубль доходу, повернення без витрати, ручна витрата без категорії.';
  const text =
    `🧾 <b>Звірка каси</b>\n━━━━━━━━━━━━━━━\n` +
    `Очікуваний дохід: <b>${money(data.expectedIncome)}</b>\n` +
    `Внесено доходів: <b>${money(data.income)}</b>\n` +
    `Витрати: <b>${money(data.expense)}</b>\n` +
    `Повернення: <b>${money(data.returnsExpense)}</b>\n` +
    `Чистий результат: <b>${money(data.profit)}</b>\n` +
    `Різниця: <b>${money(data.difference)}</b>\n\n` +
    `<i>${esc(reasons)}</i>`;
  await reply(chatId, text, financeMenuKb(), msgId);
}

async function showCrmSummary(chatId, period = 'today', view = 'overview', msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${period}`);
  if (!data || data.error) {
    return reply(chatId, '❌ CRM статистика поки не підключена на сервері.', crmMenuKb(), msgId);
  }
  const label = { today: 'сьогодні', week: 'тиждень', month: 'місяць' }[period] || period;
  const text =
    `📊 <b>CRM — ${esc(label)}</b>\n━━━━━━━━━━━━━━━\n` +
    `Заявок: <b>${esc(data.orders || 0)}</b>\n` +
    `Нові: <b>${esc(data.newOrders || 0)}</b>\n` +
    `Підтверджені: <b>${esc(data.confirmedOrders || 0)}</b>\n` +
    `Відправлені: <b>${esc(data.shippedOrders || 0)}</b>\n` +
    `Оплачені: <b>${esc(data.paidOrders || 0)}</b>\n` +
    `Повернення: <b>${esc(data.returns || 0)}</b>\n` +
    `Без ТТН: <b>${esc(data.withoutTtn || 0)}</b>\n` +
    `Не оплачені: <b>${esc(data.unpaid || 0)}</b>\n\n` +
    `Дохід: <b>${money(data.income)}</b>\n` +
    `Витрати: <b>${money(data.expense)}</b>\n` +
    `Реклама: <b>${money(data.adsExpense)}</b>\n` +
    `Чистий прибуток: <b>${money(data.profit)}</b>`;
  await reply(chatId, text, crmMenuKb(), msgId);
}

async function showProblems(chatId, msgId = null) {
  const data = await serverGet('/api/admin/crm/problems');
  if (!data || data.error || !Array.isArray(data.orders)) {
    return reply(chatId, '❌ Проблемні замовлення поки не підключені на сервері.', crmMenuKb(), msgId);
  }
  if (!data.orders.length) return reply(chatId, '🧾 <b>Проблемних замовлень немає.</b>', crmMenuKb(), msgId);
  let text = `🧾 <b>Проблемні замовлення</b> (${data.orders.length})\n━━━━━━━━━━━━━━━\n\n`;
  data.orders.slice(0, 20).forEach(o => {
    text += `${statusEmoji(o.status)} <b>#${esc(o.id)}</b> ${esc(o.name || '—')}\n<i>${esc((o.problems || []).join('; '))}</i>\n\n`;
  });
  await reply(chatId, text, {
    inline_keyboard: [
      ...data.orders.slice(0, 10).map(o => [{ text: `Відкрити #${o.id}`, callback_data: `od_${o.id}` }]),
      [{ text: '← CRM', callback_data: 'crm_menu' }],
    ],
  }, msgId);
}

async function showAdsReport(chatId, period = 'today', msgId = null) {
  const data = await serverGet(`/api/admin/finance/summary?period=${period}`);
  if (!data || data.error) return reply(chatId, '❌ Рекламний звіт поки не підключено на сервері.', adsMenuKb(), msgId);
  const label = { today: 'сьогодні', week: 'тиждень', month: 'місяць' }[period] || period;
  const text =
    `📣 <b>Реклама — ${esc(label)}</b>\n━━━━━━━━━━━━━━━\n` +
    `Рекламні витрати: <b>${money(data.adsExpense)}</b>\n` +
    `Заявок: <b>${esc(data.orders || 0)}</b>\n` +
    `Підтверджених: <b>${esc(data.confirmedOrders || 0)}</b>\n` +
    `Оплачених: <b>${esc(data.paidOrders || 0)}</b>`;
  await reply(chatId, text, adsMenuKb(), msgId);
}

/* ═══════════════════════════════════════════════════════════
   ANALYTICS DASHBOARD
   Full UI with sub-menu inside Telegram bot
═══════════════════════════════════════════════════════════ */

/** Inline keyboard for analytics period/topic selection */
function analyticsMenuKb() {
  return {
    inline_keyboard: [
      [
        { text: '⚡ Остання година', callback_data: 'an_hour' },
        { text: '📅 Сьогодні',       callback_data: 'an_today' },
      ],
      [
        { text: '📆 Тиждень',        callback_data: 'an_week' },
        { text: '🔄 Оновити',        callback_data: 'an_today' },
      ],
      [
        { text: '📜 Скрол',          callback_data: 'an_scroll_today' },
        { text: '🖱 Кліки',          callback_data: 'an_clicks_today' },
      ],
      [
        { text: '📋 Воронка',        callback_data: 'an_funnel_today' },
        { text: '🕒 Дії',            callback_data: 'an_actions_today' },
      ],
    ],
  };
}

async function showAnalyticsMenu(chatId, msgId = null) {
  const text =
    `📈 <b>Аналітика Violet Motion</b>\n━━━━━━━━━━━━━━━\n` +
    `Оберіть звіт:\n\n` +
    `⚡ <i>Остання година</i> — активність прямо зараз\n` +
    `📅 <i>Сьогодні</i> — загальний денний підсумок\n` +
    `📜 <i>Скрол</i> — яких секцій досягають\n` +
    `🖱 <i>Кліки</i> — популярні кнопки\n` +
    `📋 <i>Воронка</i> — форма замовлення\n` +
    `🕒 <i>Дії</i> — останні 10 подій`;
  reply(chatId, text, analyticsMenuKb(), msgId);
}

/**
 * Fetch analytics summary from server and format it for Telegram.
 * period: 'hour' | 'today' | 'week'
 * view:   'overview' | 'scroll' | 'clicks' | 'funnel' | 'actions'
 */
async function showAnalyticsReport(chatId, period, view = 'overview', msgId = null) {
  const data = await serverGet(`/api/analytics/summary?period=${period}`);

  if (!data) {
    return reply(chatId, '❌ Аналітика недоступна. Перевірте сервер.', analyticsMenuKb(), msgId);
  }

  const periodLabel = { hour: 'Остання година', today: 'Сьогодні', week: 'Тиждень' }[period] || period;
  const now = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  let text = '';

  if (view === 'overview') {
    const { sessions, formFunnel, activeLastHour } = data;
    const durStr = fmtDuration(sessions.avgDuration);
    const bounce = sessions.bounceRate !== undefined
      ? Math.round(sessions.bounceRate * 100) + '%' : '—';

    text =
      `📈 <b>Аналітика — ${periodLabel}</b>\n` +
      `📅 ${now}\n━━━━━━━━━━━━━━━━━━\n\n` +
      `👥 <b>Сесії</b>\n` +
      `   Всього: <b>${sessions.total}</b>  |  Унікальних: <b>${sessions.unique}</b>\n` +
      `   Час на сайті: <b>${durStr}</b>\n` +
      `   Відмов: <b>${bounce}</b>\n` +
      `   Активних за годину: <b>${activeLastHour}</b>\n\n` +
      `📋 <b>Воронка форми</b>\n` +
      `   👀 Переглянули форму: <b>${formFunnel.started || 0}</b>\n` +
      `   ✍️ Заповнили: <b>${formFunnel.submitted || 0}</b>\n` +
      `   ✅ Успішно: <b>${formFunnel.succeeded || 0}</b>`;

    if (formFunnel.started > 0) {
      const conv = pct(formFunnel.succeeded || 0, formFunnel.started);
      text += `\n   🎯 Конверсія: <b>${conv}</b>`;
    }
    text += `\n━━━━━━━━━━━━━━━━━━`;

  } else if (view === 'scroll') {
    const { scrollDepth, sessions } = data;
    const maxVal = Math.max(...Object.values(scrollDepth), 1);
    text =
      `📜 <b>Глибина скролу — ${periodLabel}</b>\n` +
      `👥 Всього сесій: ${sessions.total}\n━━━━━━━━━━━━━━━━━━\n\n`;

    const rows = [
      { label: '25%  — Фічі',   key: 25 },
      { label: '50%  — Відгуки',key: 50 },
      { label: '75%  — Форма',  key: 75 },
      { label: '90%  — Відгуки',key: 90 },
      { label: '100% — Кінець', key: 100 },
    ];
    rows.forEach(row => {
      const v = scrollDepth[row.key] || 0;
      const p = sessions.total ? pct(v, sessions.total) : '0%';
      text += `${row.label}\n`;
      text += `${bar(v, maxVal, 12)} ${v} (${p})\n\n`;
    });
    text += `━━━━━━━━━━━━━━━━━━\n<i>% від загальних сесій</i>`;

  } else if (view === 'clicks') {
    const { topButtons } = data;
    if (!topButtons || !topButtons.length) {
      text = `🖱 <b>Кліки — ${periodLabel}</b>\n\nДаних ще немає.`;
    } else {
      const maxClicks = Math.max(...topButtons.map(b => b.count), 1);
      text = `🖱 <b>Кліки по кнопках — ${periodLabel}</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
      const labelMap = {
        hero_cta:     '🟣 Головна CTA',
        sale_cta:     '🔥 Акція CTA',
        visual_cta:   '👁 Візуал CTA',
        float_cta:    '💜 Плавоча кнопка',
        order_submit: '📤 Відправити форму',
        review_submit:'💬 Відправити відгук',
        support_open: '🎧 Відкрити чат',
        size_select:  '👟 Вибір розміру',
        gallery_thumb:'🖼 Галерея',
        hero_details: '👁 Подивитись деталі',
      };
      topButtons.forEach((b, i) => {
        const lbl = labelMap[b.label] || b.label;
        text += `${i + 1}. ${lbl}\n`;
        text += `   ${bar(b.count, maxClicks, 10)} <b>${b.count}</b>\n\n`;
      });
      text += `━━━━━━━━━━━━━━━━━━`;
    }

  } else if (view === 'funnel') {
    const { formFunnel, sessions } = data;
    const started   = formFunnel.started   || 0;
    const submitted = formFunnel.submitted || 0;
    const succeeded = formFunnel.succeeded || 0;
    const maxF      = Math.max(started, 1);

    text =
      `📋 <b>Воронка замовлення — ${periodLabel}</b>\n` +
      `👥 Сесій: ${sessions.total}\n━━━━━━━━━━━━━━━━━━\n\n` +
      `1. 👀 Відкрили форму\n` +
      `   ${bar(started, maxF, 12)} <b>${started}</b>\n\n` +
      `2. ✍️ Заповнили (Submit)\n` +
      `   ${bar(submitted, maxF, 12)} <b>${submitted}</b>` +
      (started > 0 ? ` (${pct(submitted, started)})` : '') + '\n\n' +
      `3. ✅ Успішно оформили\n` +
      `   ${bar(succeeded, maxF, 12)} <b>${succeeded}</b>` +
      (submitted > 0 ? ` (${pct(succeeded, submitted)})` : '') + '\n\n' +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🎯 Загальна конверсія: <b>${sessions.total > 0 ? pct(succeeded, sessions.total) : '0%'}</b>`;

  } else if (view === 'actions') {
    const { lastActions } = data;
    if (!lastActions || !lastActions.length) {
      text = `🕒 <b>Останні дії — ${periodLabel}</b>\n\nДаних ще немає.`;
    } else {
      text = `🕒 <b>Останні дії</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
      const emojiMap = {
        page_view:    '🌐', scroll_depth: '📜', button_click: '🖱',
        form_start:   '✍️', form_submit:   '📤', order_success: '✅',
        support_open: '🎧', size_select:   '👟', gallery_click: '🖼',
        session_end:  '🔚',
      };
      lastActions.slice(0, 10).forEach(ev => {
        const emoji = emojiMap[ev.event] || '·';
        const time  = ev.timestamp
          ? new Date(ev.timestamp).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' })
          : '—';
        let detail = '';
        if (ev.event === 'scroll_depth')  detail = ` ${ev.data?.depth}%`;
        if (ev.event === 'button_click')  detail = ` ${ev.data?.label || ''}`;
        if (ev.event === 'order_success') detail = ` р.${ev.data?.size || '?'}`;
        if (ev.event === 'size_select')   detail = ` ${ev.data?.size || ''}`;
        if (ev.event === 'session_end')   detail = ` ${fmtDuration(ev.data?.duration)}`;
        text += `${emoji} <code>${time}</code> <b>${ev.event}</b>${detail}\n`;
      });
      text += `\n━━━━━━━━━━━━━━━━━━`;
    }
  }

  reply(chatId, text, analyticsMenuKb(), msgId);
}

/* ═══════════════════════════════════════════════════════════
   COMMANDS
═══════════════════════════════════════════════════════════ */
bot.onText(/\/id/, async msg => {
  await bot.sendMessage(msg.chat.id,
    `Ваш Telegram ID: <code>${esc(msg.from.id)}</code>\nChat ID: <code>${esc(msg.chat.id)}</code>\nUsername: ${msg.from.username ? '@' + esc(msg.from.username) : '—'}`,
    { parse_mode: 'HTML' });
});

bot.onText(/\/start/, async msg => {
  if (!isAdmin(msg.from.id)) { logDenied(msg, '/start'); return; }
  await bot.sendMessage(msg.chat.id,
    `🟣 <b>Violet Motion — Адмін панель</b>\n\nОберіть розділ кнопками нижче:`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB });
});

bot.onText(/\/analytics/, msg => { if (!isAdmin(msg.from.id)) { logDenied(msg, '/analytics'); return; } showAnalyticsMenu(msg.chat.id); });
bot.onText(/\/search (.+)/, (msg, match) => { if (!isAdmin(msg.from.id)) { logDenied(msg, '/search'); return; } showOrders(msg.chat.id, 1, match[1].trim().toLowerCase()); });
bot.onText(/\/orders/,  msg => { if (!isAdmin(msg.from.id)) { logDenied(msg, '/orders'); return; } showOrders(msg.chat.id); });
bot.onText(/\/reviews/, msg => { if (!isAdmin(msg.from.id)) { logDenied(msg, '/reviews'); return; } showReviews(msg.chat.id); });
bot.onText(/\/support/, msg => { if (!isAdmin(msg.from.id)) { logDenied(msg, '/support'); return; } showSupport(msg.chat.id); });
bot.onText(/\/stats/,   msg => { if (!isAdmin(msg.from.id)) { logDenied(msg, '/stats'); return; } showStats(msg.chat.id); });

async function addFinanceEntry(payload) {
  return serverPost('/api/admin/finance', {
    ...payload,
    amount: asNumber(payload.amount),
    createdAt: payload.createdAt || new Date().toISOString(),
  });
}

async function addOrderExpense(orderId, title, amount, category = 'order') {
  const posted = await serverPost(`/api/admin/orders/${orderId}/expense`, { title, amount, category });
  if (posted && !posted.error) return posted;
  const order = await serverGet(`/api/admin/orders/${orderId}`);
  if (!order || order.error) return null;
  const expenses = Array.isArray(order.expenses) ? order.expenses : [];
  return serverPatch(`/api/admin/orders/${orderId}`, {
    expenses: [...expenses, { title, amount, category, createdAt: new Date().toISOString() }],
  });
}

async function saveOrderComment(orderId, comment) {
  const posted = await serverPost(`/api/admin/orders/${orderId}/comment`, { comment });
  if (posted && !posted.error) return posted;
  return serverPatch(`/api/admin/orders/${orderId}`, { managerComment: comment });
}

async function addNetIncome(orderId, title, price, cost) {
  const net = asNumber(price) - asNumber(cost);
  if (net <= 0) return { net, saved: null };
  const saved = await addFinanceEntry({
    type: 'income',
    source: 'order',
    category: 'net_order',
    orderId,
    amount: net,
    title,
  });
  return { net, saved };
}

async function settleOrderPayment(chatId, orderId, scope, baseCost = null, msgId = null) {
  const order = await serverGet(`/api/admin/orders/${orderId}`);
  if (!order || order.error) {
    await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB });
    return;
  }

  const now = new Date().toISOString();
  const patch = {};
  const upsell = hasUpsell(order) ? { ...order.upsell } : null;
  const includeBase = scope === 'base' || scope === 'both' || !upsell;
  const includeUpsell = !!upsell && (scope === 'upsell' || scope === 'both');
  const lines = [];

  if (baseCost !== null) patch.cost = baseCost;
  const effectiveBaseCost = baseCost !== null ? baseCost : asNumber(order.cost);

  if (includeBase && !order.baseIncomePosted) {
    const { net } = await addNetIncome(orderId, `Чистий дохід замовлення #${orderId}`, order.price, effectiveBaseCost);
    patch.baseIncomePosted = true;
    patch.basePaidAt = now;
    lines.push(`👟 Кросівки: ${money(order.price)} - ${money(effectiveBaseCost)} = <b>${money(net)}</b>`);
  }

  if (includeUpsell && upsell && !upsell.incomePosted) {
    const { net } = await addNetIncome(orderId, `Чистий дохід апселлу #${orderId}`, upsell.price, upsell.cost);
    upsell.incomePosted = true;
    upsell.paymentStatus = 'paid';
    upsell.paidAt = now;
    lines.push(`➕ Апселл: ${money(upsell.price)} - ${money(upsell.cost)} = <b>${money(net)}</b>`);
  }

  const basePaid = !!(patch.baseIncomePosted || order.baseIncomePosted || order.basePaidAt);
  const upsellPaid = !upsell || !!(upsell.incomePosted || upsell.paidAt);
  if (upsell) patch.upsell = upsell;
  patch.paymentStatus = basePaid && upsellPaid ? 'paid' : 'partially_paid';
  patch.status = basePaid && upsellPaid ? 'paid' : (order.status === 'paid' ? 'paid' : order.status || 'shipped');
  patch.paidScope = scope;
  if (basePaid && upsellPaid) patch.paidAt = now;

  const updated = await serverPatch(`/api/admin/orders/${orderId}`, patch);
  if (!updated || updated.error) {
    await bot.sendMessage(chatId, '❌ Не вдалося змінити оплату.', { reply_markup: MAIN_KB });
    return;
  }

  await bot.sendMessage(chatId,
    `✅ Оплату зараховано: <b>${esc(paymentScopeLabel(scope))}</b>\n` +
    (lines.length ? lines.join('\n') : 'Дохід вже був зарахований раніше.'),
    { parse_mode: 'HTML', reply_markup: MAIN_KB });
  await showOrderDetail(chatId, orderId, msgId);
}

async function handleCrmPendingMessage(chatId, text) {
  const pending = crmPendingInput[chatId];
  if (!pending) return false;
  const age = Date.now() - new Date(pending.createdAt).getTime();
  if (age > 30 * 60 * 1000) {
    clearCrmPending(chatId);
    await bot.sendMessage(chatId, '⌛ Ввід застарів. Натисніть потрібну кнопку ще раз.', { reply_markup: MAIN_KB });
    return true;
  }

  const id = pending.orderId;
  const askAmountAgain = '❌ Сума некоректна. Введіть додатне число без мінуса.';
  const askTitleAmountAgain = '❌ Формат некоректний. Введіть суму числом або так: Назва | Сума';

  if (pending.action === 'ttn') {
    const ttn = text.trim();
    if (!ttn) {
      await bot.sendMessage(chatId, '❌ Введіть ТТН текстом.');
      return true;
    }
    const updated = await serverPatch(`/api/admin/orders/${id}`, { ttn, status: 'shipped', deliveryStatus: 'shipped' });
    clearCrmPending(chatId);
    if (!updated || updated.error) await bot.sendMessage(chatId, '❌ Не вдалося зберегти ТТН.', { reply_markup: MAIN_KB });
    else await showOrderDetail(chatId, id);
    return true;
  }

  if (pending.action === 'price' || pending.action === 'cost') {
    const amount = parseAmount(text);
    if (amount === null) {
      await bot.sendMessage(chatId, askAmountAgain);
      return true;
    }
    const field = pending.action === 'price' ? 'price' : 'cost';
    const updated = await serverPatch(`/api/admin/orders/${id}`, { [field]: amount });
    clearCrmPending(chatId);
    if (!updated || updated.error) await bot.sendMessage(chatId, '❌ Не вдалося зберегти суму.', { reply_markup: MAIN_KB });
    else await showOrderDetail(chatId, id);
    return true;
  }

  if (pending.action === 'paid_cost') {
    const amount = parseAmount(text);
    if (amount === null) {
      await bot.sendMessage(chatId, askAmountAgain);
      return true;
    }
    clearCrmPending(chatId);
    await settleOrderPayment(chatId, id, pending.scope || 'base', amount);
    return true;
  }

  if (pending.action === 'upsell_name') {
    const name = text.trim().slice(0, 120);
    if (!name) {
      await bot.sendMessage(chatId, '❌ Введіть назву товару.');
      return true;
    }
    setCrmPending(chatId, 'upsell_price', id, { upsellName: name });
    await bot.sendMessage(chatId, '💵 Введіть ціну апселлу для клієнта:');
    return true;
  }

  if (pending.action === 'upsell_price') {
    const amount = parseAmount(text);
    if (amount === null) {
      await bot.sendMessage(chatId, askAmountAgain);
      return true;
    }
    setCrmPending(chatId, 'upsell_cost', id, { upsellName: pending.upsellName, upsellPrice: amount });
    await bot.sendMessage(chatId, '🏷 Введіть собівартість апселлу:');
    return true;
  }

  if (pending.action === 'upsell_cost') {
    const amount = parseAmount(text);
    if (amount === null) {
      await bot.sendMessage(chatId, askAmountAgain);
      return true;
    }
    const updated = await serverPatch(`/api/admin/orders/${id}`, {
      upsell: {
        name: pending.upsellName,
        price: pending.upsellPrice,
        cost: amount,
        paymentStatus: 'unpaid',
        createdAt: new Date().toISOString(),
      },
    });
    clearCrmPending(chatId);
    if (!updated || updated.error) await bot.sendMessage(chatId, '❌ Не вдалося зберегти апселл.', { reply_markup: MAIN_KB });
    else await showOrderDetail(chatId, id);
    return true;
  }

  if (pending.action === 'order_expense' || pending.action === 'return_expense') {
    let parsed = parseTitledAmount(text);
    if (!parsed) {
      const amount = parseAmount(text);
      if (amount !== null) parsed = { title: pending.action === 'return_expense' ? 'Втрати на поверненні' : 'Витрата по замовленню', amount };
    }
    if (!parsed) {
      await bot.sendMessage(chatId, pending.action === 'return_expense' ? askAmountAgain : askTitleAmountAgain);
      return true;
    }
    const category = pending.action === 'return_expense' ? 'return' : 'order';
    const updated = await addOrderExpense(id, parsed.title, parsed.amount, category);
    await addFinanceEntry({ type: 'expense', title: `${parsed.title} #${id}`, amount: parsed.amount, category, source: 'order', orderId: id });
    clearCrmPending(chatId);
    if (!updated || updated.error) await bot.sendMessage(chatId, '❌ Не вдалося зберегти витрату.', { reply_markup: MAIN_KB });
    else await showOrderDetail(chatId, id);
    return true;
  }

  if (pending.action === 'comment') {
    const updated = await saveOrderComment(id, text);
    clearCrmPending(chatId);
    if (!updated || updated.error) await bot.sendMessage(chatId, '❌ Не вдалося зберегти коментар.', { reply_markup: MAIN_KB });
    else await showOrderDetail(chatId, id);
    return true;
  }

  if (['income', 'expense', 'ads'].includes(pending.action)) {
    let parsed = parseTitledAmount(text);
    if (!parsed) {
      const amount = parseAmount(text);
      if (amount !== null) {
        const titleMap = {
          income: 'Дохід вручну',
          expense: 'Витрата вручну',
          ads: 'Реклама',
        };
        parsed = { title: titleMap[pending.action], amount };
      }
    }
    if (!parsed) {
      await bot.sendMessage(chatId, askTitleAmountAgain);
      return true;
    }
    const payload = {
      type: pending.action === 'income' ? 'income' : 'expense',
      title: parsed.title,
      amount: parsed.amount,
      category: pending.action === 'ads' ? 'ads' : 'manual',
      source: pending.action === 'ads' ? 'ads' : 'manual',
    };
    const saved = await addFinanceEntry(payload);
    clearCrmPending(chatId);
    if (!saved || saved.error) await bot.sendMessage(chatId, '❌ Фінансовий запис не збережено. Endpoint поки не підключено.', { reply_markup: MAIN_KB });
    else await bot.sendMessage(chatId, `✅ Запис збережено: <b>${esc(parsed.title)}</b> — ${money(parsed.amount)}`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
    return true;
  }

  clearCrmPending(chatId);
  return false;
}

/* ═══════════════════════════════════════════════════════════
   TEXT MESSAGES
═══════════════════════════════════════════════════════════ */
bot.on('message', async msg => {
  const messageKey = `${msg.chat?.id || 'unknown'}_${msg.message_id}`;
  if (recentlyHandled(seenMessages, messageKey, 30000)) return;
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAdmin(msg.from.id)) { logDenied(msg); return; }

  const chatId = msg.chat.id;
  const text   = msg.text.trim();
  const inDialog = !!managerDialogs[chatId];

  if (inDialog && text !== '🔚 Завершити діалог') {
    await serverPost('/api/support/relay', {
      sessionId:   managerDialogs[chatId],
      text,
      managerName: msg.from.first_name || 'Оператор',
    });
    return;
  }

  if (text === '🔚 Завершити діалог' && inDialog) {
    const sessionId = managerDialogs[chatId];
    delete managerDialogs[chatId];
    await serverPost('/api/support/end', { sessionId });
    await bot.sendMessage(chatId, '✅ Діалог завершено. Клієнт отримав повідомлення.', { reply_markup: MAIN_KB });
    return;
  }

  if (inDialog) {
    await bot.sendMessage(chatId, 'ℹ️ Спочатку завершіть активний діалог — 🔚 Завершити діалог', { reply_markup: DIALOG_KB });
    return;
  }

  if (MAIN_ACTIONS.has(text)) {
    delete pendingSearch[chatId];
    clearCrmPending(chatId);
    if (recentlyHandled(recentActions, `${chatId}_${text}`)) return;
  } else if (crmPendingInput[chatId]) {
    const handled = await handleCrmPendingMessage(chatId, text);
    if (handled) return;
  }

  switch (text) {
    case '📦 Замовлення':  await showOrders(chatId);       break;
    case '💬 Відгуки':     await showReviews(chatId);      break;
    case '🎧 Підтримка':   await showSupport(chatId);      break;
    case '📊 Статистика':  await showStats(chatId);        break;
    case '📈 Аналітика':   await showAnalyticsMenu(chatId); break;
    case '💰 Фінанси':     await showFinanceMenu(chatId);  break;
    case '📊 CRM':         await showCrmMenu(chatId);      break;
    case '📣 Реклама':     await showAdsMenu(chatId);      break;

    case '🔍 Пошук':
      pendingSearch[chatId] = true;
      await bot.sendMessage(chatId, "🔍 Введіть ім'я, телефон, розмір, ID, ТТН або статус:", {
        reply_markup: { inline_keyboard: [[{ text: '← Скасувати', callback_data: 'orders' }]] },
      });
      break;

    case '❓ Допомога':
      await bot.sendMessage(chatId,
        `<b>Команди:</b>\n/orders — замовлення\n/reviews — відгуки\n/support — підтримка\n/stats — статистика\n/analytics — аналітика\n/search Ім'я — пошук\n\n` +
        `💰 <b>Фінанси:</b> доходи, витрати, баланс, звірка каси.\n` +
        `📊 <b>CRM:</b> статуси, доставка, повернення, проблемні замовлення.\n` +
        `📣 <b>Реклама:</b> витрати та ціна заявки/замовлення.\n\n` +
        `📈 <b>Аналітика:</b> кнопка в меню або /analytics\nПоказує: сесії, скрол, кліки, воронку, останні дії.\n\n` +
        `💬 <b>Підтримка:</b> коли приймаєте діалог — всі ваші повідомлення йдуть клієнту у реальному часі. Для завершення — 🔚 Завершити діалог`,
        { parse_mode: 'HTML', reply_markup: MAIN_KB }
      );
      break;

    default:
      if (pendingSearch[chatId]) {
        delete pendingSearch[chatId];
        await showOrders(chatId, 1, `q:${text.toLowerCase()}`);
      }
  }
});

/* ═══════════════════════════════════════════════════════════
   CALLBACK QUERIES
═══════════════════════════════════════════════════════════ */
bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  const msgId  = q.message.message_id;
  const data   = q.data;
  const cbKey  = `${chatId}_${msgId}_${data}`;

  if (!isAdmin(q.from.id)) { logDenied({ from: q.from, chat: q.message?.chat }, 'callback'); await ack(q.id, '🚫 Доступ заборонено.'); return; }
  if (data === 'noop')      { await ack(q.id); return; }
  clearCrmPending(chatId);

  if (pendingCb.has(cbKey)) { await ack(q.id, '⏳ Зачекайте…'); return; }
  pendingCb.add(cbKey);
  await ack(q.id);

  try {
    if (data === 'main') {
      await reply(chatId, '🟣 <b>Violet Motion — Адмін панель</b>\n\nОберіть розділ кнопками нижче:', MAIN_KB, msgId);
      return;
    }

    /* ─ Analytics callbacks ─────────────────────────────── */
    if (data === 'an_menu') { await showAnalyticsMenu(chatId, msgId); return; }

    if (data.startsWith('an_')) {
      const parts = data.slice(3).split('_'); // e.g. "hour" | "scroll_today" | "clicks_today"
      // Format: an_<view>_<period> or an_<period>
      let period = 'today';
      let view   = 'overview';

      if (parts.length === 1) {
        // an_hour | an_today | an_week
        if (['hour','today','week'].includes(parts[0])) period = parts[0];
        else view = parts[0];
      } else {
        // an_scroll_today | an_clicks_today | an_funnel_today | an_actions_today
        view   = parts[0];
        period = parts[1] || 'today';
      }

      await showAnalyticsReport(chatId, period, view, msgId);
      return;
    }

    /* ─ CRM / Finance callbacks ─────────────────────────── */
    if (data === 'fi_menu') { await showFinanceMenu(chatId, msgId); return; }
    if (data === 'crm_menu') { await showCrmMenu(chatId, msgId); return; }
    if (data === 'ad_menu') { await showAdsMenu(chatId, msgId); return; }

    if (data === 'fi_add_i' || data === 'fi_add_e') {
      setCrmPending(chatId, data === 'fi_add_i' ? 'income' : 'expense');
      await bot.sendMessage(chatId, data === 'fi_add_i'
        ? '➕ Введіть суму доходу. Можна просто: 895\nАбо з назвою: Оплата замовлення #15 | 895'
        : '➖ Введіть суму витрати. Можна просто: 440\nАбо з назвою: Реклама Facebook | 440', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '← Скасувати', callback_data: 'fi_menu' }]] },
      });
      return;
    }

    if (data === 'fi_today' || data === 'fi_week' || data === 'fi_month' || data === 'fi_balance') {
      const period = data === 'fi_balance' ? 'all' : data.replace('fi_', '');
      await showFinanceSummary(chatId, period, msgId);
      return;
    }

    if (data === 'fi_cash') { await showCashReconciliation(chatId, msgId); return; }

    if (data === 'crm_today' || data === 'crm_week' || data === 'crm_month') {
      await showCrmSummary(chatId, data.replace('crm_', ''), 'overview', msgId);
      return;
    }
    if (data === 'crm_prob') { await showProblems(chatId, msgId); return; }
    if (data === 'crm_orders') { await showOrders(chatId, 1, null, msgId); return; }
    if (data === 'crm_fin') { await showFinanceSummary(chatId, 'month', msgId); return; }
    if (data === 'crm_ads') { await showAdsReport(chatId, 'month', msgId); return; }
    if (data === 'crm_ship') { await showOrders(chatId, 1, 'st:shipped', msgId); return; }
    if (data === 'crm_ret') { await showOrders(chatId, 1, 'st:returned', msgId); return; }

    if (data === 'ad_add') {
      setCrmPending(chatId, 'ads');
      await bot.sendMessage(chatId, '📣 Введіть суму реклами. Можна просто: 440\nАбо з назвою: Facebook | 440', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '← Скасувати', callback_data: 'ad_menu' }]] },
      });
      return;
    }
    if (data === 'ad_today' || data === 'ad_week' || data === 'ad_month') {
      await showAdsReport(chatId, data.replace('ad_', ''), msgId);
      return;
    }

    /* ─ Orders ──────────────────────────────────────────── */
    if (data === 'orders') { await showOrders(chatId, 1, null, msgId); return; }

    if (data.startsWith('of_')) {
      const key = data.slice(3);
      const map = {
        all: null, new: 'st:new', confirmed: 'st:confirmed', cancelled: 'st:cancelled',
        shipped: 'st:shipped', paid: 'st:paid', returned: 'st:returned',
        completed: 'st:completed', no_ttn: 'no_ttn', unpaid: 'unpaid',
      };
      await showOrders(chatId, 1, map[key] || null, msgId);
      return;
    }

    if (data.startsWith('op_')) {
      const [pageStr, filterStr] = data.replace('op_', '').split('_f_');
      await showOrders(chatId, Number(pageStr), filterStr || null, msgId);
      return;
    }

    if (data.startsWith('od_')) { await showOrderDetail(chatId, Number(data.slice(3)), msgId); return; }

    if (data.startsWith('os_')) {
      const [, idStr, code] = data.split('_');
      const id = Number(idStr);
      const order = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }

      if (code === 'p') {
        if (hasUpsell(order)) {
          await bot.sendMessage(chatId, '💳 Що оплатив клієнт?', {
            parse_mode: 'HTML',
            reply_markup: paymentScopeKeyboard(id),
          });
          return;
        }
        setCrmPending(chatId, 'paid_cost', id, { scope: 'base' });
        await bot.sendMessage(chatId, '🏷 Впишіть собівартість товару:');
        return;
      }

      if (code === 'r') {
        if (hasUpsell(order)) {
          await bot.sendMessage(chatId, '↩️ Що повернув клієнт?', {
            parse_mode: 'HTML',
            reply_markup: returnScopeKeyboard(id),
          });
          return;
        }
        const updated = await serverPatch(`/api/admin/orders/${id}`, {
          paymentStatus: 'returned', status: 'returned', returnedAt: new Date().toISOString(), returnScope: 'base',
        });
        if (!updated || updated.error) { await bot.sendMessage(chatId, '❌ Не вдалося оформити повернення.', { reply_markup: MAIN_KB }); return; }
        setCrmPending(chatId, 'return_expense', id, { scope: 'base' });
        await bot.sendMessage(chatId, '↩️ Введіть суму втрат на доставці/поверненні:', { parse_mode: 'HTML' });
        return;
      }

      const statusMap = { c: 'confirmed', x: 'cancelled', d: 'completed' };
      const status = statusMap[code];
      if (status) {
        const updated = await serverPatch(`/api/admin/orders/${id}`, { status });
        if (!updated || updated.error) { await bot.sendMessage(chatId, '❌ Не вдалося змінити статус.', { reply_markup: MAIN_KB }); return; }
        await showOrderDetail(chatId, id, msgId);
        return;
      }
    }

    if (data.startsWith('oi_')) {
      const [, idStr, code] = data.split('_');
      const id = Number(idStr);
      const prompts = {
        tt: ['ttn', '📦 Введіть ТТН для замовлення:'],
        pr: ['price', '✏️ Введіть ціну продажу числом:'],
        co: ['cost', '✏️ Введіть собівартість числом:'],
        ex: ['order_expense', '➕ Введіть витрату у форматі: Назва | Сума'],
        cm: ['comment', '📝 Введіть коментар менеджера:'],
        up: ['upsell_name', '➕ Введіть назву товару для апселлу:'],
      };
      const item = prompts[code];
      if (item) {
        setCrmPending(chatId, item[0], id);
        await bot.sendMessage(chatId, item[1], {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '← Скасувати', callback_data: `od_${id}` }]] },
        });
        return;
      }
    }

    if (data.startsWith('pay_')) {
      const [, idStr, scope] = data.split('_');
      const id = Number(idStr);
      const order = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }
      if ((scope === 'base' || scope === 'both') && !asNumber(order.cost)) {
        setCrmPending(chatId, 'paid_cost', id, { scope });
        await bot.sendMessage(chatId, '🏷 Впишіть собівартість кросівок:');
        return;
      }
      await settleOrderPayment(chatId, id, scope, null, msgId);
      return;
    }

    if (data.startsWith('ret_')) {
      const [, idStr, scope] = data.split('_');
      const id = Number(idStr);
      const order = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }
      const upsell = hasUpsell(order) ? { ...order.upsell } : null;
      if (upsell && (scope === 'upsell' || scope === 'both')) {
        upsell.returnStatus = 'returned';
        upsell.returnedAt = new Date().toISOString();
      }
      const patch = {
        returnScope: scope,
        returnedAt: new Date().toISOString(),
        paymentStatus: scope === 'both' ? 'returned' : 'partially_returned',
        status: scope === 'both' ? 'returned' : (order.status || 'shipped'),
      };
      if (upsell) patch.upsell = upsell;
      if (scope === 'base' || scope === 'both') patch.baseReturnStatus = 'returned';
      const updated = await serverPatch(`/api/admin/orders/${id}`, patch);
      if (!updated || updated.error) { await bot.sendMessage(chatId, '❌ Не вдалося оформити повернення.', { reply_markup: MAIN_KB }); return; }
      setCrmPending(chatId, 'return_expense', id, { scope });
      await bot.sendMessage(chatId, `↩️ Введіть суму втрат на поверненні (${esc(paymentScopeLabel(scope))}):`, { parse_mode: 'HTML' });
      return;
    }

    if (data.startsWith('nt_')) {
      const id = Number(data.slice(3));
      const order = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }
      if (!order.ttn) { await bot.sendMessage(chatId, '❌ У замовленні немає ТТН.', { reply_markup: MAIN_KB }); return; }
      const track = await serverGet(`/api/admin/np/track/${encodeURIComponent(order.ttn)}`);
      if (!track || track.error) {
        await bot.sendMessage(chatId, '❌ Перевірка ТТН поки не підключена на сервері.', { reply_markup: MAIN_KB });
        return;
      }
      const text =
        `🔍 <b>ТТН ${esc(order.ttn)}</b>\n━━━━━━━━━━━━━━━\n` +
        `Статус посилки: <b>${esc(track.status || '—')}</b>\n` +
        `Місто: <b>${esc(track.city || '—')}</b>\n` +
        `Відділення: <b>${esc(track.warehouse || '—')}</b>\n` +
        `Дата відправки: <b>${esc(track.sentAt || '—')}</b>\n` +
        `Дата отримання: <b>${esc(track.receivedAt || '—')}</b>\n` +
        `Отримано: <b>${track.received ? 'так' : 'ні'}</b>\n` +
        `Повернення: <b>${track.returned ? 'так' : 'ні'}</b>`;
      await reply(chatId, text, { inline_keyboard: [[{ text: '← До замовлення', callback_data: `od_${id}` }]] }, msgId);
      return;
    }

    if (data.startsWith('do_')) {
      const id = Number(data.slice(3));
      const order = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }
      if (!['new', 'cancelled'].includes(order.status || 'new')) {
        await bot.sendMessage(chatId, `ℹ️ Замовлення #${id} вже оброблене, видалення недоступне.`, { reply_markup: MAIN_KB });
        return;
      }
      const deleted = await serverDelete(`/api/admin/orders/${id}`);
      if (!deleted || deleted.error) { await bot.sendMessage(chatId, `❌ Не вдалося видалити #${id}.`, { reply_markup: MAIN_KB }); return; }
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }); } catch {}
      await bot.sendMessage(chatId, `🗑 Замовлення #${id} видалено.`, { reply_markup: MAIN_KB });
      return;
    }

    if (data.startsWith('confirm_') || data.startsWith('cancel_')) {
      const isConf = data.startsWith('confirm_');
      const id     = Number(data.replace(isConf ? 'confirm_' : 'cancel_', ''));
      const order  = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }
      const updated = await serverPatch(`/api/admin/orders/${id}`, { status: isConf ? 'confirmed' : 'cancelled' });
      if (!updated || updated.error) { await bot.sendMessage(chatId, '❌ Не вдалося змінити статус.', { reply_markup: MAIN_KB }); return; }
      try {
        await bot.editMessageReplyMarkup({
          inline_keyboard: [[{ text: '📋 Відкрити замовлення', callback_data: `od_${id}` }]],
        }, { chat_id: chatId, message_id: msgId });
      } catch {}
      await bot.sendMessage(chatId,
        `${isConf ? '✅' : '❌'} Замовлення #${id} (${esc(updated.name)}) — <b>${isConf ? 'підтверджено' : 'скасовано'}</b>`,
        { parse_mode: 'HTML', reply_markup: MAIN_KB });
      return;
    }

    if (data.startsWith('del_order_')) {
      const id = Number(data.slice(10));
      const order = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }
      if (!['new', 'cancelled'].includes(order.status || 'new')) {
        await bot.sendMessage(chatId, `ℹ️ Замовлення #${id} вже оброблене, видалення недоступне.`, { reply_markup: MAIN_KB });
        return;
      }
      const deleted = await serverDelete(`/api/admin/orders/${id}`);
      if (!deleted || deleted.error) { await bot.sendMessage(chatId, `❌ Не вдалося видалити #${id}.`, { reply_markup: MAIN_KB }); return; }
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }); } catch {}
      await bot.sendMessage(chatId, `🗑 Замовлення #${id} видалено.`, { reply_markup: MAIN_KB });
      return;
    }

    /* ─ Reviews ─────────────────────────────────────────── */
    if (data.startsWith('rv_'))         { await showReviews(chatId, Number(data.slice(3)), msgId); return; }

    if (data.startsWith('del_review_')) {
      const id = Number(data.slice(11));
      const deleted = await serverDelete(`/api/admin/reviews/${id}`);
      if (!deleted || deleted.error) { await bot.sendMessage(chatId, `❌ Не вдалося видалити відгук #${id}.`, { reply_markup: MAIN_KB }); return; }
      await bot.sendMessage(chatId, `🗑 Відгук #${id} видалено.`, { reply_markup: MAIN_KB });
      return;
    }

    /* ─ Support ─────────────────────────────────────────── */
    if (data.startsWith('sp_'))         { await showSupport(chatId, Number(data.slice(3)), msgId); return; }

    if (data.startsWith('accept_')) {
      const sessionId = data.slice(7);
      const accepted = await serverPost('/api/support/accept', { sessionId, managerId: chatId });
      const activeSessionId = accepted?.sessionId || sessionId;
      managerDialogs[chatId] = activeSessionId;
      await bot.sendMessage(chatId,
        `✋ Ви прийняли діалог.\n\nСесія: <code>${esc(sessionId)}</code>\n\nПишіть — клієнт отримає ваші повідомлення в реальному часі.\nДля завершення натисніть 🔚 Завершити діалог`,
        { parse_mode: 'HTML', reply_markup: DIALOG_KB });
      return;
    }

    if (data.startsWith('answered_')) {
      const id      = Number(data.slice(9));
      const updated = await serverPatch(`/api/admin/support/${id}`, { answered: true });
      if (!updated || updated.error) { await bot.sendMessage(chatId, `❌ Не вдалося змінити статус #${id}.`, { reply_markup: MAIN_KB }); return; }
      await bot.sendMessage(chatId, `✅ Запит #${id} — відповіли.`, { reply_markup: MAIN_KB });
    }

  } finally {
    setTimeout(() => pendingCb.delete(cbKey), 2000);
  }
});

bot.on('polling_error', e => console.error('[poll]', e.message));
bot.on('error',         e => console.error('[bot]',  e.message));

/* ── Tiny web server for Render health check ──────────────── */
const express = require('express');
const webApp  = express();
webApp.get('/', (_req, res) => res.send('🟣 Violet Motion Bot is running'));
const BOT_PORT = process.env.PORT || 10000;
webApp.listen(BOT_PORT, () => console.log(`🌐 Health check → port ${BOT_PORT}`));
