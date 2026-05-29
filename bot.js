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

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',').map(s => Number(s.trim())).filter(Boolean);
const EXTRA_ADMIN_IDS = [7996143460];

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const API_KEY    = process.env.API_KEY    || 'violet-secret';

if (!TOKEN) { console.error('❌ BOT_TOKEN not set'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('🤖 Admin bot started…');

/* ── Auth ─────────────────────────────────────────────────── */
function isAdmin(id) { return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(id) || EXTRA_ADMIN_IDS.includes(id); }

/* ── State ────────────────────────────────────────────────── */
const managerDialogs = {};
const pendingSearch  = {};
const pendingDelivery = {};
const pendingTtn     = {};
const pendingNpSender = {};
const pendingProductCost = {};
const pendingCb      = new Set();

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
    if (!r.ok) console.error(`[api] ${method} ${pathname}: ${r.status} ${text.slice(0, 500)}`);
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
    ['📦 Замовлення', '🚚 Відстеження'],
    ['💬 Відгуки',    '🎧 Підтримка'],
    ['💼 CRM',        '📊 Статистика'],
    ['📈 Аналітика'],
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
    new: '🆕',
    no_answer: '📞',
    confirmed: '✅',
    cancelled: '❌',
    shipped: '📦',
    paid: '💸',
    returned: '↩️',
    completed: '🏁',
  }[s] || '❔';
}

function paymentLabel(o) {
  return o?.paymentStatus || (o?.status === 'paid' || o?.status === 'completed' ? 'paid' : o?.status === 'returned' ? 'returned' : 'unpaid');
}

const DELIVERY_STATUS_LABELS = {
  ready_for_np: 'очікує ТТН',
  ready_for_dispatch: 'в обробці',
  ttn_added: 'ТТН внесено, очікує відправки',
  ttn_created: 'ТТН створено, очікує відправки',
  in_transit: 'відправлено',
  delivered: 'отримано',
  returned: 'повернення',
  unknown: 'невідомо по НП',
};

function deliveryStatusValue(o) {
  const value = o?.deliveryStatus || '';
  if (value === 'shipped' && o?.ttnCreatedAt && !o?.npStatus && !['paid', 'completed', 'returned'].includes(o?.status || 'new')) {
    return 'ttn_created';
  }
  return value || (o?.ttn ? 'ttn_added' : '');
}

function deliveryLabel(o) {
  const value = deliveryStatusValue(o);
  return DELIVERY_STATUS_LABELS[value] || value || '—';
}

function hasDeliveryInfo(o) {
  return !!(o?.fullName || o?.city || o?.district || o?.postOffice);
}

function hasNovaPoshtaData(o) {
  return !!(o?.fullName && o?.city && o?.postOffice);
}

const MANAGER_DELIVERY_STEPS = [
  { key: 'fullName', label: "ПІБ отримувача (ім'я та прізвище)", orderKey: 'fullName' },
  { key: 'city', label: 'місто або село', orderKey: 'city' },
  { key: 'postOffice', label: 'відділення або поштомат Нової Пошти', orderKey: 'postOffice' },
  { key: 'size', label: 'розмір', orderKey: 'size' },
];

function deliveryStepPrompt(step, order) {
  const current = order?.[step.orderKey] ? ` Поточне: ${order[step.orderKey]}.` : '';
  return `✍️ Введіть ${step.label}.${current}\nМожна написати "-" щоб залишити поточне значення.`;
}

function missingRecipientDeliveryFields(order) {
  const missing = [];
  if (!String(order?.fullName || order?.name || '').trim()) missing.push('ПІБ');
  if (!String(order?.city || '').trim()) missing.push('місто/село');
  if (!String(order?.postOffice || '').trim()) missing.push('відділення/поштомат НП');
  if (!String(order?.size || '').trim()) missing.push('розмір');
  return missing;
}

function canRecreateNovaTtn(o) {
  return !!o?.ttn && ['confirmed', 'shipped'].includes(o.status || 'new');
}

function deliveryBlock(o) {
  if (!hasDeliveryInfo(o)) return '';
  return (
    '\n<b>Дані доставки:</b>\n' +
    (o.fullName ? `🧾 ПІБ: <b>${esc(o.fullName)}</b>\n` : '') +
    (o.city ? `🏙 Місто: <b>${esc(o.city)}</b>\n` : '') +
    (o.district ? `📍 Район: <b>${esc(o.district)}</b>\n` : '') +
    (o.postOffice ? `📦 Відділення НП: <b>${esc(o.postOffice)}</b>\n` : '')
  );
}

function novaPoshtaBlock(o) {
  if (!o?.ttn && !o?.npStatus && !o?.npEstimatedDeliveryDate && !o?.npReturnOrderNumber && !o?.npReturnExpressWaybillNumber) return '';
  return (
    '\n<b>Нова Пошта:</b>\n' +
    (o.ttn ? `ТТН: <code>${esc(o.ttn)}</code>\n` : '') +
    (o.npStatus ? `Статус НП: <b>${esc(o.npStatus)}</b>\n` : '') +
    (o.npStatusCode ? `Код НП: <b>${esc(o.npStatusCode)}</b>\n` : '') +
    (o.npEstimatedDeliveryDate ? `Орієнтовна доставка: <b>${esc(o.npEstimatedDeliveryDate)}</b>\n` : '') +
    (o.npReturnOrderNumber ? `Заявка повернення: <code>${esc(o.npReturnOrderNumber)}</code>\n` : '') +
    (o.npReturnExpressWaybillNumber ? `ТТН повернення: <code>${esc(o.npReturnExpressWaybillNumber)}</code>\n` : '') +
    (o.npReturnStatus ? `Статус повернення: <b>${esc(o.npReturnStatus)}</b>\n` : '') +
    (o.npSyncedAt ? `Оновлено: <b>${fmtDate(o.npSyncedAt)}</b>\n` : '')
  );
}

function esc(val) {
  return String(val ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }); }
  catch { return iso || '—'; }
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
function ratePct(value) {
  return Math.round(Number(value || 0) * 100) + '%';
}
function money(value) {
  const amount = Number(value || 0);
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  return `${amount.toLocaleString('uk-UA', { minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: 2 })} грн`;
}
function waitTime(value) {
  const ms = Number(value || 0);
  if (!ms || ms < 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} хв`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} год`;
  return `${Math.round(hours / 24)} дн`;
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

/* ═══════════════════════════════════════════════════════════
   ORDERS
═══════════════════════════════════════════════════════════ */
const ORDER_LIST_MODELS = {
  all: 'Усі моделі',
  violet: 'Violet Motion',
  black: 'Black Breeze',
};
const ORDER_LIST_STATUSES = {
  active: 'Замовлення',
  confirmed: 'Підтверджені',
  pending: 'Не підтверджені',
  cancelled: 'Відхилені',
  paid: 'Оплачені',
  returned: 'Повернення',
  all: 'Усі',
};

function normalizeOrderModel(value) {
  return Object.prototype.hasOwnProperty.call(ORDER_LIST_MODELS, value) ? value : 'all';
}

function normalizeOrderStatus(value, fallback = 'active') {
  return Object.prototype.hasOwnProperty.call(ORDER_LIST_STATUSES, value) ? value : fallback;
}

function orderListState(state = {}, fallbackStatus = 'active') {
  return {
    model: normalizeOrderModel(state.model),
    status: normalizeOrderStatus(state.status, fallbackStatus),
  };
}

function orderModelKey(o) {
  const product = String(o?.product || '').toLowerCase();
  if (product.includes('black') || product.includes('breeze') || product.includes('sandal')) return 'black';
  return 'violet';
}

function orderStatusMatches(o, status) {
  const raw = o?.status || 'new';
  const payment = paymentLabel(o);
  if (status === 'all') return true;
  if (status === 'active') return !['cancelled', 'paid', 'completed', 'returned'].includes(raw) && !['paid', 'returned'].includes(payment);
  if (status === 'confirmed') return raw === 'confirmed';
  if (status === 'pending') return ['new', 'no_answer'].includes(raw);
  if (status === 'cancelled') return raw === 'cancelled';
  if (status === 'paid') return payment === 'paid' || ['paid', 'completed'].includes(raw);
  if (status === 'returned') return payment === 'returned' || raw === 'returned';
  return true;
}

function orderNeedsDeliveryData(o) {
  return !o?.ttn && !(o?.fullName && o?.city && o?.postOffice && o?.size);
}

function confirmedOrderUrgency(o) {
  const baseTime = new Date(o?.managerConfirmedAt || o?.zvonokConfirmedAt || o?.updatedAt || o?.createdAt || 0).getTime() || 0;
  const rank = orderNeedsDeliveryData(o) ? 3 : !o?.ttn ? 2 : deliveryStatusValue(o) === 'ttn_created' ? 1 : 0;
  return { rank, baseTime };
}

function sortOrdersForList(orders, status) {
  return [...orders].sort((first, second) => {
    if (status === 'confirmed') {
      const a = confirmedOrderUrgency(first);
      const b = confirmedOrderUrgency(second);
      if (b.rank !== a.rank) return b.rank - a.rank;
      if (a.baseTime !== b.baseTime) return a.baseTime - b.baseTime;
    }
    return new Date(second.createdAt || 0) - new Date(first.createdAt || 0);
  });
}

function orderFilterCallback(page, state) {
  return `of_${page}_${state.model}_${state.status}`;
}

function orderFilterButton(text, active, callbackData) {
  return { text: `${active ? '• ' : ''}${text}`, callback_data: callbackData };
}

function ordersKeyboard(items, page, total, filter, state = orderListState()) {
  const rows = [
    [
      orderFilterButton('Усі моделі', state.model === 'all', orderFilterCallback(1, { ...state, model: 'all' })),
      orderFilterButton('Violet Motion', state.model === 'violet', orderFilterCallback(1, { ...state, model: 'violet' })),
      orderFilterButton('Black Breeze', state.model === 'black', orderFilterCallback(1, { ...state, model: 'black' })),
    ],
    [
      orderFilterButton('Замовлення', state.status === 'active', orderFilterCallback(1, { ...state, status: 'active' })),
      orderFilterButton('Підтверджені', state.status === 'confirmed', orderFilterCallback(1, { ...state, status: 'confirmed' })),
    ],
    [
      orderFilterButton('Не підтверджені', state.status === 'pending', orderFilterCallback(1, { ...state, status: 'pending' })),
      orderFilterButton('Відхилені', state.status === 'cancelled', orderFilterCallback(1, { ...state, status: 'cancelled' })),
    ],
    [
      orderFilterButton('Оплачені', state.status === 'paid', orderFilterCallback(1, { ...state, status: 'paid' })),
      orderFilterButton('Повернення', state.status === 'returned', orderFilterCallback(1, { ...state, status: 'returned' })),
    ],
    ...items.map(o => [{ text: `${statusEmoji(o.status)} #${o.id} ${o.name || '—'}${o.product ? ' · ' + o.product : ''} (р.${o.size || '—'})`, callback_data: `od_${o.id}` }]),
  ];
  const nav = [];
  if (page > 1)     nav.push({ text: '← Назад', callback_data: filter ? `op_${page - 1}_f_${filter}` : orderFilterCallback(page - 1, state) });
  nav.push({ text: `${page}/${total}`, callback_data: 'noop' });
  if (page < total) nav.push({ text: 'Далі →', callback_data: filter ? `op_${page + 1}_f_${filter}` : orderFilterCallback(page + 1, state) });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

async function showOrders(chatId, page = 1, filter = null, msgId = null, state = {}) {
  let orders = await serverGet('/api/admin/orders');
  if (!Array.isArray(orders)) return reply(chatId, '❌ Не вдалося завантажити замовлення.', MAIN_KB, msgId);
  const q = filter ? String(filter).trim().toLowerCase() : '';
  const listState = orderListState(state, q ? 'all' : 'active');
  if (q) {
    orders = orders.filter(o => [
      o.name, o.fullName, o.phone, o.size, o.id, o.ttn, o.status, o.paymentStatus,
      o.product, o.color, o.city, o.postOffice, o.npStatus,
    ].some(v => String(v || '').toLowerCase().includes(q)));
  }
  if (listState.model !== 'all') orders = orders.filter(o => orderModelKey(o) === listState.model);
  orders = sortOrdersForList(orders.filter(o => orderStatusMatches(o, listState.status)), listState.status);
  if (!orders.length) {
    const emptyText = q
      ? `🔍 Нічого по "<b>${esc(q)}</b>"`
      : `📦 У фільтрі <b>${esc(ORDER_LIST_STATUSES[listState.status])}</b> · <b>${esc(ORDER_LIST_MODELS[listState.model])}</b> замовлень немає.`;
    return reply(chatId, emptyText, ordersKeyboard([], 1, 1, q, listState), msgId);
  }

  const { items, page: p, total } = paginate(orders, page);
  let text = q
    ? `🔍 Пошук "<b>${esc(q)}</b>" — знайдено ${orders.length}:\n\n`
    : `📦 <b>${esc(ORDER_LIST_STATUSES[listState.status])}</b> · ${esc(ORDER_LIST_MODELS[listState.model])} (${orders.length}):\n\n`;

  items.forEach(o => {
    text += `${statusEmoji(o.status)} <b>#${esc(o.id)}</b> ${esc(o.name || '—')}\n`;
    if (o.product) text += `   🛍 ${esc(o.product)}\n`;
    text += `   📱 ${esc(o.phone || '—')}  👟 р.${esc(o.size || '—')}`;
    if (o.color) text += `  🎨 ${esc(o.color)}`;
    if (o.contactViaTelegram) text += '  💬 TG';
    text += `\n   🏷 ${esc(o.status || 'new')} · 💳 ${esc(paymentLabel(o))}`;
    if (o.ttn) text += ` · ТТН ${esc(o.ttn)}`;
    if (deliveryStatusValue(o) || o.npStatus) text += `\n   🚚 ${esc(o.npStatus || deliveryLabel(o))}`;
    if (hasDeliveryInfo(o)) {
      const cityLine = [o.city, o.postOffice ? `НП ${o.postOffice}` : ''].filter(Boolean).join(' · ');
      if (cityLine) text += `\n   📦 ${esc(cityLine)}`;
    }
    text += `\n   ${fmtDate(o.createdAt)}\n\n`;
  });
  reply(chatId, text, ordersKeyboard(items, p, total, q, listState), msgId);
}

function orderDetailKeyboard(o) {
  const id = o.id;
  const rows = [];
  if (['new', 'no_answer'].includes(o.status || 'new')) {
    rows.push([{ text: '✅ Підтвердити', callback_data: `os_${id}_c` }, { text: '❌ Скасувати', callback_data: `os_${id}_x` }]);
  }
  if (['confirmed', 'shipped'].includes(o.status || 'new')) {
    rows.push([{ text: hasNovaPoshtaData(o) ? '✏️ Дані НП' : '📦 Заповнити дані НП', callback_data: `fill_${id}` }]);
    if (!o.ttn) {
      rows.push([{ text: '🚚 Створити ТТН НП', callback_data: `npcreate_${id}` }]);
    }
    rows.push([{ text: '🧾 Внести ТТН вручну', callback_data: `oi_${id}_tt` }]);
  }
  if (canRecreateNovaTtn(o)) {
    rows.push([{ text: '🔁 Створити ТТН заново', callback_data: `npcreate_force_${id}` }]);
  }
  if (o.ttn) {
    rows.push([
      { text: '🔍 Статус НП', callback_data: `nt_${id}` },
      { text: '🔄 Оновити НП', callback_data: `npsync_${id}` },
    ]);
  }
  if (o.npReturnExpressWaybillNumber || o.npReturnOrderNumber) {
    rows.push([{ text: '↩️ Статус повернення', callback_data: `nprt_${id}` }]);
  } else if (canCreateNpReturn(o)) {
    rows.push([{ text: '↩️ Оформити повернення', callback_data: `nprcreate_${id}` }]);
  }
  rows.push([{ text: '🗑 Видалити', callback_data: `del_order_${id}` }]);
  rows.push([{ text: '← До списку', callback_data: 'orders' }]);
  return { inline_keyboard: rows };
}

async function showOrderDetail(chatId, id, msgId = null) {
  const o = await serverGet(`/api/admin/orders/${id}`);
  if (!o || o.error) return bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB });
  const text =
    `📋 <b>Замовлення #${esc(o.id)}</b>\n━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <b>${esc(o.id)}</b>\n` +
    `👤 Ім'я: <b>${esc(o.name || '—')}</b>\n` +
    `📱 Телефон: <b>${esc(o.phone || '—')}</b>\n` +
    `🛍 Товар: <b>${esc(o.product || '—')}</b>\n` +
    `👟 Розмір: <b>${esc(o.size || '—')}</b>\n` +
    `🎨 Колір: <b>${esc(o.color || '—')}</b>\n` +
    `💵 Ціна: <b>${esc(o.price || '—')} грн</b>\n` +
    (o.contactViaTelegram ? `💬 Зв'язок: Telegram\n` : `📞 Зв'язок: Дзвінок\n`) +
    `🏷 Статус замовлення: ${statusEmoji(o.status)} <b>${esc(o.status || 'new')}</b>\n` +
    `💳 Статус оплати: <b>${esc(paymentLabel(o))}</b>\n` +
    `🚚 ТТН: <code>${esc(o.ttn || '—')}</code>\n` +
    `📦 Статус доставки: <b>${esc(deliveryLabel(o))}</b>\n` +
    `📅 Дата: <b>${fmtDate(o.createdAt)}</b>\n` +
    deliveryBlock(o) +
    novaPoshtaBlock(o) +
    `━━━━━━━━━━━━━━━`;
  reply(chatId, text, orderDetailKeyboard(o), msgId);
}

