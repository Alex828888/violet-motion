/**
 * VIOLET MOTION — TELEGRAM ADMIN BOT
 * node bot.js
 *
 * .env: BOT_TOKEN, ADMIN_IDS, SERVER_URL, API_KEY
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TG_TOKEN ||
  '';

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(Boolean);

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'violet-secret';

if (!TOKEN) {
  console.error('❌ BOT_TOKEN not set');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('🤖 Admin bot started…');

/* ── Auth ────────────────────────────────────────────────────── */
function isAdmin(id) {
  return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(id);
}

/* ── State ───────────────────────────────────────────────────── */
const managerDialogs = {};
const pendingSearch = {};

/* ── HTTP helpers ────────────────────────────────────────────── */
async function serverGet(pathname) {
  try {
    const r = await fetch(`${SERVER_URL}${pathname}`, {
      method: 'GET',
      headers: {
        'x-api-key': API_KEY,
      },
    });
    return await r.json();
  } catch (e) {
    console.error('[relay GET]', e.message);
    return null;
  }
}

async function serverPost(pathname, body) {
  try {
    const r = await fetch(`${SERVER_URL}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    console.error('[relay POST]', e.message);
    return { success: false };
  }
}

async function serverPatch(pathname, body) {
  try {
    const r = await fetch(`${SERVER_URL}${pathname}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    console.error('[relay PATCH]', e.message);
    return { success: false };
  }
}

async function serverDelete(pathname) {
  try {
    const r = await fetch(`${SERVER_URL}${pathname}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': API_KEY,
      },
    });
    return await r.json();
  } catch (e) {
    console.error('[relay DELETE]', e.message);
    return { success: false };
  }
}

/* ── Keyboards ───────────────────────────────────────────────── */
const MAIN_KB = {
  keyboard: [
    ['📦 Замовлення', '💬 Відгуки'],
    ['🎧 Підтримка', '📊 Статистика'],
    ['🔍 Пошук', '❓ Допомога'],
  ],
  resize_keyboard: true,
  persistent: true,
};

const DIALOG_KB = {
  keyboard: [
    ['🔚 Завершити діалог'],
  ],
  resize_keyboard: true,
  persistent: true,
};

/* ── Formatting ──────────────────────────────────────────────── */
function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  } catch {
    return iso || '—';
  }
}

function statusEmoji(s) {
  return {
    new: '🆕',
    confirmed: '✅',
    cancelled: '❌',
  }[s] || '❔';
}

const PAGE = 5;

function paginate(arr, p) {
  const total = Math.ceil(arr.length / PAGE) || 1;
  const page = Math.max(1, Math.min(p, total));
  return {
    items: arr.slice((page - 1) * PAGE, page * PAGE),
    page,
    total,
  };
}

/* ── Send/edit helper ────────────────────────────────────────── */
async function reply(chatId, text, keyboard, msgId = null) {
  const opts = {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  };

  if (msgId) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        ...opts,
      });
      return;
    } catch {}
  }

  await bot.sendMessage(chatId, text, opts);
}

/* ══════════════════════════════════════════════════════════════
   ORDERS
══════════════════════════════════════════════════════════════ */
function ordersKeyboard(items, page, total, filter) {
  const rows = items.map(o => [
    { text: `${statusEmoji(o.status)} #${o.id} ${o.name} (р.${o.size})`, callback_data: `od_${o.id}` }
  ]);

  const nav = [];
  if (page > 1) {
    nav.push({ text: '← Назад', callback_data: `op_${page - 1}${filter ? '_f_' + filter : ''}` });
  }
  nav.push({ text: `${page}/${total}`, callback_data: 'noop' });
  if (page < total) {
    nav.push({ text: 'Далі →', callback_data: `op_${page + 1}${filter ? '_f_' + filter : ''}` });
  }
  if (nav.length) rows.push(nav);

  return { inline_keyboard: rows };
}

async function showOrders(chatId, page = 1, filter = null, msgId = null) {
  let orders = await serverGet('/api/admin/orders');
  if (!Array.isArray(orders)) {
    return reply(chatId, '❌ Не вдалося завантажити замовлення.', MAIN_KB, msgId);
  }

  orders = orders.reverse();

  if (filter) {
    orders = orders.filter(o =>
      o.name?.toLowerCase().includes(filter) ||
      o.phone?.includes(filter) ||
      String(o.size) === filter
    );
  }

  if (!orders.length) {
    return reply(
      chatId,
      filter ? `🔍 Нічого не знайдено по "<b>${filter}</b>"` : '📦 Замовлень поки немає.',
      MAIN_KB,
      msgId
    );
  }

  const { items, page: p, total } = paginate(orders, page);

  let text = filter
    ? `🔍 Пошук "<b>${filter}</b>" — знайдено ${orders.length}:\n\n`
    : `📦 <b>Замовлення</b> (${orders.length}):\n\n`;

  items.forEach(o => {
    text += `${statusEmoji(o.status)} <b>#${o.id}</b> ${o.name}\n`;
    text += `   📱 ${o.phone}  👟 р.${o.size}`;
    if (o.contactViaTelegram) text += '  💬 TG';
    text += `\n   ${fmtDate(o.createdAt)}\n\n`;
  });

  reply(chatId, text, ordersKeyboard(items, p, total, filter), msgId);
}

async function showOrderDetail(chatId, id, msgId = null) {
  const o = await serverGet(`/api/admin/orders/${id}`);
  if (!o || o.error) {
    return bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB });
  }

  const text =
    `📋 <b>Замовлення #${o.id}</b>\n━━━━━━━━━━━━━━━\n` +
    `👤 <b>${o.name}</b>\n` +
    `📱 ${o.phone}\n` +
    `👟 Розмір: ${o.size}\n` +
    (o.contactViaTelegram ? `💬 Зв'язок: Telegram\n` : `📞 Зв'язок: Дзвінок\n`) +
    `🏷 Статус: ${statusEmoji(o.status)} ${o.status}\n` +
    `📅 ${fmtDate(o.createdAt)}\n━━━━━━━━━━━━━━━`;

  reply(chatId, text, {
    inline_keyboard: [
      [
        { text: '✅ Підтвердити', callback_data: `confirm_${o.id}` },
        { text: '❌ Скасувати', callback_data: `cancel_${o.id}` },
      ],
      [
        { text: '🗑 Видалити', callback_data: `del_order_${o.id}` },
      ],
      [
        { text: '← До списку', callback_data: 'orders' },
      ],
    ],
  }, msgId);
}

