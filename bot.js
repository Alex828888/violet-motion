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
const pendingNpData  = {};
const pendingTtn     = {};
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
    ['📊 Статистика', '📈 Аналітика'],
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
function ordersKeyboard(items, page, total, filter) {
  const rows = items.map(o => [{ text: `${statusEmoji(o.status)} #${o.id} ${o.name || '—'}${o.product ? ' · ' + o.product : ''} (р.${o.size || '—'})`, callback_data: `od_${o.id}` }]);
  const nav = [];
  if (page > 1)     nav.push({ text: '← Назад', callback_data: `op_${page - 1}${filter ? '_f_' + filter : ''}` });
  nav.push({ text: `${page}/${total}`, callback_data: 'noop' });
  if (page < total) nav.push({ text: 'Далі →', callback_data: `op_${page + 1}${filter ? '_f_' + filter : ''}` });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

async function showOrders(chatId, page = 1, filter = null, msgId = null) {
  let orders = await serverGet('/api/admin/orders');
  if (!Array.isArray(orders)) return reply(chatId, '❌ Не вдалося завантажити замовлення.', MAIN_KB, msgId);
  orders = orders.reverse();
  const q = filter ? String(filter).trim().toLowerCase() : '';
  if (q) {
    orders = orders.filter(o => [
      o.name, o.fullName, o.phone, o.size, o.id, o.ttn, o.status, o.paymentStatus,
      o.product, o.color, o.city, o.postOffice, o.npStatus,
    ].some(v => String(v || '').toLowerCase().includes(q)));
  }
  if (!orders.length) return reply(chatId, q ? `🔍 Нічого по "<b>${esc(q)}</b>"` : '📦 Замовлень поки немає.', MAIN_KB, msgId);

  const { items, page: p, total } = paginate(orders, page);
  let text = q
    ? `🔍 Пошук "<b>${esc(q)}</b>" — знайдено ${orders.length}:\n\n`
    : `📦 <b>Замовлення</b> (${orders.length}):\n\n`;

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
  reply(chatId, text, ordersKeyboard(items, p, total, q), msgId);
}

function orderDetailKeyboard(o) {
  const id = o.id;
  const rows = [];
  if ((o.status || 'new') === 'new') {
    rows.push([{ text: '✅ Підтвердити', callback_data: `confirm_${id}` }, { text: '❌ Скасувати', callback_data: `cancel_${id}` }]);
  }
  if (['confirmed', 'shipped'].includes(o.status || 'new')) {
    rows.push([{ text: hasNovaPoshtaData(o) ? '✏️ Дані НП' : '📦 Заповнити дані НП', callback_data: `npdata_${id}` }]);
    if (!o.ttn) {
      rows.push([{ text: '📮 Створити ТТН', callback_data: `npcreate_${id}` }]);
    }
    rows.push([{ text: '🧾 Внести ТТН вручну', callback_data: `ttn_${id}` }]);
  }
  if (o.ttn) {
    rows.push([
      { text: '🔍 Статус НП', callback_data: `nt_${id}` },
      { text: '🔄 Оновити НП', callback_data: `npsync_${id}` },
    ]);
    if (['confirmed', 'shipped'].includes(o.status || 'new')) {
      rows.push([{ text: '♻️ Пересоздати ТТН', callback_data: `nprecreate_${id}` }]);
    }
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
    (o.product ? `🛍 Товар: <b>${esc(o.product)}</b>\n` : '') +
    `👤 <b>${esc(o.name || '—')}</b>\n📱 ${esc(o.phone || '—')}\n` +
    `👟 Розмір: ${esc(o.size || '—')}\n` +
    (o.color ? `🎨 Колір: ${esc(o.color)}\n` : '') +
    (o.price ? `💵 Ціна: ${esc(o.price)} грн\n` : '') +
    (o.contactViaTelegram ? `💬 Зв'язок: Telegram\n` : `📞 Зв'язок: Дзвінок\n`) +
    `🏷 Статус замовлення: ${statusEmoji(o.status)} <b>${esc(o.status || 'new')}</b>\n` +
    `💳 Статус оплати: <b>${esc(paymentLabel(o))}</b>\n` +
    `🚚 Статус доставки: <b>${esc(deliveryLabel(o))}</b>\n` +
    deliveryBlock(o) +
    novaPoshtaBlock(o) +
    `📅 ${fmtDate(o.createdAt)}\n━━━━━━━━━━━━━━━`;
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

async function syncNpOrder(chatId, id, msgId = null) {
  const result = await serverPost(`/api/admin/orders/${id}/np/sync`, {});
  if (!result || result.error) return bot.sendMessage(chatId, '❌ Не вдалося оновити Нову Пошту.', { reply_markup: MAIN_KB });
  await bot.sendMessage(chatId, `🔄 НП оновлено: <b>${esc(result.track?.status || result.order?.npStatus || 'ok')}</b>`, { parse_mode: 'HTML', reply_markup: MAIN_KB });
  await showOrderDetail(chatId, id, msgId);
}

const NP_DATA_STEPS = [
  {
    key: 'fullName',
    prompt: '🧾 Введіть ім’я та прізвище отримувача для Нової Пошти:',
    required: true,
  },
  {
    key: 'city',
    prompt: '🏙 Введіть місто отримувача:',
    required: true,
  },
  {
    key: 'district',
    prompt: '📍 Введіть район, якщо потрібен. Щоб пропустити, напишіть "-":',
    required: false,
  },
  {
    key: 'postOffice',
    prompt: '📦 Введіть номер або назву відділення Нової Пошти:',
    required: true,
  },
];

async function promptNpDataStep(chatId, flow) {
  const step = NP_DATA_STEPS[flow.step];
  if (!step) return;
  await bot.sendMessage(chatId, `${step.prompt}\n\nКрок ${flow.step + 1}/${NP_DATA_STEPS.length}`, {
    reply_markup: { inline_keyboard: [[{ text: '← До замовлення', callback_data: `npcancel_${flow.id}` }]] },
  });
}

async function startNpDataFlow(chatId, id) {
  const order = await serverGet(`/api/admin/orders/${id}`);
  if (!order || order.error) {
    await bot.sendMessage(chatId, '❌ Замовлення не знайдено.', { reply_markup: MAIN_KB });
    return;
  }

  delete pendingTtn[chatId];
  pendingNpData[chatId] = { id, step: 0, fields: {} };
  await bot.sendMessage(chatId,
    `📦 Дані для відправки замовлення #${id}\n` +
    `Телефон вже беру із замовлення: ${order.phone || '—'}`,
    { reply_markup: MAIN_KB });
  await promptNpDataStep(chatId, pendingNpData[chatId]);
}

async function saveNpDataInput(chatId, text) {
  const flow = pendingNpData[chatId];
  const step = NP_DATA_STEPS[flow.step];
  const value = text.trim();
  const skipOptional = !step.required && value === '-';

  if (step.required && !value) {
    await bot.sendMessage(chatId, '❌ Це поле потрібне для створення ТТН.');
    await promptNpDataStep(chatId, flow);
    return;
  }
  if (step.key === 'fullName' && value.split(/\s+/).filter(Boolean).length < 2) {
    await bot.sendMessage(chatId, '❌ Для Нової Пошти введіть ім’я та прізвище.');
    await promptNpDataStep(chatId, flow);
    return;
  }

  flow.fields[step.key] = skipOptional ? null : value;
  flow.step += 1;
  if (flow.step < NP_DATA_STEPS.length) {
    await promptNpDataStep(chatId, flow);
    return;
  }

  delete pendingNpData[chatId];
  const order = await serverGet(`/api/admin/orders/${flow.id}`);
  if (!order || order.error) {
    await bot.sendMessage(chatId, '❌ Замовлення не знайдено.', { reply_markup: MAIN_KB });
    return;
  }

  const delivery = {
    ...(order.delivery && typeof order.delivery === 'object' ? order.delivery : {}),
    ...flow.fields,
  };
  const patch = {
    ...flow.fields,
    delivery,
    ...(order.ttn ? {} : { deliveryStatus: 'ready_for_np' }),
  };
  const updated = await serverPatch(`/api/admin/orders/${flow.id}`, patch);
  if (!updated || updated.error) {
    await bot.sendMessage(chatId, '❌ Не вдалося зберегти дані Нової Пошти.', { reply_markup: MAIN_KB });
    return;
  }

  await bot.sendMessage(chatId, `✅ Дані Нової Пошти збережено для замовлення #${flow.id}.`, { reply_markup: MAIN_KB });
  await showOrderDetail(chatId, flow.id);
}

async function createNpTtn(chatId, id, force = false, msgId = null) {
  const order = await serverGet(`/api/admin/orders/${id}`);
  if (!order || order.error) {
    await bot.sendMessage(chatId, '❌ Замовлення не знайдено.', { reply_markup: MAIN_KB });
    return;
  }
  if (!hasNovaPoshtaData(order)) {
    await bot.sendMessage(chatId, '❌ Спочатку заповніть ПІБ, місто та відділення Нової Пошти.', { reply_markup: MAIN_KB });
    await startNpDataFlow(chatId, id);
    return;
  }

  const result = await serverPost(`/api/admin/orders/${id}/np/create`, force ? { force: true } : {});
  if (!result || result.error) {
    const reason = result?.userMessage || result?.error || 'Не вдалося створити ТТН.';
    await bot.sendMessage(chatId, `❌ ${reason}`, { reply_markup: MAIN_KB });
    return;
  }

  const ttn = result.ttn || result.order?.ttn || order.ttn || '—';
  await bot.sendMessage(chatId,
    `${force ? '♻️ ТТН пересоздано' : result.duplicate ? 'ℹ️ ТТН вже існує' : '✅ ТТН створено'} для замовлення #${id}: <code>${esc(ttn)}</code>`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB });
  await showOrderDetail(chatId, id, msgId);
}

async function showTrackingMenu(chatId, msgId = null) {
  let orders = await serverGet('/api/admin/orders');
  if (!Array.isArray(orders)) return reply(chatId, '❌ Не вдалося завантажити відстеження.', MAIN_KB, msgId);
  orders = orders
    .filter(o => o.ttn || o.npStatus || deliveryStatusValue(o))
    .reverse();

  const active = orders.filter(o => o.ttn && !['cancelled', 'returned', 'completed'].includes(o.status || 'new'));
  let text =
    `🚚 <b>Відстеження посилок</b>\n━━━━━━━━━━━━━━━\n` +
    `Активних ТТН: <b>${active.length}</b>\n` +
    `Усього з доставкою/НП: <b>${orders.length}</b>\n\n`;

  orders.slice(0, 10).forEach(o => {
    text += `${statusEmoji(o.status)} <b>#${esc(o.id)}</b> ${esc(o.name || '—')}\n`;
    if (o.ttn) text += `   ТТН: <code>${esc(o.ttn)}</code>\n`;
    text += `   🚚 ${esc(o.npStatus || deliveryLabel(o))}\n`;
    if (o.npSyncedAt) text += `   Оновлено: ${fmtDate(o.npSyncedAt)}\n`;
    text += '\n';
  });
  if (orders.length > 10) text += `…і ще ${orders.length - 10}\n`;

  const rows = orders.slice(0, 10).map(o => {
    const row = [{ text: `📋 #${o.id} ${o.name || '—'}`, callback_data: `od_${o.id}` }];
    if (o.ttn) row.push({ text: '🔄 НП', callback_data: `npsync_${o.id}` });
    return row;
  });
  rows.push([{ text: '← Меню', callback_data: 'main' }]);
  reply(chatId, text, { inline_keyboard: rows }, msgId);
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

  if (pendingNpData[chatId]) {
    await saveNpDataInput(chatId, text);
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
        `<b>Команди:</b>\n/orders — замовлення\n/reviews — відгуки\n/support — підтримка\n/stats — статистика\n/analytics — аналітика\n/search Ім'я — пошук\n\n` +
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

    if (data.startsWith('op_')) {
      const [pageStr, filterStr] = data.replace('op_', '').split('_f_');
      showOrders(chatId, Number(pageStr), filterStr || null, msgId);
      return;
    }

    if (data.startsWith('od_')) { showOrderDetail(chatId, Number(data.slice(3)), msgId); return; }

    if (data === 'track_menu') { await showTrackingMenu(chatId, msgId); return; }

    if (data.startsWith('nt_')) { await showNpTrack(chatId, Number(data.slice(3)), msgId); return; }

    if (data.startsWith('npsync_')) { await syncNpOrder(chatId, Number(data.slice(7)), msgId); return; }

    if (data.startsWith('npdata_')) {
      await startNpDataFlow(chatId, Number(data.slice(7)));
      return;
    }

    if (data.startsWith('npcancel_')) {
      delete pendingNpData[chatId];
      await showOrderDetail(chatId, Number(data.slice(9)), msgId);
      return;
    }

    if (data.startsWith('npcreate_')) {
      await createNpTtn(chatId, Number(data.slice(9)), false, msgId);
      return;
    }

    if (data.startsWith('nprecreate_')) {
      await createNpTtn(chatId, Number(data.slice(11)), true, msgId);
      return;
    }

    if (data.startsWith('ttn_')) {
      const id = Number(data.slice(4));
      delete pendingNpData[chatId];
      pendingTtn[chatId] = id;
      await bot.sendMessage(chatId, `🧾 Введіть ТТН для замовлення #${id}:`, {
        reply_markup: { inline_keyboard: [[{ text: '← До замовлення', callback_data: `od_${id}` }]] },
      });
      return;
    }

    if (data.startsWith('confirm_') || data.startsWith('cancel_')) {
      const isConf = data.startsWith('confirm_');
      const id     = Number(data.replace(isConf ? 'confirm_' : 'cancel_', ''));
      const order  = await serverGet(`/api/admin/orders/${id}`);
      if (!order || order.error) { await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB }); return; }
      const updated = await serverPatch(`/api/admin/orders/${id}`, { status: isConf ? 'confirmed' : 'cancelled' });
      if (!updated || updated.error) { await bot.sendMessage(chatId, '❌ Не вдалося змінити статус.', { reply_markup: MAIN_KB }); return; }
      await bot.sendMessage(chatId,
        `${isConf ? '✅' : '❌'} Замовлення #${id} (${updated.name}) — <b>${isConf ? 'підтверджено' : 'скасовано'}</b>`,
        { parse_mode: 'HTML', reply_markup: MAIN_KB });
      if (isConf) {
        if (hasNovaPoshtaData(updated)) await showOrderDetail(chatId, id, msgId);
        else await startNpDataFlow(chatId, id);
      }
      return;
    }

    if (data.startsWith('del_order_')) {
      const id = Number(data.slice(10));
      const deleted = await serverDelete(`/api/admin/orders/${id}`);
      if (!deleted || deleted.error) { await bot.sendMessage(chatId, `❌ Не вдалося видалити #${id}.`, { reply_markup: MAIN_KB }); return; }
      await bot.sendMessage(chatId, `🗑 Замовлення #${id} видалено.`, { reply_markup: MAIN_KB });
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
