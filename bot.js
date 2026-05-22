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
  return `${Math.round(amount).toLocaleString('uk-UA')} грн`;
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
  const value = raw === '-' ? current : raw;
  if (!value) {
    await bot.sendMessage(chatId, `❌ Введіть ${step.label}, без цього ТТН не створиться.`);
    return true;
  }

  const data = { ...(pending.data || {}), [step.key]: value };
  const nextIndex = pending.stepIndex + 1;
  if (MANAGER_DELIVERY_STEPS[nextIndex]) {
    await askManagerDeliveryStep(chatId, pending.id, nextIndex, data);
    return true;
  }

  const delivery = {
    ...(order.delivery && typeof order.delivery === 'object' ? order.delivery : {}),
    fullName: data.fullName,
    city: data.city,
    postOffice: data.postOffice,
  };
  const updated = await serverPatch(`/api/admin/orders/${pending.id}`, {
    fullName: data.fullName,
    city: data.city,
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

async function createNpTtn(chatId, id, force = false, msgId = null) {
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

  const result = await serverPost(`/api/admin/orders/${id}/np/create`, force ? { force: true } : {});
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

function trackingMenuKeyboard() {
  return { inline_keyboard: [
    [{ text: '🚚 Активні ТТН', callback_data: 'trk_active' }, { text: '🔄 Оновити всі НП', callback_data: 'np_sync_all' }],
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
  const text =
    `🚚 <b>Відстеження</b>\n━━━━━━━━━━━━━━━\n` +
    `🆕 Нові заявки: <b>${newOrders.length}</b>\n` +
    `🚚 Активні ТТН: <b>${activeTtn.length}</b>\n` +
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

async function syncAllNpOrders(chatId, msgId = null) {
  const result = await serverPost('/api/admin/np/sync', { limit: 100 });
  if (!result || result.error) {
    await bot.sendMessage(chatId, '❌ Не вдалося оновити Нову Пошту.', { reply_markup: MAIN_KB });
    return;
  }
  await bot.sendMessage(chatId,
    `🔄 НП оновлено. Перевірено: <b>${esc(result.checked || 0)}</b>, змінено: <b>${esc(result.changed || 0)}</b>.`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB });
  await showTrackingMenu(chatId, msgId);
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
   CRM MONEY DASHBOARD
═══════════════════════════════════════════════════════════ */
const CRM_PERIOD_LABELS = {
  today: 'Сьогодні',
  week: '7 днів',
  month: 'Цей місяць',
  all: 'Увесь час',
};

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
        { text: '🏷 Собівартість моделей', callback_data: 'crm_products' },
        { text: '🔄 Оновити', callback_data: `crm_period_${period}` },
      ],
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
      [{ text: '← CRM', callback_data: 'crm_period_today' }],
    ],
  };
}

async function showCrmReport(chatId, period = 'today', msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${encodeURIComponent(period)}`);
  if (!data || data.error) {
    return reply(chatId, '❌ CRM-звіт зараз недоступний.', crmMenuKb(period), msgId);
  }

  const payments = Array.isArray(data.recentPayments) ? data.recentPayments : [];
  const products = Array.isArray(data.products) ? data.products : [];
  const paymentLines = payments.length
    ? payments.map(item => `#${esc(item.id)} ${esc(item.product)}: <b>+${money(item.revenue)}</b> −${money(item.cost)} = <b>${money(item.net)}</b>`).join('\n')
    : 'Ще немає викуплених замовлень за період.';
  const productLines = products.length
    ? products.map(item => `${esc(item.label)}: викуп ${item.paidOrders}/${item.orders}, факт <b>${money(item.net)}</b>, прогноз <b>${money(item.forecastNet)}</b>, повернення ${ratePct(item.returnRate)}`).join('\n')
    : 'Замовлень за період ще немає.';

  const text =
    `💼 <b>CRM Violet Motion — ${CRM_PERIOD_LABELS[period] || period}</b>\n━━━━━━━━━━━━━━━\n` +
    `📦 Замовлення: <b>${data.orders || 0}</b>  ✅ ${data.paidOrders || 0} викуп  ↩️ ${data.returns || 0} поверн.\n` +
    `🚚 У прогнозі: <b>${data.pipelineOrders || 0}</b> підтверджених/у дорозі\n\n` +
    `<b>Факт</b>\n` +
    `💰 Додано з викупів: <b>+${money(data.revenue)}</b>\n` +
    `🏷 Собівартість: <b>−${money(data.cost)}</b>\n` +
    `🧾 Інші витрати: <b>−${money(data.expense)}</b>\n` +
    `✅ Прибуток факт: <b>${money(data.profit)}</b>\n\n` +
    `<b>Прогноз</b>\n` +
    `📈 Очікуваний прибуток: <b>${money(data.forecastProfit)}</b>\n` +
    `📦 Прогноз грошей: <b>${money(data.forecastRevenue)}</b>\n` +
    `🎯 Викуп: <b>${ratePct(data.buyoutRate)}</b>  ↩️ Повернення: <b>${ratePct(data.returnRate)}</b>\n\n` +
    `<b>Останні зарахування</b>\n${paymentLines}\n\n` +
    `<b>Моделі</b>\n${productLines}`;

  reply(chatId, text, crmMenuKb(period), msgId);
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
bot.onText(/\/crm/,     msg => { if (!isAdmin(msg.from.id)) return; showCrmReport(msg.chat.id); });
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
    case '💼 CRM':         showCrmReport(chatId);    break;
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
        `💼 <b>CRM:</b> факт/прогноз прибутку, повернення, заробіток за сьогодні та редагування собівартості моделей.\n\n` +
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
    if (data === 'crm_menu') { await showCrmReport(chatId, 'today', msgId); return; }

    if (data.startsWith('crm_period_')) {
      const period = data.slice('crm_period_'.length);
      await showCrmReport(chatId, ['today', 'week', 'month', 'all'].includes(period) ? period : 'today', msgId);
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

    if (data.startsWith('op_')) {
      const [pageStr, filterStr] = data.replace('op_', '').split('_f_');
      showOrders(chatId, Number(pageStr), filterStr || null, msgId);
      return;
    }

    if (data.startsWith('od_')) { showOrderDetail(chatId, Number(data.slice(3)), msgId); return; }

    if (data === 'track_menu') { await showTrackingMenu(chatId, msgId); return; }

    if (data === 'trk_active') { await showTrackingList(chatId, msgId); return; }

    if (data === 'np_sync_all') { await syncAllNpOrders(chatId, msgId); return; }

    if (data.startsWith('nt_')) { await showNpTrack(chatId, Number(data.slice(3)), msgId); return; }

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

    if (data.startsWith('npcreate_')) {
      const force = data.startsWith('npcreate_force_');
      const id = Number(data.slice(force ? 15 : 9));
      await createNpTtn(chatId, id, force, msgId);
      return;
    }

    if (data.startsWith('nprecreate_')) {
      await createNpTtn(chatId, Number(data.slice(11)), true, msgId);
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