/* ══════════════════════════════════════════════════════════════
   REVIEWS
══════════════════════════════════════════════════════════════ */
async function showReviews(chatId, page = 1, msgId = null) {
  let reviews = await serverGet('/api/admin/reviews');
  if (!Array.isArray(reviews)) {
    return reply(chatId, '❌ Не вдалося завантажити відгуки.', MAIN_KB, msgId);
  }

  reviews = reviews.reverse();

  if (!reviews.length) return reply(chatId, '💬 Відгуків ще немає.', MAIN_KB, msgId);

  const { items, page: p, total } = paginate(reviews, page);

  let text = `💬 <b>Відгуки</b> (${reviews.length}):\n\n`;
  items.forEach(r => {
    text += `${stars(r.rating)} <b>${r.name}</b>\n<i>${(r.text || '').slice(0, 100)}${(r.text || '').length > 100 ? '…' : ''}</i>\n${r.date || '—'}\n\n`;
  });

  const delRows = items.map(r => [
    { text: `🗑 #${r.id} ${r.name}`, callback_data: `del_review_${r.id}` }
  ]);

  const nav = [];
  if (p > 1) nav.push({ text: '← Назад', callback_data: `rv_${p - 1}` });
  nav.push({ text: `${p}/${total}`, callback_data: 'noop' });
  if (p < total) nav.push({ text: 'Далі →', callback_data: `rv_${p + 1}` });

  const rows = [...delRows];
  if (nav.length) rows.push(nav);

  reply(chatId, text, { inline_keyboard: rows }, msgId);
}