async function showNpTrack(chatId, id, msgId = null) {
  const order = await serverGet(`/api/admin/orders/${id}`);
  if (!order || order.error) return bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB });
  if (!order.ttn) return bot.sendMessage(chatId, '❌ У замовленні немає ТТН.', { reply_markup: MAIN_KB });
  const track = await serverGet(`/api/admin/np/track/${encodeURIComponent(order.ttn)}`);
  if (!track || track.error) return bot.sendMessage(chatId, '❌ Не вдалося отримати статус Нової Пошти.', { reply_markup: MAIN_KB });
  const text =
    `🔍 <b>ТТН ${esc(order.ttn)}</b>\n━━━━━━━━━━━━━━━\n` +
    `Статус: <b>${esc(track.status || '—')}</b>\n` +
    `Код: <b>${esc(track.statusCode || '—')}</b>\n` +
    `Місто: <b>${esc(track.city || '—')}</b>\n` +
    `Відділення: <b>${esc(track.warehouse || '—')}</b>\n` +
    `Дата відправки: <b>${esc(track.sentAt || '—')}</b>\n` +
    `Дата отримання: <b>${esc(track.receivedAt || '—')}</b>\n` +
    `Отримано: <b>${track.received ? 'так' : 'ні'}</b>\n` +
    `Повернення: <b>${track.returned ? 'так' : 'ні'}</b>`;
  reply(chatId, text, { inline_keyboard: [[{ text: '← До замовлення', callback_data: `od_${id}` }]] }, msgId);
}

async function showNpReturnTrack(chatId, id, msgId = null) {
  const order = await serverGet(`/api/admin/orders/${id}`);
  if (!order || order.error) return reply(chatId, '❌ Замовлення не знайдено.', MAIN_KB, msgId);
  const returnTtn = returnTtnValue(order);
  if (!returnTtn) {
    const requestNumber = returnOrderRequestValue(order);
    const oldTrack = order.ttn ? await serverGet(`/api/admin/np/track/${encodeURIComponent(order.ttn)}`) : null;
    const mergedOrder = {
      ...order,
      ...(oldTrack && !oldTrack.error ? {
        npCanCreateReturn: oldTrack.possibilityCreateReturn,
        npStatus: oldTrack.status || order.npStatus,
        npReturnOldTtnActive: trackLooksLikeReturnRoute(oldTrack, order) || order.npReturnOldTtnActive,
      } : {}),
    };
    const canCreate = canCreateNpReturn(mergedOrder);
    const oldLocation = trackCurrentLocation(oldTrack, order) || returnLocationLabel(order);
    return reply(chatId,
      `↩️ <b>Повернення замовлення #${esc(id)}</b>\n━━━━━━━━━━━━━━━\n` +
      `Клієнт: <b>${esc(order.name || order.fullName || '—')}</b>\n` +
      (order.product ? `Товар: <b>${esc(order.product)}</b>${order.size ? ` · р.${esc(order.size)}` : ''}\n` : '') +
      `Стара ТТН: <code>${esc(order.ttn || '—')}</code>\n` +
      `Повернення: ${requestNumber ? `заявка <code>${esc(requestNumber)}</code>, ТТН ще не видана` : canCreate ? '<b>можна оформити</b>' : '<b>вже йде по старій ТТН / НП не дала окрему ТТН</b>'}\n\n` +
      `Статус старої ТТН: <b>${esc(oldTrack?.status || order.npStatus || deliveryLabel(order))}</b>\n` +
      `Де зараз: <b>${esc(oldLocation || 'оновіть НП')}</b>`,
      {
      inline_keyboard: [
        ...(canCreate ? [[{ text: '↩️ Оформити повернення', callback_data: `nprcreate_${id}` }]] : []),
        [{ text: '🔄 Оновити НП', callback_data: `npsync_${id}` }],
        [{ text: '← До повернень', callback_data: 'trk_returns' }],
        [{ text: '← До замовлення', callback_data: `od_${id}` }],
      ],
    }, msgId);
  }
  const hasReturnWaybill = !!order.npReturnExpressWaybillNumber;
  const track = hasReturnWaybill
    ? await serverGet(`/api/admin/np/track/${encodeURIComponent(order.npReturnExpressWaybillNumber)}`)
    : null;
  if (hasReturnWaybill && (!track || track.error)) {
    return reply(chatId, '❌ Не вдалося отримати статус повернення Нової Пошти.', { inline_keyboard: [[{ text: '← До замовлення', callback_data: `od_${id}` }]] }, msgId);
  }
  const returnStatus = track || {};
  const text =
    `↩️ <b>Повернення замовлення #${esc(id)}</b>\n━━━━━━━━━━━━━━━\n` +
    `Клієнт: <b>${esc(order.name || order.fullName || '—')}</b>\n` +
    (order.product ? `Товар: <b>${esc(order.product)}</b>${order.size ? ` · р.${esc(order.size)}` : ''}\n` : '') +
    `Стара ТТН: <code>${esc(order.ttn || '—')}</code>\n` +
    (order.npReturnExpressWaybillNumber
      ? `ТТН повернення: <code>${esc(order.npReturnExpressWaybillNumber)}</code>\n`
      : `Заявка повернення: <code>${esc(order.npReturnOrderNumber || '—')}</code>\n`) +
    (order.npReturnOrderNumber && order.npReturnExpressWaybillNumber ? `Заявка повернення: <code>${esc(order.npReturnOrderNumber)}</code>\n` : '') +
    `\nДе: <b>${esc(returnStatus.warehouse || order.npReturnWarehouse || returnStatus.city || order.npReturnCity || '—')}</b>\n` +
    `Статус: <b>${esc(returnStatus.status || order.npReturnStatus || '—')}</b>\n` +
    `Код: <b>${esc(returnStatus.statusCode || order.npReturnStatusCode || '—')}</b>\n` +
    `Створено/відправлено: <b>${esc(returnStatus.sentAt || order.npReturnSentAt || order.npReturnCreatedAt || '—')}</b>\n` +
    `Лежить: <b>${esc(returnWaitLabel({ ...order, npReturnSentAt: returnStatus.sentAt || order.npReturnSentAt }))}</b>\n` +
    `Отримано: <b>${esc(returnStatus.receivedAt || order.npReturnReceivedAt || order.npReturnPickedUpAt || '—')}</b>`;
  return reply(chatId, text, { inline_keyboard: [
    [{ text: '✅ Забрав', callback_data: `nprdone_${id}` }, { text: '🔄 Оновити НП', callback_data: `npsync_${id}` }],
    [{ text: '← До повернень', callback_data: 'trk_returns' }],
    [{ text: '← До замовлення', callback_data: `od_${id}` }],
  ] }, msgId);
}