/* ══════════════════════════════════════════════════════════════
   SUPPORT
══════════════════════════════════════════════════════════════ */
async function showSupport(chatId, page = 1, msgId = null) {
  let msgs = await serverGet('/api/admin/support');
  if (!Array.isArray(msgs)) {
    return reply(chatId, '❌ Не вдалося завантажити підтримку.', MAIN_KB, msgId);
  }

  msgs = msgs.reverse();

  if (!msgs.length) return reply(chatId, '🎧 Запитів підтримки немає.', MAIN_KB, msgId);

  const unans = msgs.filter(m => !m.answered).length;
  const { items, page: p, total } = paginate(msgs, page);

  let text = `🎧 <b>Підтримка</b> (${msgs.length} всього, ⚠️ ${unans} без відповіді):\n\n`;
  items.forEach(m => {
    text += `${m.answered ? '✅' : '⚠️'} <b>#${m.id}</b>  ${(m.message || '').slice(0, 80)}\n${fmtDate(m.timestamp)}\n\n`;
  });

  const actRows = items
    .filter(m => !m.answered)
    .map(m => [
      { text: `✋ Прийняти #${m.id}`, callback_data: `accept_${m.sessionId || m.id}` },
    ]);

  const nav = [];
  if (p > 1) nav.push({ text: '← Назад', callback_data: `sp_${p - 1}` });
  nav.push({ text: `${p}/${total}`, callback_data: 'noop' });
  if (p < total) nav.push({ text: 'Далі →', callback_data: `sp_${p + 1}` });

  const rows = [...actRows];
  if (nav.length) rows.push(nav);

  reply(chatId, text, { inline_keyboard: rows }, msgId);
}

/* ══════════════════════════════════════════════════════════════
   STATS
══════════════════════════════════════════════════════════════ */
async function showStats(chatId, msgId = null) {
  const orders = await serverGet('/api/admin/orders');
  const reviews = await serverGet('/api/admin/reviews');
  const support = await serverGet('/api/admin/support');

  if (!Array.isArray(orders) || !Array.isArray(reviews) || !Array.isArray(support)) {
    return reply(chatId, '❌ Не вдалося завантажити статистику.', MAIN_KB, msgId);
  }

  const avg = reviews.length
    ? (reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length).toFixed(1)
    : '—';

  const sc = {};
  orders.forEach(o => { sc[o.size] = (sc[o.size] || 0) + 1; });
  const top = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];

  const text =
    `📊 <b>Статистика</b>\n━━━━━━━━━━━━━━━\n` +
    `📦 Замовлень: <b>${orders.length}</b>  🆕 ${orders.filter(o => o.status === 'new').length}  ✅ ${orders.filter(o => o.status === 'confirmed').length}  ❌ ${orders.filter(o => o.status === 'cancelled').length}\n` +
    `💬 Відгуків: <b>${reviews.length}</b>  ⭐ ${avg}\n` +
    `🎧 Підтримка: <b>${support.length}</b>  ⚠️ ${support.filter(m => !m.answered).length} без відповіді\n` +
    (top ? `👟 Топ розмір: <b>${top[0]}</b> (${top[1]} шт)\n` : '') +
    `━━━━━━━━━━━━━━━`;

  reply(chatId, text, MAIN_KB, msgId);
}

/* ══════════════════════════════════════════════════════════════
   /start — greeting + reply keyboard
══════════════════════════════════════════════════════════════ */
bot.onText(/\/start/, async msg => {
  if (!isAdmin(msg.from.id)) return;

  await bot.sendMessage(
    msg.chat.id,
    `🟣 <b>Violet Motion — Адмін панель</b>\n\nОберіть розділ кнопками нижче:`,
    { parse_mode: 'HTML', reply_markup: MAIN_KB }
  );
});

/* /search shortcut */
bot.onText(/\/search (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  showOrders(msg.chat.id, 1, match[1].trim().toLowerCase());
});
bot.onText(/\/orders/, msg => { if (!isAdmin(msg.from.id)) return; showOrders(msg.chat.id); });
bot.onText(/\/reviews/, msg => { if (!isAdmin(msg.from.id)) return; showReviews(msg.chat.id); });
bot.onText(/\/support/, msg => { if (!isAdmin(msg.from.id)) return; showSupport(msg.chat.id); });
bot.onText(/\/stats/, msg => { if (!isAdmin(msg.from.id)) return; showStats(msg.chat.id); });