async function createNpReturn(chatId, id, msgId = null) {
  const result = await serverPost(`/api/admin/orders/${id}/np/return`, {});
  if (!result || result.error) {
    const reason = esc(result?.userMessage || result?.error || 'Не вдалося оформити повернення.');
    return reply(chatId, `❌ ${reason}`, { inline_keyboard: [[{ text: '← До повернень', callback_data: 'trk_returns' }], [{ text: '← До замовлення', callback_data: `od_${id}` }]] }, msgId);
  }
  const order = result.order || {};
  const returnTtn = order.npReturnExpressWaybillNumber || order.npReturnOrderNumber || result.returnOrder?.expressWaybillNumber || result.returnOrder?.number || '—';
  await bot.sendMessage(chatId,
    `✅ Повернення оформлено для #${esc(id)}\n` +
    `Стара ТТН: <code>${esc(order.ttn || '—')}</code>\n` +
    `ТТН/заявка повернення: <code>${esc(returnTtn)}</code>`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB });
  return showNpReturnTrack(chatId, id, msgId);
}

async function markNpReturnPickedUp(chatId, id, msgId = null) {
  const updated = await serverPatch(`/api/admin/orders/${id}`, {
    npReturnPickedUpAt: new Date().toISOString(),
    npReturnPickedUpByManager: true,
  });
  if (!updated || updated.error) {
    return reply(chatId, '❌ Не вдалося позначити повернення як забране.', trackingMenuKeyboard(), msgId);
  }
  return showReturnTrackingList(chatId, 'all', 1, msgId);
}

async function syncNpOrder(chatId, id, msgId = null) {
  const result = await serverPost(`/api/admin/orders/${id}/np/sync`, {});
  if (!result || result.error) return bot.sendMessage(chatId, '❌ Не вдалося оновити Нову Пошту.', { reply_markup: MAIN_KB });
  await bot.sendMessage(chatId, `🔄 НП оновлено: <b>${esc(result.track?.status || result.order?.npStatus || 'ok')}</b>`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
  await showOrderDetail(chatId, id, msgId);
}

async function askManagerDeliveryStep(chatId, id, stepIndex = 0, data = {}) {
  const order = await serverGet(`/api/admin/orders/${id}`);
  if (!order || order.error) {
    await bot.sendMessage(chatId, '❌ Замовлення не знайдено.', { reply_markup: MAIN_KB });
    return;
  }
  const step = MANAGER_DELIVERY_STEPS[stepIndex];
  if (!step) return;
  delete pendingTtn[chatId];
  pendingDelivery[chatId] = { id, stepIndex, data };
  await bot.sendMessage(chatId, deliveryStepPrompt(step, { ...order, ...data }), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '← До замовлення', callback_data: `delivery_cancel_${id}` }]] },
  });
}

async function saveManagerDeliveryInput(chatId, text) {
  const pending = pendingDelivery[chatId];
  if (!pending) return false;

  const order = await serverGet(`/api/admin/orders/${pending.id}`);
  if (!order || order.error) {
    delete pendingDelivery[chatId];
    await bot.sendMessage(chatId, '❌ Замовлення не знайдено.', { reply_markup: MAIN_KB });
    return true;
  }

  const step = MANAGER_DELIVERY_STEPS[pending.stepIndex];
  if (!step) {
    delete pendingDelivery[chatId];
    return true;
  }

  const raw = text.trim();
  const current = pending.data?.[step.key] || order[step.orderKey] || '';
  let value = raw === '-' ? current : raw;
  let selectedCityRef = pending.data?.cityRef || order.cityRef || order.delivery?.cityRef || '';
  if (!value) {
    await bot.sendMessage(chatId, `❌ Введіть ${step.label}, без цього ТТН не створиться.`);
    return true;
  }

  if (step.key === 'city' && raw !== '-') {
    const settlement = await serverPost('/api/admin/np/settlements/resolve', { query: value });
    if (!settlement || settlement.error) {
      await bot.sendMessage(chatId, `❌ ${esc(settlement?.userMessage || 'Нова Пошта не знайшла цей населений пункт.')}\n\nВведіть місто або село ще раз.`, { parse_mode: 'HTML' });
      return true;
    }
    if (!settlement.resolved && Array.isArray(settlement.choices) && settlement.choices.length) {
      pendingDelivery[chatId] = { ...pending, settlementChoices: settlement.choices };
      const rows = settlement.choices.map((choice, index) => [{
        text: `${choice.type || ''} ${choice.name}, ${choice.area} обл.${choice.region ? `, ${choice.region} р-н` : ''}`.trim().slice(0, 60),
        callback_data: `npcity_${pending.id}_${index}`,
      }]);
      rows.push([{ text: '← До замовлення', callback_data: `delivery_cancel_${pending.id}` }]);
      await bot.sendMessage(chatId, `📍 Знайдено декілька населених пунктів <b>${esc(value)}</b>.\nОберіть потрібну область/район:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows },
      });
      return true;
    }
    if (settlement.selected?.present) {
      value = settlement.selected.present;
      selectedCityRef = settlement.selected.ref || '';
    }
  }

  const data = { ...(pending.data || {}), [step.key]: value };
  if (step.key === 'city' && selectedCityRef) data.cityRef = selectedCityRef;
  const nextIndex = pending.stepIndex + 1;
  if (MANAGER_DELIVERY_STEPS[nextIndex]) {
    await askManagerDeliveryStep(chatId, pending.id, nextIndex, data);
    return true;
  }

  const delivery = {
    ...(order.delivery && typeof order.delivery === 'object' ? order.delivery : {}),
    fullName: data.fullName,
    city: data.city,
    cityRef: data.cityRef || order.cityRef || order.delivery?.cityRef || null,
    postOffice: data.postOffice,
  };
  const updated = await serverPatch(`/api/admin/orders/${pending.id}`, {
    fullName: data.fullName,
    city: data.city,
    cityRef: data.cityRef || order.cityRef || order.delivery?.cityRef || null,
    postOffice: data.postOffice,
    size: data.size,
    status: 'confirmed',
    deliveryStatus: order.deliveryStatus || 'ready_for_np',
    delivery,
    deliveryCollectedByManager: true,
    deliveryCollectedAt: new Date().toISOString(),
  });
  delete pendingDelivery[chatId];
  if (!updated || updated.error) {
    await bot.sendMessage(chatId, '❌ Не вдалося зберегти дані доставки.', { reply_markup: MAIN_KB });
    return true;
  }

  await bot.sendMessage(chatId, '✅ Дані доставки збережено. Можна створювати ТТН.', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚚 Створити ТТН НП', callback_data: `npcreate_${pending.id}` }],
        [{ text: '📋 Відкрити замовлення', callback_data: `od_${pending.id}` }],
      ],
    },
  });
  await showOrderDetail(chatId, pending.id);
  return true;
}

async function confirmOrderByManager(chatId, id, msgId = null, managerId = null) {
  const patch = {
    status: 'confirmed',
    confirmationSource: 'manager',
    managerConfirmedAt: new Date().toISOString(),
  };
  if (managerId) patch.managerConfirmedBy = managerId;
  const updated = await serverPatch(`/api/admin/orders/${id}`, patch);
  if (!updated || updated.error) {
    await bot.sendMessage(chatId, '❌ Не вдалося підтвердити замовлення.', { reply_markup: MAIN_KB });
    return;
  }
  await bot.sendMessage(chatId, `✅ Замовлення #${id} підтверджено менеджером. Тепер заповнимо дані для Нової Пошти.`);
  await askManagerDeliveryStep(chatId, id, 0);
  return updated;
}

function npSenderLocationKeyboard(id, force = false) {
  const forceFlag = force ? 1 : 0;
  return { inline_keyboard: [
    [
      { text: '🏪 Відділення', callback_data: `nps_mode_b_${id}_${forceFlag}` },
      { text: '📮 Поштомат', callback_data: `nps_mode_p_${id}_${forceFlag}` },
    ],
    [{ text: '← До замовлення', callback_data: `od_${id}` }],
  ] };
}

function senderLocationTypeLabel(type) {
  return type === 'postomat' ? 'поштомат' : 'відділення';
}

function senderLocationPatch(location = {}) {
  return {
    type: location.type,
    category: location.category,
    cityRef: location.cityRef,
    ref: location.ref,
    number: location.number || '',
    description: location.description || '',
    shortAddress: location.shortAddress || '',
  };
}

async function startNpSenderLocation(chatId, id, force = false, msgId = null) {
  const order = await serverGet(`/api/admin/orders/${id}`);
  if (!order || order.error) {
    await bot.sendMessage(chatId, '❌ Замовлення не знайдено.', { reply_markup: MAIN_KB });
    return;
  }

  const missing = missingRecipientDeliveryFields(order).filter(x => x !== 'ПІБ' || !order.name);
  if (missing.length) {
    await bot.sendMessage(chatId, `ℹ️ Для створення ТТН не вистачає: <b>${esc(missing.join(', '))}</b>. Заповнимо зараз.`, { parse_mode: 'HTML' });
    await askManagerDeliveryStep(chatId, id, 0);
    return;
  }

  delete pendingNpSender[chatId];
  await reply(chatId,
    `🚚 <b>Місце відправки для ТТН #${esc(id)}</b>\n\nОберіть, звідки будете відправляти:`,
    npSenderLocationKeyboard(id, force),
    msgId);
}

async function askNpSenderLocation(chatId, id, type, force = false) {
  delete pendingDelivery[chatId];
  pendingNpSender[chatId] = { id, type, force };
  await bot.sendMessage(chatId,
    `✍️ Введіть номер або адресу ${senderLocationTypeLabel(type)} Нової Пошти, звідки будете відправляти замовлення #${id}.\n\nНаприклад: <code>29</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '← До вибору', callback_data: `nps_back_${id}_${force ? 1 : 0}` }]] },
    });
}

async function resolveNpSenderInput(chatId, text) {
  const pending = pendingNpSender[chatId];
  if (!pending) return false;
  const query = text.trim();
  if (!query) {
    await bot.sendMessage(chatId, '❌ Введіть номер або адресу місця відправки текстом.', { reply_markup: MAIN_KB });
    return true;
  }

  const result = await serverPost('/api/admin/np/sender-location/resolve', { type: pending.type, query });
  if (!result || result.error || !result.location?.ref) {
    const reason = esc(result?.userMessage || result?.error || 'Нова Пошта не знайшла це місце відправки.');
    await bot.sendMessage(chatId, `❌ ${reason}\n\nВведіть інший номер або адресу.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '← До вибору', callback_data: `nps_back_${pending.id}_${pending.force ? 1 : 0}` }]] },
    });
    return true;
  }

  pending.location = senderLocationPatch(result.location);
  const address = pending.location.shortAddress || pending.location.description || '—';
  await bot.sendMessage(chatId,
    `📍 <b>Нова Пошта знайшла ${senderLocationTypeLabel(pending.type)}:</b>\n` +
    `<b>${esc(pending.location.description || address)}</b>\n` +
    (pending.location.shortAddress && pending.location.shortAddress !== pending.location.description ? `${esc(pending.location.shortAddress)}\n` : '') +
    `\nПідтвердити це місце відправки і створити ТТН?`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Підтвердити', callback_data: `nps_confirm_${pending.id}` }],
        [{ text: '✏️ Ввести інше', callback_data: `nps_retry_${pending.id}` }],
        [{ text: '← До замовлення', callback_data: `od_${pending.id}` }],
      ] },
    });
  return true;
}

async function createNpTtn(chatId, id, force = false, msgId = null, senderLocation = null) {
  const order = await serverGet(`/api/admin/orders/${id}`);
  if (!order || order.error) {
    await bot.sendMessage(chatId, '❌ Замовлення не знайдено.', { reply_markup: MAIN_KB });
    return;
  }
  const missing = missingRecipientDeliveryFields(order).filter(x => x !== 'ПІБ' || !order.name);
  if (missing.length) {
    await bot.sendMessage(chatId, `ℹ️ Для створення ТТН не вистачає: <b>${esc(missing.join(', '))}</b>. Заповнимо зараз.`, { parse_mode: 'HTML' });
    await askManagerDeliveryStep(chatId, id, 0);
    return;
  }

  const createBody = force ? { force: true } : {};
  if (senderLocation?.ref) createBody.npSenderLocation = senderLocationPatch(senderLocation);
  const result = await serverPost(`/api/admin/orders/${id}/np/create`, createBody);
  if (!result || result.error) {
    const errors = [
      ...(Array.isArray(result?.details?.errors) ? result.details.errors : []),
      ...(Array.isArray(result?.details?.raw?.errors) ? result.details.raw.errors : []),
    ].filter(Boolean).slice(0, 2);
    const extra = errors.length && !String(result?.userMessage || '').includes(errors[0])
      ? `\n<b>НП:</b> ${esc(errors.join('; '))}`
      : '';
    const reason = esc(result?.userMessage || result?.error || 'Не вдалося створити ТТН.');
    await bot.sendMessage(chatId, `❌ ${reason}${extra}`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
    return;
  }

  const ttn = result.ttn || result.order?.ttn || order.ttn || '—';
  await bot.sendMessage(chatId,
    `${force ? '♻️ ТТН пересоздано' : result.duplicate ? 'ℹ️ ТТН вже існує' : '✅ ТТН створено'} для замовлення #${id}: <code>${esc(ttn)}</code>`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB });
  await showOrderDetail(chatId, id, msgId);
}

function isOrderActiveForTracking(o) {
  return !!o?.ttn && !['cancelled', 'returned', 'completed'].includes(o.status || 'new');
}

function returnTtnValue(order = {}) {
  return order.npReturnExpressWaybillNumber || '';
}

function returnOrderRequestValue(order = {}) {
  return order.npReturnOrderNumber || '';
}

function returnStatusText(order = {}) {
  return [
    order.status,
    order.paymentStatus,
    order.deliveryStatus,
    order.npStatus,
    order.npReturnStatus,
    order.npReturnExpressWaybillStatus,
    order.npLastCreatedOnTheBasisDocumentType,
  ].filter(Boolean).join(' ').toLowerCase();
}

function oldTtnHasReturnRoute(order = {}) {
  const text = returnStatusText(order);
  return !!(
    order.npReturnOldTtnActive ||
    order.npReturnCandidateNumber ||
    text.includes('returned') ||
    text.includes('повер') ||
    text.includes('возврат') ||
    text.includes('відмов') ||
    text.includes('отказ') ||
    text.includes('змінено адрес') ||
    text.includes('изменен') ||
    text.includes('return')
  );
}

function canCreateNpReturn(order = {}) {
  return !!(
    order.ttn &&
    order.npCanCreateReturn === true &&
    !returnTtnValue(order) &&
    !returnOrderRequestValue(order) &&
    !oldTtnHasReturnRoute(order)
  );
}

function isReturnPickedUp(order = {}) {
  return !!(order.npReturnPickedUpAt && order.npReturnPickedUpByManager);
}

function hasReturnForPanel(order = {}) {
  return (!!returnTtnValue(order) || !!returnOrderRequestValue(order) || oldTtnHasReturnRoute(order) || canCreateNpReturn(order)) && !isReturnPickedUp(order);
}

function returnWaitBase(order = {}) {
  return order.npReturnReceivedAt || order.npReturnSentAt || order.npReturnCreatedAt || order.returnedAt || order.updatedAt || order.createdAt;
}

function returnWaitLabel(order = {}) {
  const base = new Date(returnWaitBase(order) || 0).getTime();
  if (!base || Number.isNaN(base)) return '—';
  return waitTime(Date.now() - base);
}

function returnLocationLabel(order = {}) {
  const useSenderPoint = oldTtnHasReturnRoute(order) && !returnTtnValue(order);
  const city = order.npReturnCity || (useSenderPoint ? order.npSenderCity : order.npCity);
  const warehouse = order.npReturnWarehouse || (useSenderPoint ? (order.npSenderWarehouse || order.npSenderWarehouseAddress) : (order.npWarehouseAddress || order.npWarehouse));
  const parts = [city, warehouse].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return order.npReturnStatus || order.npReturnExpressWaybillStatus || order.npStatus || 'очікує оновлення НП';
}

function returnStatusLabel(order = {}) {
  return order.npReturnStatus || order.npReturnExpressWaybillStatus || order.npReturnTrackingStatus || order.npStatus || 'очікує оновлення';
}

function returnFlowState(order = {}) {
  const statusText = returnStatusLabel(order).toLowerCase();
  const hasRequest = !!returnOrderRequestValue(order);
  const hasWaybill = !!returnTtnValue(order);
  const canCreate = canCreateNpReturn(order);
  const arrived = !!(
    order.npReturnReceivedAt ||
    order.npReturnTrackingStatus === 'delivered' ||
    (oldTtnHasReturnRoute(order) && ['7', '8'].includes(String(order.npReturnStatusCode || order.npStatusCode || ''))) ||
    statusText.includes('отрим') ||
    statusText.includes('получ') ||
    statusText.includes('прибув') ||
    statusText.includes('прибыл') ||
    statusText.includes('відділен') ||
    statusText.includes('отдел') ||
    statusText.includes('поштомат') ||
    statusText.includes('почтомат')
  );
  if (canCreate && !hasRequest && !hasWaybill) return 'request';
  if (arrived) return 'arrived';
  return 'transit';
}

function returnFlowLabel(order = {}) {
  return {
    request: 'потрібно оформити',
    transit: 'їде назад',
    arrived: 'лежить у нас',
  }[returnFlowState(order)] || 'активне';
}

function returnLocationType(order = {}) {
  const text = returnLocationLabel(order).toLowerCase();
  if (text.includes('поштомат') || text.includes('почтомат') || text.includes('postomat')) return 'postomat';
  if (text.includes('відділ') || text.includes('отдел') || text.includes('branch')) return 'branch';
  return 'unknown';
}

function trackLooksLikeReturnRoute(track = {}, order = {}) {
  const text = [track.status, track.lastCreatedOnTheBasisDocumentType].filter(Boolean).join(' ').toLowerCase();
  return !!(
    track.normalizedStatus === 'returned' ||
    track.cargoReturnRefusal ||
    oldTtnHasReturnRoute(order) ||
    text.includes('повер') ||
    text.includes('возврат') ||
    text.includes('відмов') ||
    text.includes('отказ') ||
    text.includes('змінено адрес') ||
    text.includes('изменен') ||
    text.includes('return')
  );
}

function trackCurrentLocation(track = {}, order = {}) {
  if (!track || track.error) return '';
  if (track.publicTracking && typeof track.publicTracking === 'object') {
    const publicLocation = [
      track.publicTracking.currentCity || track.city,
      track.publicTracking.currentWarehouse || track.warehouseAddress || track.warehouse,
    ].filter(Boolean).join(' · ');
    if (publicLocation) return publicLocation;
  }
  if (trackLooksLikeReturnRoute(track, order)) {
    return [track.senderCity, track.senderWarehouse || track.senderWarehouseAddress].filter(Boolean).join(' · ');
  }
  return [track.city, track.warehouseAddress || track.warehouse].filter(Boolean).join(' · ');
}

function trackingMenuKeyboard() {
  return { inline_keyboard: [
    [{ text: '🚚 Активні ТТН', callback_data: 'trk_active' }, { text: '↩️ Повернення', callback_data: 'trk_returns' }],
    [{ text: '🔄 Оновити всі НП', callback_data: 'np_sync_all' }],
    [{ text: '← Меню', callback_data: 'main' }],
  ] };
}

function trackingListKeyboard(orders) {
  const rows = orders.slice(0, 10).map(o => {
    const row = [{ text: `#${o.id} ${o.name || '—'}`, callback_data: `od_${o.id}` }];
    if (o.ttn) row.push({ text: '🔄 НП', callback_data: `npsync_${o.id}` });
    return row;
  });
  rows.push([{ text: '← Відстеження', callback_data: 'track_menu' }]);
  return { inline_keyboard: rows };
}

async function showTrackingMenu(chatId, msgId = null) {
  const orders = await serverGet('/api/admin/orders');
  if (!Array.isArray(orders)) return reply(chatId, '❌ Не вдалося завантажити відстеження.', MAIN_KB, msgId);

  const activeTtn = orders.filter(isOrderActiveForTracking);
  const noTtn = orders.filter(o => !o.ttn && ['confirmed', 'shipped', 'paid'].includes(o.status || 'new'));
  const newOrders = orders.filter(o => (o.status || 'new') === 'new');
  const returnTtn = orders.filter(o => o.npReturnExpressWaybillNumber || o.npReturnOrderNumber);
  const openReturns = orders.filter(hasReturnForPanel);
  const text =
    `🚚 <b>Відстеження</b>\n━━━━━━━━━━━━━━━\n` +
    `🆕 Нові заявки: <b>${newOrders.length}</b>\n` +
    `🚚 Активні ТТН: <b>${activeTtn.length}</b>\n` +
    `↩️ Повернення до забрати: <b>${openReturns.length}</b>\n` +
    `📦 Усі повернення з ТТН/заявкою: <b>${returnTtn.length}</b>\n` +
    `🧾 Підтверджені без ТТН: <b>${noTtn.length}</b>\n` +
    `━━━━━━━━━━━━━━━`;
  return reply(chatId, text, trackingMenuKeyboard(), msgId);
}

async function showTrackingList(chatId, msgId = null) {
  let orders = await serverGet('/api/admin/orders');
  if (!Array.isArray(orders)) return reply(chatId, '❌ Не вдалося завантажити відстеження.', trackingMenuKeyboard(), msgId);
  orders = orders.filter(isOrderActiveForTracking).reverse();
  if (!orders.length) return reply(chatId, '🚚 <b>Активних ТТН немає</b>', trackingMenuKeyboard(), msgId);

  let text = `🚚 <b>Активні ТТН</b> (${orders.length})\n━━━━━━━━━━━━━━━\n\n`;
  orders.slice(0, 10).forEach(o => {
    text += `${statusEmoji(o.status)} <b>#${esc(o.id)}</b> ${esc(o.name || '—')}\n`;
    if (o.product) text += `   🛍 ${esc(o.product)}\n`;
    text += `   🚚 <code>${esc(o.ttn || '—')}</code>\n`;
    text += `   📦 ${esc(o.npStatus || deliveryLabel(o))}`;
    if (o.npSyncedAt) text += ` · ${fmtDate(o.npSyncedAt)}`;
    text += '\n\n';
  });
  if (orders.length > 10) text += `…і ще ${orders.length - 10} замовлень\n`;
  return reply(chatId, text, trackingListKeyboard(orders), msgId);
}

const RETURN_VIEW_LABELS = {
  all: 'Усі активні',
  arrived: 'Лежать у нас',
  request: 'Оформити',
  transit: 'Їдуть',
};

function returnTrackingKeyboard(items, page, total, view = 'all') {
  const rows = [
    [
      { text: `${view === 'all' ? '• ' : ''}Усі`, callback_data: 'trk_returns_all_1' },
      { text: `${view === 'arrived' ? '• ' : ''}Лежать`, callback_data: 'trk_returns_arrived_1' },
    ],
    [
      { text: `${view === 'request' ? '• ' : ''}Оформити`, callback_data: 'trk_returns_request_1' },
      { text: `${view === 'transit' ? '• ' : ''}Їдуть`, callback_data: 'trk_returns_transit_1' },
    ],
    ...items.map(order => {
      const row = [{
        text: `↩️ #${order.id} ${order.name || '—'} · ${returnFlowLabel(order)}`,
        callback_data: `nprt_${order.id}`,
      }];
      if (returnFlowState(order) === 'request') row.push({ text: 'Оформити', callback_data: `nprcreate_${order.id}` });
      return row;
    }),
  ];
  const nav = [];
  if (page > 1) nav.push({ text: '← Назад', callback_data: `trk_returns_${view}_${page - 1}` });
  nav.push({ text: `${page}/${total}`, callback_data: 'noop' });
  if (page < total) nav.push({ text: 'Далі →', callback_data: `trk_returns_${view}_${page + 1}` });
  rows.push(nav);
  rows.push([{ text: '🔄 Оновити повернення', callback_data: 'np_sync_returns' }]);
  rows.push([{ text: '← Відстеження', callback_data: 'track_menu' }]);
  return { inline_keyboard: rows };
}