/* ══════════════════════════════════════════════════════════════
   TEXT MESSAGES → navigation + dialog relay
══════════════════════════════════════════════════════════════ */
bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAdmin(msg.from.id)) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '📦 Замовлення') {
    if (managerDialogs[chatId]) {
      await bot.sendMessage(chatId, 'ℹ️ Спочатку завершіть активний діалог кнопкою 🔚 Завершити діалог.', { reply_markup: DIALOG_KB });
      return;
    }
    showOrders(chatId);
    return;
  }

  if (text === '💬 Відгуки') {
    if (managerDialogs[chatId]) {
      await bot.sendMessage(chatId, 'ℹ️ Спочатку завершіть активний діалог кнопкою 🔚 Завершити діалог.', { reply_markup: DIALOG_KB });
      return;
    }
    showReviews(chatId);
    return;
  }

  if (text === '🎧 Підтримка') {
    if (managerDialogs[chatId]) {
      await bot.sendMessage(chatId, 'ℹ️ Зараз у вас відкритий діалог. Завершіть його, якщо хочете повернутися до списку.', { reply_markup: DIALOG_KB });
      return;
    }
    showSupport(chatId);
    return;
  }

  if (text === '📊 Статистика') {
    if (managerDialogs[chatId]) {
      await bot.sendMessage(chatId, 'ℹ️ Спочатку завершіть активний діалог кнопкою 🔚 Завершити діалог.', { reply_markup: DIALOG_KB });
      return;
    }
    showStats(chatId);
    return;
  }

  if (text === '🔍 Пошук') {
    if (managerDialogs[chatId]) {
      await bot.sendMessage(chatId, 'ℹ️ Спочатку завершіть активний діалог кнопкою 🔚 Завершити діалог.', { reply_markup: DIALOG_KB });
      return;
    }
    pendingSearch[chatId] = true;
    await bot.sendMessage(chatId, '🔍 Введіть ім\'я, телефон або розмір:', {
      reply_markup: {
        inline_keyboard: [[{ text: '← Скасувати', callback_data: 'orders' }]],
      },
    });
    return;
  }

  if (text === '❓ Допомога') {
    if (managerDialogs[chatId]) {
      await bot.sendMessage(chatId, 'ℹ️ Зараз у вас відкритий діалог. Для завершення натисніть 🔚 Завершити діалог.', { reply_markup: DIALOG_KB });
      return;
    }
    await bot.sendMessage(
      chatId,
      `<b>Команди:</b>\n/orders — замовлення\n/reviews — відгуки\n/support — підтримка\n/stats — статистика\n/search Ім'я — пошук\n\nКоли приймаєте діалог підтримки — всі ваші повідомлення йдуть клієнту. Для завершення натисніть 🔚 Завершити діалог`,
      { parse_mode: 'HTML', reply_markup: MAIN_KB }
    );
    return;
  }

  if (managerDialogs[chatId]) {
    if (text === '🔚 Завершити діалог') {
      const sessionId = managerDialogs[chatId];
      delete managerDialogs[chatId];

      await serverPost('/api/support/end', { sessionId });

      await bot.sendMessage(
        chatId,
        '✅ Діалог завершено. Клієнт отримав повідомлення і запит на оцінку.',
        { reply_markup: MAIN_KB }
      );
      return;
    }

    await serverPost('/api/support/relay', {
      sessionId: managerDialogs[chatId],
      text,
      managerName: msg.from.first_name || 'Оператор',
    });
    return;
  }

  if (pendingSearch[chatId]) {
    delete pendingSearch[chatId];
    showOrders(chatId, 1, text.toLowerCase());
    return;
  }
});

/* ══════════════════════════════════════════════════════════════
   CALLBACK QUERIES
══════════════════════════════════════════════════════════════ */
bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  const data = q.data;

  if (!isAdmin(q.from.id)) {
    try {
      await bot.answerCallbackQuery(q.id, { text: '🚫 Доступ заборонено.' });
    } catch {}
    return;
  }

  try {
    await bot.answerCallbackQuery(q.id);
  } catch {}

  if (data === 'noop') return;

  if (data === 'orders') {
    showOrders(chatId, 1, null, msgId);
    return;
  }

  if (data.startsWith('op_')) {
    const parts = data.split('_f_');
    const page = Number(parts[0].replace('op_', ''));
    const filter = parts[1] || null;
    showOrders(chatId, page, filter, msgId);
    return;
  }

  if (data.startsWith('od_')) {
    showOrderDetail(chatId, Number(data.slice(3)), msgId);
    return;
  }

  if (data.startsWith('confirm_') || data.startsWith('cancel_')) {
    const isConf = data.startsWith('confirm_');
    const id = Number(data.replace(isConf ? 'confirm_' : 'cancel_', ''));

    const order = await serverGet(`/api/admin/orders/${id}`);
    if (!order || order.error) {
      await bot.sendMessage(chatId, '❌ Не знайдено.', { reply_markup: MAIN_KB });
      return;
    }

    const updated = await serverPatch(`/api/admin/orders/${id}`, {
      status: isConf ? 'confirmed' : 'cancelled',
    });

    if (!updated || updated.error) {
      await bot.sendMessage(chatId, '❌ Не вдалося змінити статус замовлення.', { reply_markup: MAIN_KB });
      return;
    }

    await bot.sendMessage(
      chatId,
      `${isConf ? '✅' : '❌'} Замовлення #${id} (${updated.name}) — <b>${isConf ? 'підтверджено' : 'скасовано'}</b>`,
      { parse_mode: 'HTML', reply_markup: MAIN_KB }
    );
    return;
  }

  if (data.startsWith('del_order_')) {
    const id = Number(data.slice(10));

    const deleted = await serverDelete(`/api/admin/orders/${id}`);
    if (!deleted || deleted.error) {
      await bot.sendMessage(chatId, `❌ Не вдалося видалити замовлення #${id}.`, { reply_markup: MAIN_KB });
      return;
    }

    await bot.sendMessage(chatId, `🗑 Замовлення #${id} видалено.`, { reply_markup: MAIN_KB });
    return;
  }

  if (data.startsWith('rv_')) {
    showReviews(chatId, Number(data.slice(3)), msgId);
    return;
  }

  if (data.startsWith('del_review_')) {
    const id = Number(data.slice(11));

    const deleted = await serverDelete(`/api/admin/reviews/${id}`);
    if (!deleted || deleted.error) {
      await bot.sendMessage(chatId, `❌ Не вдалося видалити відгук #${id}.`, { reply_markup: MAIN_KB });
      return;
    }

    await bot.sendMessage(chatId, `🗑 Відгук #${id} видалено.`, { reply_markup: MAIN_KB });
    return;
  }

  if (data.startsWith('sp_')) {
    showSupport(chatId, Number(data.slice(3)), msgId);
    return;
  }

  if (data.startsWith('accept_')) {
    const sessionId = data.slice(7);

    await serverPost('/api/support/accept', {
      sessionId,
      managerId: chatId,
    });

    managerDialogs[chatId] = sessionId;

    await bot.sendMessage(
      chatId,
      `✋ Ви прийняли діалог.\n\nСесія: <code>${sessionId}</code>\n\nПишіть — клієнт отримає ваші повідомлення.\nДля завершення натисніть 🔚 Завершити діалог`,
      { parse_mode: 'HTML', reply_markup: DIALOG_KB }
    );
    return;
  }

  if (data.startsWith('answered_')) {
    const id = Number(data.slice(9));

    const updated = await serverPatch(`/api/admin/support/${id}`, {
      answered: true,
    });

    if (!updated || updated.error) {
      await bot.sendMessage(chatId, `❌ Не вдалося змінити статус запиту #${id}.`, { reply_markup: MAIN_KB });
      return;
    }

    await bot.sendMessage(chatId, `✅ Запит #${id} — відповіли.`, { reply_markup: MAIN_KB });
    return;
  }
});

bot.on('polling_error', e => console.error('[poll]', e.message));
bot.on('error', e => console.error('[bot]', e.message));

/* ── Tiny web server for Render ────────────────────────────── */
const express = require('express');
const webApp = express();

webApp.get('/', (_req, res) => {
  res.send('Bot is running');
});

const PORT = process.env.PORT || 3000;
webApp.listen(PORT, () => {
  console.log('Server running on port', PORT);
});