async function showReturnTrackingList(chatId, view = 'all', page = 1, msgId = null) {
  let orders = await serverGet('/api/admin/orders');
  if (!Array.isArray(orders)) return reply(chatId, '❌ Не вдалося завантажити повернення.', trackingMenuKeyboard(), msgId);
  const allActive = orders
    .filter(hasReturnForPanel)
    .sort((a, b) => new Date(returnWaitBase(a) || 0) - new Date(returnWaitBase(b) || 0));
  const safeView = Object.prototype.hasOwnProperty.call(RETURN_VIEW_LABELS, view) ? view : 'all';
  orders = safeView === 'all' ? allActive : allActive.filter(order => returnFlowState(order) === safeView);
  if (!orders.length) {
    return reply(chatId,
      `↩️ <b>Повернення Нової Пошти</b>\n━━━━━━━━━━━━━━━\n\n✅ У фільтрі <b>${esc(RETURN_VIEW_LABELS[safeView])}</b> зараз порожньо.`,
      returnTrackingKeyboard([], 1, 1, safeView),
      msgId);
  }
  const { items, page: current, total } = paginate(orders, page);
  const branchCount = allActive.filter(order => returnLocationType(order) === 'branch').length;
  const postomatCount = allActive.filter(order => returnLocationType(order) === 'postomat').length;
  const requestCount = allActive.filter(order => returnFlowState(order) === 'request').length;
  const transitCount = allActive.filter(order => returnFlowState(order) === 'transit').length;
  const arrivedCount = allActive.filter(order => returnFlowState(order) === 'arrived').length;
  let text =
    `↩️ <b>Повернення Нової Пошти</b>\n━━━━━━━━━━━━━━━\n` +
    `Фільтр: <b>${esc(RETURN_VIEW_LABELS[safeView])}</b>\n` +
    `Активні: <b>${allActive.length}</b> · лежать: <b>${arrivedCount}</b> · оформити: <b>${requestCount}</b> · їдуть: <b>${transitCount}</b>\n` +
    `Відділення: <b>${branchCount}</b> · Поштомати: <b>${postomatCount}</b>\n\n`;
  items.forEach(order => {
    const returnTtn = returnTtnValue(order);
    const requestNumber = returnOrderRequestValue(order);
    text += `↩️ <b>#${esc(order.id)}</b> ${esc(order.name || order.fullName || '—')}`;
    if (order.product) text += ` · ${esc(order.product)}`;
    if (order.size) text += ` · р.${esc(order.size)}`;
    text += '\n';
    text += `   Відправка: <code>${esc(order.ttn || '—')}</code>\n`;
    text += `   Повернення: ${returnTtn ? `<code>${esc(returnTtn)}</code>` : requestNumber ? `заявка <code>${esc(requestNumber)}</code>` : '<b>не оформлено</b>'}\n`;
    text += `   Де: <b>${esc(returnLocationLabel(order))}</b>\n`;
    text += `   Етап: <b>${esc(returnFlowLabel(order))}</b>\n`;
    text += `   Статус: ${esc(returnStatusLabel(order))}\n`;
    text += `   Лежить: <b>${esc(returnWaitLabel(order))}</b>\n\n`;
  });
  return reply(chatId, text, returnTrackingKeyboard(items, current, total, safeView), msgId);
}

async function syncAllNpOrders(chatId, msgId = null, nextView = 'menu') {
  const result = await serverPost('/api/admin/np/sync', { limit: 100 });
  if (!result || result.error) {
    await bot.sendMessage(chatId, '❌ Не вдалося оновити Нову Пошту.', { reply_markup: MAIN_KB });
    return;
  }
  await bot.sendMessage(chatId,
    `🔄 НП оновлено. Перевірено: <b>${esc(result.checked || 0)}</b>, змінено: <b>${esc(result.changed || 0)}</b>.`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB });
  if (nextView === 'returns') await showReturnTrackingList(chatId, 'all', 1, msgId);
  else await showTrackingMenu(chatId, msgId);
}

async function showReviews(chatId, page = 1, msgId = null) {
  let reviews = await serverGet('/api/admin/reviews');
  if (!Array.isArray(reviews)) return reply(chatId, '❌ Не вдалося завантажити відгуки.', MAIN_KB, msgId);
  reviews = reviews.reverse();
  if (!reviews.length) return reply(chatId, '💬 Відгуків ще немає.', MAIN_KB, msgId);
  const { items, page: p, total } = paginate(reviews, page);
  let text = `💬 <b>Відгуки</b> (${reviews.length}):\n\n`;
  items.forEach(r => {
    text += `${stars(r.rating)} <b>${r.name}</b>\n`;
    const excerpt = r.text.length > 80 ? r.text.slice(0, 80) + '…' : r.text;
    text += `<i>${excerpt}</i>\n📅 ${r.date || '—'}\n\n`;
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
    text += `💬 <b>#${m.id}</b>${m.accepted ? ' ✋' : ''}\n<i>${excerpt}</i>\n📅 ${fmtDate(m.timestamp)}\n\n`;
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
    (top ? `👟 Топ розмір: <b>${top[0]}</b> (${top[1]} шт)\n` : '') +
    `━━━━━━━━━━━━━━━`;

  reply(chatId, text, MAIN_KB, msgId);
}

/* ═══════════════════════════════════════════════════════════
   CRM DASHBOARDS
═══════════════════════════════════════════════════════════ */
const CRM_PERIOD_LABELS = {
  today: 'Сьогодні',
  week: '7 днів',
  month: 'Цей місяць',
  all: 'Увесь час',
};

function crmPickerKb() {
  return {
    inline_keyboard: [
      [
        { text: '📦 Замовлення', callback_data: 'crm_orders' },
        { text: '💰 Фінанси', callback_data: 'crm_finance' },
      ],
    ],
  };
}

async function showCrmPicker(chatId, msgId = null) {
  const text =
    `💼 <b>CRM Violet Motion</b>\n━━━━━━━━━━━━━━━\n` +
    `Оберіть розділ для відстеження:`;
  reply(chatId, text, crmPickerKb(), msgId);
}

function crmMenuKb(period = 'today') {
  return {
    inline_keyboard: [
      [
        { text: `${period === 'today' ? '• ' : ''}📅 Сьогодні`, callback_data: 'crm_period_today' },
        { text: `${period === 'week' ? '• ' : ''}📆 7 днів`, callback_data: 'crm_period_week' },
      ],
      [
        { text: `${period === 'month' ? '• ' : ''}🗓 Місяць`, callback_data: 'crm_period_month' },
        { text: `${period === 'all' ? '• ' : ''}∞ Увесь час`, callback_data: 'crm_period_all' },
      ],
      [
        { text: '🧾 Операції', callback_data: `crm_tx_${period}_1` },
        { text: '⚠️ Перевірити', callback_data: `crm_review_${period}_1` },
      ],
      [
        { text: '🏷 Собівартість', callback_data: 'crm_products' },
        { text: '🔄 Оновити', callback_data: `crm_sync_${period}` },
      ],
      [{ text: '← CRM', callback_data: 'crm_menu' }],
    ],
  };
}

function crmProductsKb(products = []) {
  return {
    inline_keyboard: [
      ...products.map(product => [{
        text: `✏️ ${product.label}: ${money(product.cost)}`,
        callback_data: `crm_cost_${product.key}`,
      }]),
      [{ text: '← Фінанси', callback_data: 'crm_period_today' }],
    ],
  };
}

async function showCrmReport(chatId, period = 'today', msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${encodeURIComponent(period)}`);
  if (!data || data.error) {
    return reply(chatId, '❌ CRM-звіт зараз недоступний.', crmMenuKb(period), msgId);
  }

  const refundLine = Number(data.refundIncome || 0) > 0
    ? `↩️ Повернення списань: <b>+${money(data.refundIncome)}</b>\n`
    : '';
  const businessIncomeLine = Number(data.manualIncome || 0) > 0
    ? `➕ Інші бізнес-надходження: <b>+${money(data.manualIncome)}</b>\n`
    : '';
  const afterpayments = data.afterpayments || {};
  const reviewLine = Number(data.reviewCount || 0) > 0
    ? `⚠️ Потрібно перевірити: <b>${data.reviewCount}</b> операц.\n`
    : `✅ Неперевірених операцій немає\n`;

  const text =
    `💼 <b>CRM Violet Motion — ${CRM_PERIOD_LABELS[period] || period}</b>\n━━━━━━━━━━━━━━━\n` +
    `Облік з: <b>${esc(data.financeResetLabel || '26.05.2026')}</b>\n\n` +
    `<b>Бізнес</b>\n` +
    `✅ Викуплено: <b>${data.paidOrders || 0}</b> · виручка <b>+${money(data.revenue)}</b>\n` +
    `🏷 Собівартість: <b>−${money(data.cost)}</b>\n` +
    `📣 Реклама: <b>−${money(data.adsExpense)}</b>\n` +
    `🚚 Нова Пошта: <b>−${money(Number(data.shippingExpense || 0) + Number(data.returnsExpense || 0))}</b>\n` +
    `🧾 Інші бізнес-витрати: <b>−${money(data.otherExpense)}</b>\n` +
    refundLine +
    businessIncomeLine +
    `💰 Прибуток: <b>${money(data.profit)}</b>\n` +
    `   ${money(data.netOrders)} + ${money(data.manualIncome)} + ${money(data.refundIncome)} − ${money(data.expense)} = ${money(data.profit)}\n\n` +
    `<b>Гроші та контроль</b>\n` +
    `💵 Післяплати в актуальних ТТН: <b>${money(afterpayments.cashAmount || afterpayments.amount)}</b>\n` +
    `👤 Особисті витрати: <b>−${money(data.personalExpense)}</b> (не в прибутку)\n` +
    reviewLine +
    `\n<i>Продажі — за статусом викупу НП. Витрати — з monobank. Невідомі списання не входять у бізнес без підтвердження.</i>`;

  reply(chatId, text, crmMenuKb(period), msgId);
}

function financeCategoryLabel(category) {
  return ({
    net_order: 'Оплата замовлення',
    shipping: 'Доставка НП',
    return: 'Повернення НП',
    ads: 'Реклама',
    shipping_refund: 'Повернення списання НП',
    return_refund: 'Повернення витрати повернення НП',
    ads_refund: 'Повернення реклами',
    business_refund: 'Повернення бізнес-витрати',
    manual_business: 'Бізнес-витрата',
    business: 'Інша бізнес-витрата',
    personal: 'Особиста витрата',
    business_income: 'Бізнес-надходження',
    income_review: 'Надходження на перевірку',
    ignored_income: 'Не враховується',
    order: 'Витрата по замовленню',
    manual: 'Ручна операція',
    np_payout_unmatched: 'НП: надходження без замовлення',
  })[category] || category || 'Операція';
}

function crmTransactionsKb(period, page, total, items = []) {
  const rows = [];
  const nav = [];
  if (page > 1) nav.push({ text: '← Назад', callback_data: `crm_tx_${period}_${page - 1}` });
  nav.push({ text: `${page}/${total}`, callback_data: 'noop' });
  if (page < total) nav.push({ text: 'Далі →', callback_data: `crm_tx_${period}_${page + 1}` });
  rows.push(nav);
  rows.push([{ text: '← Фінанси', callback_data: `crm_period_${period}` }]);
  return { inline_keyboard: rows };
}

async function showCrmTransactions(chatId, period = 'today', page = 1, msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${encodeURIComponent(period)}`);
  if (!data || data.error) return reply(chatId, '❌ Рух коштів зараз недоступний.', crmMenuKb(period), msgId);
  const records = Array.isArray(data.transactions) ? data.transactions : [];
  const pageSize = 7;
  const total = Math.ceil(records.length / pageSize) || 1;
  const current = Math.max(1, Math.min(Number(page) || 1, total));
  const items = records.slice((current - 1) * pageSize, current * pageSize);
  let text = `🧾 <b>Рух коштів — ${CRM_PERIOD_LABELS[period] || period}</b>\n━━━━━━━━━━━━━━━\n`;
  if (!items.length) {
    text += '\nОперацій за період немає.';
  } else {
    items.forEach(item => {
      const incoming = item.type === 'income';
      const unmatched = item.type === 'unmatched';
      const amount = incoming ? `+${money(item.amount)}` : `−${money(item.amount)}`;
      const order = item.linkedOrder;
      if (incoming && item.grossAmount) {
        text += `\n✅ <b>${esc(financeCategoryLabel(item.category))}</b>\n`;
        text += `   +${money(item.grossAmount)} − ${money(item.costAmount)} = <b>${money(item.amount)}</b>\n`;
      } else if (unmatched) {
        text += `\n⚠️ <b>+${money(item.amount)}</b> · ${esc(financeCategoryLabel(item.category))}\n`;
      } else {
        text += `\n${incoming ? '✅' : '➖'} <b>${amount}</b> · ${esc(financeCategoryLabel(item.category))}\n`;
      }
      text += `   ${esc(item.title || 'Операція')}\n`;
      if (item.bankDescription) text += `   Monobank: ${esc(item.bankDescription)}\n`;
      if (order?.id) {
        text += `   Замовлення #${esc(order.id)} · ${esc(order.product || '—')}`;
        if (order.size) text += ` · р.${esc(order.size)}`;
        text += '\n';
        if (order.ttn) text += `   ТТН: <code>${esc(order.ttn)}</code>\n`;
        if (item.category === 'return' && order.returnTtn) text += `   ТТН повернення: <code>${esc(order.returnTtn)}</code>\n`;
      }
      text += `   ${fmtDate(item.createdAt)}\n`;
    });
  }
  return reply(chatId, text, crmTransactionsKb(period, current, total, items), msgId);
}

function crmReviewKb(period, page, total, items = []) {
  const rows = items.map(item => [{
    text: `⚠️ ${item.type === 'expense' ? '−' : '+'}${money(item.amount)} ${item.bankDescription || item.title || ''}`.slice(0, 58),
    callback_data: `crm_review_item_${item.id}_${period}_${page}`,
  }]);
  const nav = [];
  if (page > 1) nav.push({ text: '← Назад', callback_data: `crm_review_${period}_${page - 1}` });
  nav.push({ text: `${page}/${total}`, callback_data: 'noop' });
  if (page < total) nav.push({ text: 'Далі →', callback_data: `crm_review_${period}_${page + 1}` });
  rows.push(nav);
  rows.push([{ text: '← Фінанси', callback_data: `crm_period_${period}` }]);
  return { inline_keyboard: rows };
}

async function showCrmReview(chatId, period = 'today', page = 1, msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${encodeURIComponent(period)}`);
  if (!data || data.error) return reply(chatId, '❌ Перевірка операцій зараз недоступна.', crmMenuKb(period), msgId);
  const records = Array.isArray(data.reviewTransactions) ? data.reviewTransactions : [];
  const pageSize = 6;
  const total = Math.ceil(records.length / pageSize) || 1;
  const current = Math.max(1, Math.min(Number(page) || 1, total));
  const items = records.slice((current - 1) * pageSize, current * pageSize);
  let text = `⚠️ <b>Потрібно перевірити — ${CRM_PERIOD_LABELS[period] || period}</b>\n━━━━━━━━━━━━━━━\n`;
  if (!items.length) {
    text += '\n✅ Неперевірених операцій немає.';
  } else {
    text += '\nЦі операції вже враховані за автоматичною категорією. Підтвердьте її або змініть, якщо бот помилився. Повторно сума не додасться.\n';
    items.forEach(item => {
      const sign = item.type === 'expense' ? '−' : '+';
      text += `\n${sign}<b>${money(item.amount)}</b> · ${esc(item.bankDescription || item.title || 'Операція')}\n   ${fmtDate(item.createdAt)}\n`;
    });
  }
  return reply(chatId, text, crmReviewKb(period, current, total, items), msgId);
}

async function showCrmReviewItem(chatId, id, period = 'today', page = 1, msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${encodeURIComponent(period)}`);
  const item = Array.isArray(data?.reviewTransactions) ? data.reviewTransactions.find(entry => Number(entry.id) === Number(id)) : null;
  if (!item) return showCrmReview(chatId, period, page, msgId);
  const incoming = item.type === 'unmatched' || item.type === 'income';
  const rows = incoming
    ? [[{ text: '✅ Бізнес-надходження', callback_data: `crm_class_${id}_business_income_${period}_${page}` }],
       [{ text: '🚫 Не враховувати', callback_data: `crm_class_${id}_ignored_income_${period}_${page}` }]]
    : [[{ text: '👤 Особисте', callback_data: `crm_class_${id}_personal_${period}_${page}` },
        { text: '📣 Реклама', callback_data: `crm_class_${id}_ads_${period}_${page}` }],
       [{ text: '🚚 Доставка НП', callback_data: `crm_class_${id}_shipping_${period}_${page}` },
        { text: '↩️ Повернення', callback_data: `crm_class_${id}_return_${period}_${page}` }],
       [{ text: '🧾 Інший бізнес', callback_data: `crm_class_${id}_business_${period}_${page}` }]];
  rows.push([{ text: '← До перевірки', callback_data: `crm_review_${period}_${page}` }]);
  const sign = incoming ? '+' : '−';
  const text =
    `⚠️ <b>Класифікувати операцію</b>\n━━━━━━━━━━━━━━━\n` +
    `${sign}<b>${money(item.amount)}</b>\n` +
    `${esc(item.bankDescription || item.title || 'Операція')}\n` +
    `${fmtDate(item.createdAt)}\n\n` +
    `Оберіть, що це за операція:`;
  return reply(chatId, text, { inline_keyboard: rows }, msgId);
}

async function showNpAfterpayments(chatId, period = 'today', msgId = null) {
  const data = await serverGet(`/api/admin/np/afterpayments?period=${encodeURIComponent(period)}`);
  if (!data || data.error) return reply(chatId, '❌ Післяплати Нової Пошти зараз недоступні.', crmMenuKb(period), msgId);
  const items = Array.isArray(data.items) ? data.items.slice(0, 15) : [];
  let text =
    `💵 <b>Післяплати НП — ${CRM_PERIOD_LABELS[period] || period}</b>\n━━━━━━━━━━━━━━━\n` +
    `До отримання/звірки готівкою: <b>${money(data.cashAmount || data.amount)}</b>\n` +
    `Записів: <b>${data.records || 0}</b>  Зіставлено із замовленнями: <b>${data.matchedOrders || 0}</b>\n\n`;
  if (!items.length) {
    text += 'Післяплат ще не знайдено. Натисніть «Оновити НП» після завантаження актуальних замовлень.';
  } else {
    text += items.map(item => {
      const order = item.linkedOrder;
      const orderText = order?.id ? ` · замовлення #${order.id} ${esc(order.product || '')}` : ' · без зіставлення';
      return `• <code>${esc(item.ttn)}</code>: <b>${money(item.amount)}</b>${orderText}`;
    }).join('\n');
  }
  return reply(chatId, text, { inline_keyboard: [
    [{ text: '🔄 Оновити НП', callback_data: `crm_np_cash_sync_${period}` }],
    [{ text: '← Фінанси', callback_data: `crm_period_${period}` }],
  ] }, msgId);
}

async function showCrmProducts(chatId, msgId = null) {
  const data = await serverGet('/api/admin/crm/products');
  const products = Array.isArray(data?.products) ? data.products : [];
  if (!products.length) return reply(chatId, '❌ Не вдалося завантажити моделі CRM.', crmMenuKb(), msgId);

  const text =
    `🏷 <b>Собівартість моделей</b>\n━━━━━━━━━━━━━━━\n` +
    products.map(product => `${esc(product.label)}: <b>${money(product.cost)}</b>`).join('\n') +
    `\n\nНатисніть модель і надішліть нову собівартість числом.`;
  reply(chatId, text, crmProductsKb(products), msgId);
}

const ORDER_CRM_QUEUE_LABELS = {
  confirm: 'Підтвердити зараз',
  delivery: 'Без даних НП',
  ttn: 'Готові без ТТН',
  branch: 'Довго на відділенні',
  stale: 'НП давно не оновлювалась',
};

function orderCrmMenuKb(period = 'today') {
  return {
    inline_keyboard: [
      [
        { text: `${period === 'today' ? '• ' : ''}📅 Сьогодні`, callback_data: 'crm_orders_period_today' },
        { text: `${period === 'week' ? '• ' : ''}📆 7 днів`, callback_data: 'crm_orders_period_week' },
      ],
      [
        { text: `${period === 'month' ? '• ' : ''}🗓 Місяць`, callback_data: 'crm_orders_period_month' },
        { text: `${period === 'all' ? '• ' : ''}∞ Увесь час`, callback_data: 'crm_orders_period_all' },
      ],
      [
        { text: '🆕 Підтвердити', callback_data: `crm_orders_queue_confirm_${period}` },
        { text: '🧾 Без даних НП', callback_data: `crm_orders_queue_delivery_${period}` },
      ],
      [
        { text: '🚚 Без ТТН', callback_data: `crm_orders_queue_ttn_${period}` },
        { text: '🏤 На відділенні', callback_data: `crm_orders_queue_branch_${period}` },
      ],
      [
        { text: '🕒 Стара НП', callback_data: `crm_orders_queue_stale_${period}` },
        { text: '🔄 Оновити НП', callback_data: 'np_sync_all' },
      ],
      [
        { text: '📦 Всі замовлення', callback_data: 'orders' },
        { text: '← CRM', callback_data: 'crm_menu' },
      ],
    ],
  };
}

function orderCrmQueueRows(items, period, view) {
  const rows = items.slice(0, 10).map(item => [{
    text: `#${item.id} ${item.name || '—'} · ${waitTime(item.ageMs)}`,
    callback_data: `od_${item.id}`,
  }]);
  rows.push([{ text: '← CRM замовлень', callback_data: `crm_orders_period_${period}` }]);
  if (view === 'stale') rows.unshift([{ text: '🔄 Оновити всі НП', callback_data: 'np_sync_all' }]);
  return { inline_keyboard: rows };
}

function orderQueueItems(data, view) {
  const queues = data?.queues || {};
  return {
    confirm: queues.confirm,
    delivery: queues.missingDelivery,
    ttn: queues.readyWithoutTtn,
    branch: queues.branch,
    stale: queues.staleTracking,
  }[view] || [];
}

function orderCrmItemLine(item, detail = '') {
  const product = item.product ? ` · ${esc(item.product)}` : '';
  const np = item.npStatus ? ` · ${esc(item.npStatus)}` : '';
  return `#${esc(item.id)} ${esc(item.name || '—')}${product} · <b>${waitTime(item.ageMs)}</b>${detail}${np}`;
}

function queuePreview(items, detail = '') {
  if (!Array.isArray(items) || !items.length) return 'немає';
  return items.slice(0, 3).map(item => orderCrmItemLine(item, detail)).join('\n');
}

async function loadOrderCrmSummary(period) {
  return serverGet(`/api/admin/crm/orders/summary?period=${encodeURIComponent(period)}`);
}

async function showOrderCrmReport(chatId, period = 'today', msgId = null) {
  const data = await loadOrderCrmSummary(period);
  if (!data || data.error) return reply(chatId, '❌ CRM замовлень зараз недоступна.', orderCrmMenuKb(period), msgId);

  const totals = data.totals || {};
  const timings = data.timings || {};
  const queues = data.queues || {};
  const products = Array.isArray(data.leaders?.products) ? data.leaders.products : [];
  const sizes = Array.isArray(data.leaders?.sizes) ? data.leaders.sizes : [];
  const productLine = products.length
    ? products.map(item => `${esc(item.label)} ${item.orders} шт`).join(' · ')
    : '—';
  const sizeLine = sizes.length
    ? sizes.map(item => `${esc(item.size)}:${item.count}`).join(' · ')
    : '—';

  const text =
    `📦 <b>CRM замовлень — ${CRM_PERIOD_LABELS[period] || period}</b>\n━━━━━━━━━━━━━━━\n` +
    `Створено за період: <b>${totals.periodOrders || 0}</b>  сьогодні: <b>${totals.todayOrders || 0}</b>\n` +
    `🆕 Чекають підтвердження: <b>${totals.waitingConfirmation || 0}</b>  📞 без відповіді: <b>${totals.noAnswer || 0}</b>\n` +
    `✅ Підтверджено: <b>${totals.confirmed || 0}</b>  🚚 відправлено: <b>${totals.shipped || 0}</b>\n` +
    `🏤 На відділенні: <b>${totals.atBranch || 0}</b>  💸 викуп: <b>${totals.paid || 0}</b>  ↩️ поверн.: <b>${totals.returns || 0}</b>\n\n` +
    `<b>Що потребує дії</b>\n` +
    `🆕 Підтвердити зараз: <b>${totals.waitingConfirmation || 0}</b>\n` +
    `🧾 Без даних для НП: <b>${totals.missingDelivery || 0}</b>\n` +
    `🚚 Готові без ТТН: <b>${totals.readyWithoutTtn || 0}</b>\n` +
    `🕒 НП давно не оновлювалась: <b>${totals.staleTracking || 0}</b>\n\n` +
    `<b>Час</b>\n` +
    `Очікування нових: середнє <b>${waitTime(timings.averageNewAgeMs)}</b>, найдовше <b>${waitTime(timings.oldestNewAgeMs)}</b>\n` +
    `До підтвердження: <b>${waitTime(timings.averageConfirmMs)}</b> по ${timings.confirmSamples || 0} замовл.\n` +
    `До ТТН після підтвердження: <b>${waitTime(timings.averageTtnMs)}</b> по ${timings.ttnSamples || 0} замовл.\n` +
    `Активні ТТН: <b>${totals.activeTracking || 0}</b>, середній вік <b>${waitTime(timings.averageTransitAgeMs)}</b>\n` +
    `Найдовше на відділенні від відправки: <b>${waitTime(timings.oldestBranchAgeMs)}</b>\n\n` +
    `<b>Зараз першими</b>\n` +
    `Підтвердити:\n${queuePreview(queues.confirm)}\n\n` +
    `На відділенні:\n${queuePreview(queues.branch)}\n\n` +
    `<b>Лідери періоду</b>\n` +
    `Моделі: ${productLine}\n` +
    `Розміри: ${sizeLine}`;
  reply(chatId, text, orderCrmMenuKb(period), msgId);
}

async function showOrderCrmQueue(chatId, view, period = 'today', msgId = null) {
  const data = await loadOrderCrmSummary(period);
  if (!data || data.error) return reply(chatId, '❌ Черга CRM замовлень зараз недоступна.', orderCrmMenuKb(period), msgId);
  const items = orderQueueItems(data, view);
  if (!items.length) return reply(chatId, `✅ <b>${ORDER_CRM_QUEUE_LABELS[view] || 'Черга'}</b>\n\nТут зараз порожньо.`, orderCrmMenuKb(period), msgId);

  let text = `📦 <b>${ORDER_CRM_QUEUE_LABELS[view] || 'Черга замовлень'}</b>\n━━━━━━━━━━━━━━━\n`;
  items.slice(0, 10).forEach(item => {
    text += `${orderCrmItemLine(item)}\n`;
    if (item.ttn) text += `   ТТН <code>${esc(item.ttn)}</code>\n`;
    if (item.city || item.postOffice) text += `   ${esc([item.city, item.postOffice].filter(Boolean).join(' · '))}\n`;
  });
  if (items.length > 10) text += `\n…і ще ${items.length - 10} замовлень`;
  reply(chatId, text, orderCrmQueueRows(items, period, view), msgId);
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
bot.onText(/\/start/, async msg => {
  if (!isAdmin(msg.from.id)) return;
  await bot.sendMessage(msg.chat.id,
    `🟣 <b>Violet Motion — Адмін панель</b>\n\nОберіть розділ кнопками нижче:`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB });
});

bot.onText(/\/analytics/, msg => { if (!isAdmin(msg.from.id)) return; showAnalyticsMenu(msg.chat.id); });
bot.onText(/\/search (.+)/, (msg, match) => { if (!isAdmin(msg.from.id)) return; showOrders(msg.chat.id, 1, match[1].trim().toLowerCase()); });
bot.onText(/\/orders/,  msg => { if (!isAdmin(msg.from.id)) return; showOrders(msg.chat.id); });
bot.onText(/\/track(?:ing)?/, msg => { if (!isAdmin(msg.from.id)) return; showTrackingMenu(msg.chat.id); });
bot.onText(/\/reviews/, msg => { if (!isAdmin(msg.from.id)) return; showReviews(msg.chat.id); });
bot.onText(/\/support/, msg => { if (!isAdmin(msg.from.id)) return; showSupport(msg.chat.id); });
bot.onText(/\/crm/,     msg => { if (!isAdmin(msg.from.id)) return; showCrmPicker(msg.chat.id); });
bot.onText(/\/stats/,   msg => { if (!isAdmin(msg.from.id)) return; showStats(msg.chat.id); });

/* ═══════════════════════════════════════════════════════════
   TEXT MESSAGES
═══════════════════════════════════════════════════════════ */
bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAdmin(msg.from.id)) return;

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

  if (pendingDelivery[chatId]) {
    await saveManagerDeliveryInput(chatId, text);
    return;
  }

  if (pendingNpSender[chatId]) {
    await resolveNpSenderInput(chatId, text);
    return;
  }

  if (pendingProductCost[chatId]) {
    const product = pendingProductCost[chatId];
    if (text === '-' || text.toLowerCase() === 'cancel') {
      delete pendingProductCost[chatId];
      await showCrmProducts(chatId);
      return;
    }

    const cost = Number(text.replace(',', '.').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(cost) || cost <= 0) {
      await bot.sendMessage(chatId, '❌ Надішліть собівартість числом, наприклад 420. Для скасування надішліть "-".', { reply_markup: MAIN_KB });
      return;
    }

    const updated = await serverPatch(`/api/admin/crm/products/${encodeURIComponent(product.key)}/cost`, { cost });
    if (!updated || updated.error) {
      await bot.sendMessage(chatId, '❌ Не вдалося оновити собівартість моделі.', { reply_markup: MAIN_KB });
      return;
    }

    delete pendingProductCost[chatId];
    await bot.sendMessage(chatId, `✅ ${updated.label}: нова собівартість <b>${money(updated.cost)}</b>.`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
    await showCrmProducts(chatId);
    return;
  }

  if (pendingTtn[chatId]) {
    const id = pendingTtn[chatId];
    delete pendingTtn[chatId];
    const ttn = text.trim();

    if (!ttn) {
      await bot.sendMessage(chatId, '❌ Введіть ТТН текстом.', { reply_markup: MAIN_KB });
      return;
    }

    const order = await serverGet(`/api/admin/orders/${id}`);
    if (!order || order.error) {
      await bot.sendMessage(chatId, '❌ Замовлення не знайдено.', { reply_markup: MAIN_KB });
      return;
    }

    const updated = await serverPatch(`/api/admin/orders/${id}`, {
      ttn,
      status: ['paid', 'completed'].includes(order.status) ? order.status : 'confirmed',
      deliveryStatus: 'ttn_added',
      ttnCreatedAt: order.ttnCreatedAt || new Date().toISOString(),
    });

    if (!updated || updated.error) {
      await bot.sendMessage(chatId, '❌ Не вдалося зберегти ТТН.', { reply_markup: MAIN_KB });
      return;
    }

    await bot.sendMessage(chatId, `✅ ТТН збережено для замовлення #${id}.`, { reply_markup: MAIN_KB });
    await showOrderDetail(chatId, id);
    return;
  }

  switch (text) {
    case '📦 Замовлення':  showOrders(chatId);       break;
    case '🚚 Відстеження': showTrackingMenu(chatId); break;
    case '💬 Відгуки':     showReviews(chatId);      break;
    case '🎧 Підтримка':   showSupport(chatId);      break;
    case '💼 CRM':         showCrmPicker(chatId);    break;
    case '📊 Статистика':  showStats(chatId);         break;
    case '📈 Аналітика':   showAnalyticsMenu(chatId); break;

    case '🔍 Пошук':
      pendingSearch[chatId] = true;
      await bot.sendMessage(chatId, "🔍 Введіть ім'я, телефон або розмір:", {
        reply_markup: { inline_keyboard: [[{ text: '← Скасувати', callback_data: 'orders' }]] },
      });
      break;

    case '❓ Допомога':
      await bot.sendMessage(chatId,
        `<b>Команди:</b>\n/orders — замовлення\n/crm — CRM та гроші\n/reviews — відгуки\n/support — підтримка\n/stats — статистика\n/analytics — аналітика\n/search Ім'я — пошук\n\n` +
        `💼 <b>CRM:</b> окремо замовлення з чергами дій і фінанси з фактом/прогнозом прибутку.\n\n` +
        `📈 <b>Аналітика:</b> кнопка в меню або /analytics\nПоказує: сесії, скрол, кліки, воронку, останні дії.\n\n` +
        `💬 <b>Підтримка:</b> коли приймаєте діалог — всі ваші повідомлення йдуть клієнту у реальному часі. Для завершення — 🔚 Завершити діалог`,
        { parse_mode: 'HTML', reply_markup: MAIN_KB }
      );
      break;

    default:
      if (pendingSearch[chatId]) {
        delete pendingSearch[chatId];
        showOrders(chatId, 1, text.toLowerCase());
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
  const cbKey  = `${chatId}_${data}`;

  if (!isAdmin(q.from.id)) { await ack(q.id, '🚫 Доступ заборонено.'); return; }
  if (data === 'noop')      { await ack(q.id); return; }

  if (pendingCb.has(cbKey)) { await ack(q.id, '⏳ Зачекайте…'); return; }
  pendingCb.add(cbKey);
  await ack(q.id);

  try {
    if (data === 'main') {
      await reply(chatId, '🟣 <b>Violet Motion — Адмін панель</b>\n\nОберіть розділ кнопками нижче:', MAIN_KB, msgId);
      return;
    }

    /* ─ CRM callbacks ───────────────────────────────────── */
    if (data === 'crm_menu') { await showCrmPicker(chatId, msgId); return; }

    if (data === 'crm_finance') { await showCrmReport(chatId, 'today', msgId); return; }

    if (data === 'crm_orders') { await showOrderCrmReport(chatId, 'today', msgId); return; }

    if (data.startsWith('crm_period_')) {
      const period = data.slice('crm_period_'.length);
      await showCrmReport(chatId, ['today', 'week', 'month', 'all'].includes(period) ? period : 'today', msgId);
      return;
    }

    if (data.startsWith('crm_sync_')) {
      const period = data.slice('crm_sync_'.length);
      const safePeriod = ['today', 'week', 'month', 'all'].includes(period) ? period : 'today';
      const sync = await serverPost('/api/admin/monobank/sync', { daysBack: 7 });
      if (!sync || sync.error) {
        await reply(chatId, `❌ Monobank не синхронізувався: ${esc(sync?.error || 'помилка')}`, crmMenuKb(safePeriod), msgId);
        return;
      }
      await showCrmReport(chatId, safePeriod, msgId);
      return;
    }

    if (data.startsWith('crm_review_item_')) {
      const match = data.match(/^crm_review_item_(\d+)_(today|week|month|all)_(\d+)$/);
      if (match) await showCrmReviewItem(chatId, Number(match[1]), match[2], Number(match[3]) || 1, msgId);
      return;
    }

    if (data.startsWith('crm_review_')) {
      const match = data.match(/^crm_review_(today|week|month|all)_(\d+)$/);
      if (match) await showCrmReview(chatId, match[1], Number(match[2]) || 1, msgId);
      return;
    }

    if (data.startsWith('crm_class_')) {
      const match = data.match(/^crm_class_(\d+)_(business_income|ignored_income|personal|ads|shipping|return|business)_(today|week|month|all)_(\d+)$/);
      if (!match) return;
      const result = await serverPatch(`/api/admin/finance/${encodeURIComponent(match[1])}/classify`, { category: match[2] });
      if (!result || result.error) {
        await reply(chatId, `❌ Не вдалося класифікувати операцію: ${esc(result?.error || 'помилка')}`, crmMenuKb(match[3]), msgId);
        return;
      }
      await showCrmReview(chatId, match[3], Number(match[4]) || 1, msgId);
      return;
    }

    if (data.startsWith('crm_tx_')) {
      const [, , period, pageStr] = data.split('_');
      await showCrmTransactions(chatId, ['today', 'week', 'month', 'all'].includes(period) ? period : 'today', Number(pageStr) || 1, msgId);
      return;
    }

    if (data.startsWith('crm_orders_period_')) {
      const period = data.slice('crm_orders_period_'.length);
      await showOrderCrmReport(chatId, ['today', 'week', 'month', 'all'].includes(period) ? period : 'today', msgId);
      return;
    }

    if (data.startsWith('crm_orders_queue_')) {
      const rest = data.slice('crm_orders_queue_'.length);
      const separator = rest.lastIndexOf('_');
      const view = separator >= 0 ? rest.slice(0, separator) : rest;
      const period = separator >= 0 ? rest.slice(separator + 1) : 'today';
      await showOrderCrmQueue(chatId, view, ['today', 'week', 'month', 'all'].includes(period) ? period : 'today', msgId);
      return;
    }

    if (data === 'crm_products') {
      await showCrmProducts(chatId, msgId);
      return;
    }

    if (data.startsWith('crm_cost_')) {
      const key = data.slice('crm_cost_'.length);
      const catalog = await serverGet('/api/admin/crm/products');
      const product = Array.isArray(catalog?.products) ? catalog.products.find(item => item.key === key) : null;
      if (!product) {
        await bot.sendMessage(chatId, '❌ Модель не знайдено.', { reply_markup: MAIN_KB });
        return;
      }
      pendingProductCost[chatId] = { key: product.key, label: product.label };
      await bot.sendMessage(chatId, `✏️ Нова собівартість для <b>${esc(product.label)}</b>.\nЗараз: <b>${money(product.cost)}</b>\n\nНадішліть число або "-" для скасування.`, {
        parse_mode: 'HTML',
        reply_markup: MAIN_KB,
      });
      return;
    }

    /* ─ Analytics callbacks ─────────────────────────────── */
    if (data === 'an_menu') { showAnalyticsMenu(chatId, msgId); return; }

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

      showAnalyticsReport(chatId, period, view, msgId);
      return;
    }

    /* ─ Orders ──────────────────────────────────────────── */
    if (data === 'orders') { showOrders(chatId, 1, null, msgId); return; }

    if (data.startsWith('of_')) {
      const [, pageStr, model, status] = data.split('_');
      showOrders(chatId, Number(pageStr), null, msgId, { model, status });
      return;
    }

    if (data.startsWith('op_')) {
      const [pageStr, filterStr] = data.replace('op_', '').split('_f_');
      showOrders(chatId, Number(pageStr), filterStr || null, msgId);
      return;
    }

    if (data.startsWith('od_')) {
      delete pendingNpSender[chatId];
      showOrderDetail(chatId, Number(data.slice(3)), msgId);
      return;
    }

    if (data === 'track_menu') { await showTrackingMenu(chatId, msgId); return; }

    if (data === 'trk_active') { await showTrackingList(chatId, msgId); return; }

    if (data === 'trk_returns') { await showReturnTrackingList(chatId, 'all', 1, msgId); return; }

    if (data.startsWith('trk_returns_')) {
      const rest = data.slice('trk_returns_'.length);
      if (/^\d+$/.test(rest)) {
        await showReturnTrackingList(chatId, 'all', Number(rest) || 1, msgId);
        return;
      }
      const match = rest.match(/^(all|arrived|request|transit)_(\d+)$/);
      await showReturnTrackingList(chatId, match?.[1] || 'all', Number(match?.[2]) || 1, msgId);
      return;
    }

    if (data === 'np_sync_all') { await syncAllNpOrders(chatId, msgId); return; }

    if (data === 'np_sync_returns') { await syncAllNpOrders(chatId, msgId, 'returns'); return; }

    if (data.startsWith('nt_')) { await showNpTrack(chatId, Number(data.slice(3)), msgId); return; }

    if (data.startsWith('nprt_')) { await showNpReturnTrack(chatId, Number(data.slice(5)), msgId); return; }

    if (data.startsWith('nprcreate_')) { await createNpReturn(chatId, Number(data.slice(10)), msgId); return; }

    if (data.startsWith('nprdone_')) { await markNpReturnPickedUp(chatId, Number(data.slice(8)), msgId); return; }

    if (data.startsWith('npsync_')) { await syncNpOrder(chatId, Number(data.slice(7)), msgId); return; }

    if (data.startsWith('fill_') || data.startsWith('npdata_')) {
      const id = Number(data.slice(data.startsWith('fill_') ? 5 : 7));
      await askManagerDeliveryStep(chatId, id, 0);
      return;
    }

    if (data.startsWith('delivery_cancel_') || data.startsWith('npcancel_')) {
      const id = Number(data.slice(data.startsWith('delivery_cancel_') ? 16 : 9));
      delete pendingDelivery[chatId];
      await showOrderDetail(chatId, id, msgId);
      return;
    }

    if (data.startsWith('npcity_')) {
      const [, idStr, choiceStr] = data.split('_');
      const id = Number(idStr);
      const pending = pendingDelivery[chatId];
      const choice = pending?.id === id ? pending.settlementChoices?.[Number(choiceStr)] : null;
      if (!pending || !choice?.present) {
        await askManagerDeliveryStep(chatId, id, 1);
        return;
      }
      const nextData = { ...(pending.data || {}), city: choice.present, cityRef: choice.ref };
      await askManagerDeliveryStep(chatId, id, pending.stepIndex + 1, nextData);
      return;
    }

    if (data.startsWith('nps_mode_')) {
      const [, , mode, idStr, forceStr] = data.split('_');
      await askNpSenderLocation(chatId, Number(idStr), mode === 'p' ? 'postomat' : 'branch', forceStr === '1');
      return;
    }

    if (data.startsWith('nps_back_')) {
      const [, , idStr, forceStr] = data.split('_');
      await startNpSenderLocation(chatId, Number(idStr), forceStr === '1', msgId);
      return;
    }

    if (data.startsWith('nps_retry_')) {
      const id = Number(data.slice('nps_retry_'.length));
      const pending = pendingNpSender[chatId];
      if (!pending || pending.id !== id) {
        await startNpSenderLocation(chatId, id, false, msgId);
        return;
      }
      await askNpSenderLocation(chatId, id, pending.type, pending.force);
      return;
    }

    if (data.startsWith('nps_confirm_')) {
      const id = Number(data.slice('nps_confirm_'.length));
      const pending = pendingNpSender[chatId];
      if (!pending || pending.id !== id || !pending.location?.ref) {
        await startNpSenderLocation(chatId, id, false, msgId);
        return;
      }
      const selectedLocation = pending.location;
      const force = pending.force;
      delete pendingNpSender[chatId];
      await createNpTtn(chatId, id, force, msgId, selectedLocation);
      return;
    }

    if (data.startsWith('npcreate_')) {
      const force = data.startsWith('npcreate_force_');
      const id = Number(data.slice(force ? 15 : 9));
      await startNpSenderLocation(chatId, id, force, msgId);
      return;
    }

    if (data.startsWith('nprecreate_')) {
      await startNpSenderLocation(chatId, Number(data.slice(11)), true, msgId);
      return;
    }

    if (data.startsWith('oi_') || data.startsWith('ttn_')) {
      const id = data.startsWith('oi_') ? Number(data.split('_')[1]) : Number(data.slice(4));
      delete pendingDelivery[chatId];
      pendingTtn[chatId] = id;
      await bot.sendMessage(chatId, `🧾 Введіть ТТН для замовлення #${id}:`, {
        reply_markup: { inline_keyboard: [[{ text: '← До замовлення', callback_data: `od_${id}` }]] },
      });
      return;
    }

    if (data.startsWith('os_') || data.startsWith('confirm_') || data.startsWith('cancel_')) {
      const oldStyle = data.startsWith('os_');
      const [, oldId, oldCode] = oldStyle ? data.split('_') : [];
      const isConf = oldStyle ? oldCode === 'c' : data.startsWith('confirm_');
      const id     = oldStyle ? Number(oldId) : Number(data.replace(isConf ? 'confirm_' : 'cancel_', ''));
      const order  = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }
      if (isConf) {
        await confirmOrderByManager(chatId, id, msgId, q.from?.id);
        return;
      }
      const updated = await serverPatch(`/api/admin/orders/${id}`, { status: 'cancelled' });
      if (!updated || updated.error) { await bot.sendMessage(chatId, '❌ Не вдалося змінити статус.', { reply_markup: MAIN_KB }); return; }
      await bot.sendMessage(chatId,
        `❌ Замовлення #${id} (${updated.name}) — <b>скасовано</b>`,
        { parse_mode: 'HTML', reply_markup: MAIN_KB });
      return;
    }

    if (data.startsWith('del_order_')) {
      const id = Number(data.slice(10));
      const order = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) {
        await reply(chatId, `❌ Замовлення #${id} не знайдено.`, MAIN_KB, msgId);
        return;
      }
      await reply(chatId,
        `🗑 <b>Видалити замовлення #${esc(id)}?</b>\n\n` +
        `${esc(order.name || '—')} · ${esc(order.product || '—')}` +
        (order.ttn ? `\nТТН: <code>${esc(order.ttn)}</code>` : '') +
        `\n\nЦю дію не можна скасувати.`,
        { inline_keyboard: [
          [{ text: '🗑 Так, видалити', callback_data: `del_confirm_${id}` }],
          [{ text: '← Скасувати', callback_data: `od_${id}` }],
        ] },
        msgId);
      return;
    }

    if (data.startsWith('del_confirm_')) {
      const id = Number(data.slice(12));
      const deleted = await serverDelete(`/api/admin/orders/${id}`);
      if (!deleted || deleted.error) { await reply(chatId, `❌ Не вдалося видалити #${id}.`, MAIN_KB, msgId); return; }
      await showOrders(chatId, 1, null, msgId);
      return;
    }

    /* ─ Reviews ─────────────────────────────────────────── */
    if (data.startsWith('rv_'))         { showReviews(chatId, Number(data.slice(3)), msgId); return; }

    if (data.startsWith('del_review_')) {
      const id = Number(data.slice(11));
      const deleted = await serverDelete(`/api/admin/reviews/${id}`);
      if (!deleted || deleted.error) { await bot.sendMessage(chatId, `❌ Не вдалося видалити відгук #${id}.`, { reply_markup: MAIN_KB }); return; }
      await bot.sendMessage(chatId, `🗑 Відгук #${id} видалено.`, { reply_markup: MAIN_KB });
      return;
    }

    /* ─ Support ─────────────────────────────────────────── */
    if (data.startsWith('sp_'))         { showSupport(chatId, Number(data.slice(3)), msgId); return; }

    if (data.startsWith('accept_')) {
      const sessionId = data.slice(7);
      const accepted = await serverPost('/api/support/accept', { sessionId, managerId: chatId });
      const activeSessionId = accepted?.sessionId || sessionId;
      managerDialogs[chatId] = activeSessionId;
      await bot.sendMessage(chatId,
        `✋ Ви прийняли діалог.\n\nСесія: <code>${sessionId}</code>\n\nПишіть — клієнт отримає ваші повідомлення в реальному часі.\nДля завершення натисніть 🔚 Завершити діалог`,
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
