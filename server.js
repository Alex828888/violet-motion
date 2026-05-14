/**
 * VIOLET MOTION — SERVER v2
 * node server.js
 *
 * .env: PORT, TG_TOKEN, TG_CHAT_ID, API_KEY, DATA_DIR, GEMINI_API_KEY, GEMINI_MODEL,
 *       SUPPORT_AI_ENABLED, ZVONOK_API_KEY, ZVONOK_CAMPAIGN_ID, ZVONOK_WEBHOOK_SECRET
 *
 * New in v2:
 *  • POST /api/analytics  — receive batched client events
 *  • GET  /api/analytics/summary — aggregated stats (authBot)
 *  • SSE pending-message queue — client never loses operator replies
 */

require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const novaPoshta = require('./nova-poshta');

const app        = express();
const PORT       = process.env.PORT       || 3000;
const TG_TOKEN   = process.env.TG_TOKEN   || process.env.BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_EXTRA_ADMIN_IDS = '7996143460';
const TG_ADMIN_IDS = [process.env.ADMIN_IDS, TG_EXTRA_ADMIN_IDS].filter(Boolean).join(',');
const API_KEY    = process.env.API_KEY    || 'violet-secret';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SUPPORT_AI_ENABLED = process.env.SUPPORT_AI_ENABLED !== 'false';
const SUPPORT_AI_MAX_PER_SESSION = Math.max(1, Number(process.env.SUPPORT_AI_MAX_PER_SESSION || 8));
const ZVONOK_API_KEY = process.env.ZVONOK_API_KEY || '';
const ZVONOK_CAMPAIGN_ID = process.env.ZVONOK_CAMPAIGN_ID || '';
const ZVONOK_WEBHOOK_SECRET = process.env.ZVONOK_WEBHOOK_SECRET || '';
const ZVONOK_CALL_URL = 'https://zvonok.com/manager/cabapi_external/api/v1/phones/call/';
const SHOP_NAME = process.env.SHOP_NAME || 'Violet Motion';
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Violet Motion sneakers';
const PRODUCT_DESCRIPTION = process.env.PRODUCT_DESCRIPTION || 'women\'s sneakers, soft violet edition, white / light-violet style';
const PRODUCT_UPPER = process.env.PRODUCT_UPPER || 'eco-leather plus breathable mesh';
const PRODUCT_SOLE = process.env.PRODUCT_SOLE || 'light, cushioned, comfortable for walking';
const PRODUCT_BEST_FOR = process.env.PRODUCT_BEST_FOR || 'daily wear, city walks, travel, spring, summer, and warm autumn';
const PRODUCT_PRICE = process.env.PRODUCT_PRICE || '895';
const PRODUCT_OLD_PRICE = process.env.PRODUCT_OLD_PRICE || '1899';

app.set('trust proxy', 1);

/* ── Data files ────────────────────────────────────────────── */
const ROOT = __dirname;
const PUBLIC_ROOT = path.resolve(ROOT, process.env.LANDING_DIR || '.');
const DEFAULT_DATA = path.join(ROOT, 'data');
const DATA = path.resolve(process.env.DATA_DIR || DEFAULT_DATA);
const F = {
  orders:    path.join(DATA, 'orders.json'),
  reviews:   path.join(DATA, 'reviews.json'),
  support:   path.join(DATA, 'support.json'),
  analytics: path.join(DATA, 'analytics.json'),
  finance:   path.join(DATA, 'finance.json'),
  orderNotify: path.join(DATA, 'order-notify.json'),
};

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
for (const [name, file] of Object.entries(F)) {
  if (fs.existsSync(file)) continue;
  const bundledFile = path.join(DEFAULT_DATA, `${name}.json`);
  if (DATA !== DEFAULT_DATA && fs.existsSync(bundledFile)) {
    fs.copyFileSync(bundledFile, file);
  } else {
    fs.writeFileSync(file, '[]', 'utf8');
  }
}
console.log(`💾 Data directory: ${DATA}`);

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function write(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function nextId(arr) {
  return arr.length ? Math.max(...arr.map(x => x.id || 0)) + 1 : 1;
}
function mergeLegacyFileIfDataEmpty(key) {
  const current = read(F[key]);
  const legacyFile = path.join(ROOT, `${key}.json`);
  if (current.length || !fs.existsSync(legacyFile)) return;
  const legacy = read(legacyFile);
  if (!Array.isArray(legacy) || !legacy.length) return;
  write(F[key], legacy);
  console.log(`[data] migrated ${legacy.length} legacy ${key} records into ${F[key]}`);
}
['orders', 'reviews', 'support'].forEach(mergeLegacyFileIfDataEmpty);

/* ── Rate limiter ──────────────────────────────────────────── */
const rateLimits = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key  = req.ip || 'unknown';
    const now  = Date.now();
    const data = rateLimits.get(key) || { count: 0, start: now };
    if (now - data.start > windowMs) { data.count = 0; data.start = now; }
    data.count++;
    rateLimits.set(key, data);
    if (data.count > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits.entries())
    if (now - v.start > 10 * 60 * 1000) rateLimits.delete(k);
}, 10 * 60 * 1000);

/* ── Telegram ──────────────────────────────────────────────── */
async function tg(text, extra = {}) {
  if (!TG_TOKEN) return null;
  const chatIds = [...new Set((TG_CHAT_ID || TG_ADMIN_IDS)
    .split(/[,\s;]+/)
    .map(x => x.trim())
    .filter(Boolean))];
  if (!chatIds.length) return null;
  const results = await Promise.all(chatIds.map(chatId => tgTo(chatId, text, extra)));
  if (results.length === 1) return results[0];
  return { ok: results.some(r => r?.ok), result: results };
}

async function tgTo(chatId, text, extra = {}) {
  if (!TG_TOKEN || !chatId) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
    });
    return await r.json();
  } catch (e) { console.error('[TG]', e.message); return null; }
}

async function tgEdit(chatId, messageId, text, extra = {}) {
  if (!TG_TOKEN || !chatId || !messageId) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra }),
    });
    return await r.json();
  } catch (e) { console.error('[TG edit]', e.message); return null; }
}

/* ══════════════════════════════════════════════════════════════
   SSE SESSIONS + PENDING MESSAGE QUEUE
   Fix: When operator replies but client SSE is disconnected,
   messages are queued. On reconnect they're flushed immediately.
══════════════════════════════════════════════════════════════ */
const sessions        = {};  // sessionId → { res, accepted, managerId }
const pendingMessages = {};  // sessionId → [event objects]
const MAX_QUEUE       = 50;

function getSession(id) {
  if (!sessions[id]) sessions[id] = { res: null, accepted: false, managerId: null };
  return sessions[id];
}

/** Write to SSE stream. If disconnected, queue the message. */
function sseWrite(sessionId, data) {
  const s = sessions[sessionId];
  if (s?.res) {
    try {
      s.res.write(`data: ${JSON.stringify(data)}\n\n`);
      return;
    } catch {}
  }
  // Connection not available — queue
  if (!pendingMessages[sessionId]) pendingMessages[sessionId] = [];
  pendingMessages[sessionId].push(data);
  if (pendingMessages[sessionId].length > MAX_QUEUE)
    pendingMessages[sessionId].shift();
}

/** Flush queued messages to a newly connected SSE client. */
function flushQueue(sessionId) {
  const msgs = pendingMessages[sessionId];
  if (!msgs || !msgs.length) return;
  const s = sessions[sessionId];
  if (!s?.res) return;
  msgs.forEach(data => {
    try { s.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  });
  pendingMessages[sessionId] = [];
}

/* ── Middleware ────────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ── Static files ──────────────────────────────────────────── */
app.get('/style.css',  (_req, res) => { res.type('text/css'); res.sendFile(path.join(PUBLIC_ROOT, 'style.css')); });
app.get('/script.js',  (_req, res) => { res.type('application/javascript'); res.sendFile(path.join(PUBLIC_ROOT, 'script.js')); });
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(PUBLIC_ROOT, {
  extensions: false, fallthrough: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.css')  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (ext === '.js')   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (ext === '.json') res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (ext === '.html') res.setHeader('Content-Type', 'text/html; charset=utf-8');
  },
}));

/* ── Auth ──────────────────────────────────────────────────── */
function authBot(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function sanitizeStr(val, max = 200) { return String(val || '').trim().slice(0, max); }
function asMoneyNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(String(val).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function orderPaymentStatus(o) {
  return o?.paymentStatus || (o?.status === 'paid' || o?.status === 'completed' ? 'paid' : o?.status === 'returned' ? 'returned' : 'unpaid');
}
function orderExpensesTotal(o) {
  const list = Array.isArray(o?.expenses) ? o.expenses : [];
  return list.reduce((sum, e) => sum + asMoneyNumber(e.amount), 0) + asMoneyNumber(o?.extraExpenses || o?.expense || o?.returnExpense);
}
function orderUpsell(o) {
  return o?.upsell && typeof o.upsell === 'object' ? o.upsell : null;
}
function orderPaidNet(o) {
  const basePaid = o?.baseIncomePosted || o?.basePaidAt || orderPaymentStatus(o) === 'paid' || o?.status === 'paid' || o?.status === 'completed';
  const upsell = orderUpsell(o);
  const upsellPaid = upsell && (upsell.incomePosted || upsell.paidAt || upsell.paymentStatus === 'paid');
  let total = 0;
  if (basePaid) total += asMoneyNumber(o?.price) - asMoneyNumber(o?.cost || o?.costPrice || o?.purchasePrice);
  if (upsellPaid) total += asMoneyNumber(upsell.price) - asMoneyNumber(upsell.cost);
  return total;
}
function orderProfit(o) {
  return orderPaidNet(o) - orderExpensesTotal(o);
}
function periodStart(period) {
  const now = new Date();
  if (period === 'all') return null;
  if (period === 'week') {
    const d = new Date(now);
    d.setDate(now.getDate() - 6);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
function inPeriod(iso, period) {
  const start = periodStart(period);
  if (!start) return true;
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) && t >= start.getTime();
}
function buildCrmSummary(period = 'today') {
  const orders = read(F.orders).filter(o => inPeriod(o.createdAt, period));
  const finance = read(F.finance).filter(x => inPeriod(x.createdAt, period));
  const income = finance.filter(x => x.type === 'income').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const expense = finance.filter(x => x.type === 'expense').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const adsExpense = finance.filter(x => x.type === 'expense' && x.category === 'ads').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const paidOrders = orders.filter(o => orderPaymentStatus(o) === 'paid' || o.status === 'paid' || o.status === 'completed');
  const returns = orders.filter(o => orderPaymentStatus(o) === 'returned' || o.status === 'returned');
  const confirmedOrders = orders.filter(o => o.status === 'confirmed' || o.status === 'shipped' || o.status === 'paid' || o.status === 'completed');
  const expectedIncome = orders.reduce((s, o) => s + orderPaidNet(o), 0);
  const returnsExpense = finance.filter(x => x.type === 'expense' && x.category === 'return').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  return {
    period,
    orders: orders.length,
    newOrders: orders.filter(o => o.status === 'new').length,
    confirmedOrders: confirmedOrders.length,
    shippedOrders: orders.filter(o => o.status === 'shipped').length,
    paidOrders: paidOrders.length,
    returns: returns.length,
    withoutTtn: orders.filter(o => !o.ttn).length,
    unpaid: orders.filter(o => orderPaymentStatus(o) !== 'paid').length,
    income,
    expense,
    adsExpense,
    profit: income - expense,
    expectedIncome,
    returnsExpense,
    difference: income - expectedIncome,
    avgCheck: paidOrders.length ? expectedIncome / paidOrders.length : 0,
    avgProfit: paidOrders.length ? paidOrders.reduce((s, o) => s + orderProfit(o), 0) / paidOrders.length : 0,
    leadCost: orders.length ? adsExpense / orders.length : 0,
    confirmedOrderCost: confirmedOrders.length ? adsExpense / confirmedOrders.length : 0,
    paidOrderCost: paidOrders.length ? adsExpense / paidOrders.length : 0,
  };
}

function financeExternalId(source, category, orderId, extra = '') {
  return [source, category, orderId || 'none', extra || 'once'].join(':');
}
function addFinanceEntryOnce(entry) {
  const finance = read(F.finance);
  const externalId = entry.externalId || financeExternalId(entry.source || 'system', entry.category || 'manual', entry.orderId, entry.kind);
  const existing = finance.find(x => x.externalId === externalId);
  if (existing) return existing;
  const item = {
    id: nextId(finance),
    type: entry.type,
    title: sanitizeStr(entry.title || (entry.type === 'income' ? 'Income' : 'Expense'), 180),
    amount: asMoneyNumber(entry.amount),
    category: sanitizeStr(entry.category || 'manual', 60),
    source: sanitizeStr(entry.source || 'system', 60),
    orderId: entry.orderId ? Number(entry.orderId) : null,
    externalId,
    createdAt: entry.createdAt || new Date().toISOString(),
  };
  finance.push(item);
  write(F.finance, finance);
  return item;
}
function npErrorPayload(error) {
  const details = error?.details || {};
  return {
    error: error?.message || 'Nova Poshta request failed',
    details,
    missing: details.missing || [],
  };
}
function isOrderActiveForNpSync(order) {
  const status = order?.status || 'new';
  return !!order?.ttn && !['cancelled', 'returned', 'completed'].includes(status);
}
function novaIncomeAmount(order) {
  return Math.max(0, asMoneyNumber(order?.price) - asMoneyNumber(order?.cost || order?.costPrice || order?.purchasePrice));
}
function applyNovaTrackingToOrder(order, track) {
  const now = new Date().toISOString();
  const patch = {
    deliveryStatus: track.normalizedStatus,
    npStatus: track.status || null,
    npStatusCode: track.statusCode || null,
    npSyncedAt: now,
    novaPoshta: {
      ...(order.novaPoshta && typeof order.novaPoshta === 'object' ? order.novaPoshta : {}),
      tracking: track,
      syncedAt: now,
    },
  };

  if (track.normalizedStatus === 'delivered') {
    patch.paymentStatus = 'paid';
    patch.status = ['completed', 'paid'].includes(order.status) ? order.status : 'paid';
    patch.paidAt = order.paidAt || now;
    if (!order.baseIncomePosted) {
      const amount = novaIncomeAmount(order);
      if (amount > 0) {
        addFinanceEntryOnce({
          type: 'income',
          title: `Nova Poshta payment #${order.id}`,
          amount,
          category: 'net_order',
          source: 'nova-poshta',
          orderId: order.id,
          externalId: financeExternalId('nova-poshta', 'payment', order.id, track.number || order.ttn),
        });
      }
      patch.baseIncomePosted = true;
      patch.basePaidAt = now;
    }
  }

  if (track.documentCost > 0) {
    addFinanceEntryOnce({
      type: 'expense',
      title: `Nova Poshta delivery #${order.id}`,
      amount: track.documentCost,
      category: 'shipping',
      source: 'nova-poshta',
      orderId: order.id,
      externalId: financeExternalId('nova-poshta', 'shipping', order.id, track.number || order.ttn),
    });
    patch.npDeliveryCost = order.npDeliveryCost || track.documentCost;
  }

  if (track.normalizedStatus === 'returned') {
    patch.paymentStatus = 'returned';
    patch.status = 'returned';
    patch.returnedAt = order.returnedAt || now;
  }

  return { ...order, ...patch, updatedAt: now };
}
async function syncOrderWithNovaPoshta(order) {
  if (!order?.ttn) throw new Error('Order has no TTN');
  const docs = [{ DocumentNumber: String(order.ttn), Phone: novaPoshta.normalizePhone(order.phone) }];
  const [track] = await novaPoshta.trackDocuments(docs);
  if (!track) throw new Error('Nova Poshta returned no tracking data');
  const updated = applyNovaTrackingToOrder(order, track);
  return { updated, track };
}
async function syncOpenNovaPoshtaOrders(limit = 100) {
  const orders = read(F.orders);
  let changed = 0;
  const errors = [];
  const candidates = orders.filter(isOrderActiveForNpSync).slice(0, limit);
  for (const order of candidates) {
    const idx = orders.findIndex(x => x.id === order.id);
    if (idx < 0) continue;
    try {
      const { updated } = await syncOrderWithNovaPoshta(orders[idx]);
      orders[idx] = updated;
      changed++;
    } catch (error) {
      errors.push({ orderId: order.id, ttn: order.ttn, error: error.message });
    }
  }
  if (changed) write(F.orders, orders);
  return { checked: candidates.length, changed, errors };
}

function escapeHtml(val) {
  return String(val || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function orderQueueNoticeText(latestOrder = null) {
  const orders = read(F.orders);
  const fresh = orders.filter(o => (o.status || 'new') === 'new');
  const latest = latestOrder || fresh[fresh.length - 1] || orders[orders.length - 1] || null;
  const now = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  let text = fresh.length
    ? `🆕 <b>Нові замовлення</b>\nВ черзі: <b>${fresh.length}</b>`
    : `✅ <b>Нових замовлень немає</b>\nВ черзі: <b>0</b>`;

  if (latest) {
    text +=
      `\n\nОстаннє: <b>#${escapeHtml(latest.id)}</b> ${escapeHtml(latest.name || '—')}` +
      `\n📱 ${escapeHtml(latest.phone || '—')}` +
      `\n👟 ${escapeHtml(latest.size || '—')}` +
      (latest.product ? ` · ${escapeHtml(latest.product)}` : '') +
      (latest.price ? `\n💵 ${escapeHtml(latest.price)} грн` : '');
  }

  text += `\n\nОновлено: <code>${escapeHtml(now)}</code>`;
  return text;
}

async function updateOrderQueueNotice(latestOrder = null) {
  if (!TG_TOKEN || !TG_CHAT_ID) return null;
  const state = read(F.orderNotify);
  const messageId = state && !Array.isArray(state) ? state.messageId : null;
  const latestId = latestOrder?.id || null;
  const keyboard = { reply_markup: { inline_keyboard: [
    ...(latestId ? [[{ text: `Відкрити #${latestId}`, callback_data: `od_${latestId}` }]] : []),
    [{ text: '📦 Всі замовлення', callback_data: 'orders' }],
  ] } };
  const text = orderQueueNoticeText(latestOrder);

  if (messageId) {
    const edited = await tgEdit(TG_CHAT_ID, messageId, text, keyboard);
    if (edited?.ok) {
      write(F.orderNotify, { messageId, updatedAt: new Date().toISOString() });
      return edited;
    }
  }

  const sent = await tg(text, keyboard);
  if (sent?.ok && sent.result?.message_id) {
    write(F.orderNotify, { messageId: sent.result.message_id, updatedAt: new Date().toISOString() });
  }
  return sent;
}

const supportAiHistory = {};
const supportAiUsage = {};
const SUPPORT_SIZE_CHART = {
  36: '23 см',
  37: '23.5 см',
  38: '24 см',
  39: '24.5 см',
  40: '25 см',
};
const SUPPORT_AI_SYSTEM_PROMPT = `
You are the ${SHOP_NAME} store support assistant and first-line manager.
Answer customers in the same language they use: Ukrainian, Russian, or simple mixed UA/RU. Be warm, concise, and practical.

Store facts you may use:
- Product: ${PRODUCT_NAME}, ${PRODUCT_DESCRIPTION}.
- Upper: ${PRODUCT_UPPER}. Sole: ${PRODUCT_SOLE}.
- Best for: ${PRODUCT_BEST_FOR}.
- Sizes on site: 36, 37, 38, 39, 40.
- Insole length chart: 36 = 23 cm, 37 = 23.5 cm, 38 = 24 cm, 39 = 24.5 cm, 40 = 25 cm.
- Promo price: ${PRODUCT_PRICE} UAH. Old price: ${PRODUCT_OLD_PRICE} UAH.
- Payment: only after inspection/fitting on delivery, no prepayment.
- Delivery: Nova Poshta across Ukraine.
- Exchange: 14 days.
- Order flow: customer leaves name, phone, and size in the site form. They can choose Telegram contact without a call. A manager confirms details.
- Trust signals: 4.9 rating, 430+ orders this month.

Rules:
- Stay strictly on product, size, price, delivery, payment, exchange, order flow, and support for this site.
- Do not invent unavailable facts such as exact delivery price, exact stock per size, or guarantees not listed above.
- Do not ask for a human operator if you can answer from the facts.
- Request a human only when the customer explicitly asks for a person/operator/manager, complains about an existing order, asks to change/cancel an order, or sends unclear context after one short clarification would not be enough.
- For spam, random letters, insults, adult/sexual questions, tests, and unrelated topics, do not request a human. Use action "answer" and briefly say that you only help with ${PRODUCT_NAME}, sizes, price, delivery, payment, exchange, or ordering.
- If a customer asks for a fact not listed here, do not invent it. Use action "answer", say what is known, and offer to leave the question for a manager only if they want.
- Never collect full personal data in chat. Direct the customer to the order form for name, phone, and size.

Return only compact JSON:
{"action":"answer","reply":"..."} or {"action":"handoff","reply":"...","reason":"..."}
`;

function supportSessionKey(sessionId, fallbackId = null) {
  return String(sessionId || fallbackId || '').trim();
}

function findOpenSupportIndex(msgs, sessionId) {
  const key = supportSessionKey(sessionId);
  if (!key) return -1;
  let idx = msgs.findIndex(m => supportSessionKey(m.sessionId, m.id) === key && !m.answered);
  if (idx >= 0) return idx;
  const numeric = Number(key);
  return Number.isFinite(numeric) ? msgs.findIndex(m => m.id === numeric && !m.answered) : -1;
}

function updateSupportRecord(sessionId, patch) {
  const msgs = read(F.support);
  const idx = findOpenSupportIndex(msgs, sessionId);
  if (idx < 0) return null;
  msgs[idx] = { ...msgs[idx], ...patch, id: msgs[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, msgs);
  return msgs[idx];
}

function isLikelyLowValueSupportMessage(text) {
  const compact = String(text || '').trim();
  const letters = compact.replace(/[^a-zа-яіїєґё0-9]/gi, '');
  if (compact.length < 2) return true;
  if (letters.length < 2) return true;
  if (/^(.)\1{3,}$/i.test(letters)) return true;
  if (/^(test|тест|asdf|qwerty|йцукен|fdfd|dfdf|fgfg|fggf|хз|xs)$/i.test(letters)) return true;
  const vowels = (letters.match(/[aeiouyаеёиоуыэюяіїє]/gi) || []).length;
  return letters.length >= 5 && vowels === 0;
}

function wantsHumanOperator(text) {
  return /(оператор|менеджер|людин|человек|жив[а-яіїєґ]*|human|operator|manager|support|позвон|подзвон|передзвон|звонок|дзвінок)/i.test(text);
}

function offTopicSupportReply(text) {
  const msg = String(text || '').toLowerCase();
  if (/(дроч|мастурб|секс|порн|хуй|хуя|пизд|піс[ья]|соси|еба|їба|fuck|sex|porn|dick|cock|pussy)/i.test(msg)) {
    return `Я допомагаю тільки з ${PRODUCT_NAME}: розмір, устілка, ціна, доставка, оплата або оформлення замовлення.`;
  }
  if (/(політик|крипт|казино|ставк|наркот|збро|оруж|домашк|реферат|анекдот|погода|курс валют)/i.test(msg)) {
    return `Я можу підказати тільки по ${PRODUCT_NAME}: розміри, устілка, ціна, доставка, оплата, обмін або замовлення.`;
  }
  return null;
}

function localSupportReply(text) {
  const msg = String(text || '').toLowerCase();
  const offTopic = offTopicSupportReply(msg);
  if (offTopic) return offTopic;

  const sizeMatch = msg.match(/\b(36|37|38|39|40)\b/);
  const asksInsole = /(устіл|устел|стельк|устил|сант|см|centimeter|centimetre|cm)/i.test(msg);
  const asksSize = /(розмір|размер|size|підійде|подойдет|нога|стоп)/i.test(msg);

  if ((asksInsole || asksSize) && sizeMatch && SUPPORT_SIZE_CHART[sizeMatch[1]]) {
    const size = sizeMatch[1];
    return `На ${size} розмір устілка орієнтовно ${SUPPORT_SIZE_CHART[size]}. Можна оформити замовлення без передоплати: на Новій Пошті оглянете, приміряєте і тоді оплатите.`;
  }

  if ((asksInsole || asksSize) && /(таблиц|сетка|сітка|устіл|стельк|сант|см|розмір|размер|size)/i.test(msg)) {
    return `Розмірна сітка по устілці: 36 — 23 см, 37 — 23.5 см, 38 — 24 см, 39 — 24.5 см, 40 — 25 см. Оплата тільки після огляду та примірки.`;
  }

  if (/(ціна|цена|скільки кошту|сколько сто|вартість|стоимость|price|грн|895)/i.test(msg)) {
    return `Зараз акційна ціна ${PRODUCT_NAME} — ${PRODUCT_PRICE} грн замість ${PRODUCT_OLD_PRICE} грн. Передоплати немає: оплата після огляду та примірки на Новій Пошті.`;
  }

  if (/(достав|нова пошта|новою поштою|посилк|відправ|отправ|delivery)/i.test(msg)) {
    return `Доставляємо Новою Поштою по Україні. Ви оглядаєте і приміряєте пару при отриманні, оплата тільки після цього.`;
  }

  if (/(оплат|передоплат|налож|наклад|після примір|после пример|при отрим|при получ)/i.test(msg)) {
    return `Передоплати немає. Оплата тільки після огляду та примірки при отриманні на Новій Пошті.`;
  }

  if (/(обмін|обмен|поверн|возврат|14)/i.test(msg)) {
    return `Обмін доступний протягом 14 днів. Якщо розмір не підійде, менеджер допоможе з обміном.`;
  }

  if (/(замов|заказ|оформ|купить|купити|хочу|беру)/i.test(msg)) {
    return `Щоб оформити замовлення, оберіть розмір на сайті й залиште ім'я та телефон у формі. Менеджер підтвердить деталі. Можна обрати зв'язок через Telegram без дзвінка.`;
  }

  if (/(матеріал|материал|якість|качество|верх|підош|подош|колір|цвет|крос|сандал)/i.test(msg)) {
    return `${PRODUCT_NAME}: ${PRODUCT_DESCRIPTION}. Верх: ${PRODUCT_UPPER}, підошва: ${PRODUCT_SOLE}.`;
  }

  return null;
}

function geminiEndpoint() {
  const model = GEMINI_MODEL.startsWith('models/') ? GEMINI_MODEL : `models/${GEMINI_MODEL}`;
  return `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
}

function parseGeminiJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function askSupportAi(sessionId, message) {
  if (!SUPPORT_AI_ENABLED || !GEMINI_API_KEY) return null;
  const key = supportSessionKey(sessionId, 'anonymous');
  supportAiUsage[key] = supportAiUsage[key] || 0;
  if (supportAiUsage[key] >= SUPPORT_AI_MAX_PER_SESSION) {
    return { action: 'handoff', reply: 'Передаю діалог менеджеру, щоб не ганяти вас по колу. Він підключиться й допоможе.', reason: 'ai_session_limit' };
  }

  const history = (supportAiHistory[key] || []).slice(-8);
  supportAiUsage[key]++;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(geminiEndpoint(), {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SUPPORT_AI_SYSTEM_PROMPT }] },
        contents: [
          ...history,
          { role: 'user', parts: [{ text: message }] },
        ],
        generationConfig: {
          temperature: 0.35,
          topP: 0.85,
          maxOutputTokens: 360,
          responseMimeType: 'application/json',
        },
      }),
    });
    const data = await r.json().catch(() => null);
    clearTimeout(timer);
    if (!r.ok) {
      console.error('[Gemini]', r.status, data?.error?.message || 'request failed');
      return null;
    }

    const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    const parsed = parseGeminiJson(raw);
    if (!parsed || !parsed.reply) return null;

    const action = parsed.action === 'handoff' ? 'handoff' : 'answer';
    const reply = sanitizeStr(parsed.reply, 900);
    if (!reply) return null;

    supportAiHistory[key] = [
      ...history,
      { role: 'user', parts: [{ text: message }] },
      { role: 'model', parts: [{ text: reply }] },
    ].slice(-10);

    return { action, reply, reason: sanitizeStr(parsed.reason || '', 120) };
  } catch (e) {
    clearTimeout(timer);
    console.error('[Gemini]', e.name === 'AbortError' ? 'timeout' : e.message);
    return null;
  }
}

async function notifySupportRequest(msg, mode = 'new') {
  const ts = new Date(msg.timestamp || msg.updatedAt || Date.now()).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const title = mode === 'handoff'
    ? '🤝 <b>ПОТРІБЕН МЕНЕДЖЕР</b>'
    : mode === 'dialog'
      ? `💬 <b>НОВЕ ПОВІДОМЛЕННЯ В ДІАЛОЗІ #${msg.id}</b>`
      : `🎧 <b>ПІДТРИМКА #${msg.id}</b>`;
  const text =
    `${title}\n━━━━━━━━━━━━━━\n` +
    `🆔 <code>${escapeHtml(msg.sessionId || msg.id)}</code>\n` +
    (msg.handoffReason ? `ℹ️ ${escapeHtml(msg.handoffReason)}\n` : '') +
    `💬 ${escapeHtml(msg.message)}\n📅 ${ts}`;

  const keyboard = mode === 'dialog' ? undefined : {
    reply_markup: { inline_keyboard: [[
      { text: '✋ Прийняти діалог', callback_data: `accept_${msg.sessionId || msg.id}` },
    ]] },
  };

  if (mode === 'dialog' && msg.managerId) {
    await tgTo(msg.managerId, text, keyboard || {});
    if (TG_CHAT_ID && String(TG_CHAT_ID) !== String(msg.managerId)) await tg(text);
    return;
  }
  await tg(text, keyboard || {});
}

function normalizePhoneForZvonok(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && digits.startsWith('0')) return `+38${digits}`;
  if (digits.length === 12 && digits.startsWith('380')) return `+${digits}`;
  if (raw.startsWith('+')) return `+${digits}`;
  return `+${digits}`;
}

function makeZvonokLabel(order) {
  const random = Math.random().toString(36).slice(2, 8);
  return `order_${order.id}_${Date.now()}_${random}`;
}

function samePhone(a, b) {
  const da = String(a || '').replace(/\D/g, '');
  const db = String(b || '').replace(/\D/g, '');
  return !!da && !!db && (da === db || da.endsWith(db) || db.endsWith(da));
}

function getRequestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function buildZvonokWebhookUrl(req, order, button) {
  const base = getRequestBaseUrl(req);
  if (!base) return '';
  const url = new URL('/api/zvonok/ivr', base);
  url.searchParams.set('orderId', order.id);
  url.searchParams.set('button', button);
  if (ZVONOK_WEBHOOK_SECRET) url.searchParams.set('secret', ZVONOK_WEBHOOK_SECRET);
  return url.toString();
}

async function startZvonokCall(order, req) {
  if (!ZVONOK_API_KEY || !ZVONOK_CAMPAIGN_ID) {
    console.warn('[Zvonok] skipped: ZVONOK_API_KEY or ZVONOK_CAMPAIGN_ID is not set');
    return null;
  }

  const phone = normalizePhoneForZvonok(order.phone);
  if (!phone) {
    console.warn(`[Zvonok] skipped order #${order.id}: invalid phone`);
    return null;
  }

  const form = new FormData();
  form.append('public_key', ZVONOK_API_KEY);
  form.append('campaign_id', ZVONOK_CAMPAIGN_ID);
  form.append('phone', phone);
  form.append('label', makeZvonokLabel(order));

  const btn1Webhook = buildZvonokWebhookUrl(req, order, 1);
  const btn2Webhook = buildZvonokWebhookUrl(req, order, 2);
  if (btn1Webhook) form.append('ivr_lvl_1_btn_1_webhook', btn1Webhook);
  if (btn2Webhook) form.append('ivr_lvl_1_btn_2_webhook', btn2Webhook);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const response = await fetch(ZVONOK_CALL_URL, { method: 'POST', body: form, signal: ctrl.signal });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    console.log(`[Zvonok] order #${order.id} call start: ${response.status}`, data);
    return { ok: response.ok, status: response.status, data };
  } catch (e) {
    console.error(`[Zvonok] order #${order.id} call start failed:`, e.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function findOrderIndexByZvonokPayload(orders, payload) {
  const rawOrderId = payload.orderId || payload.order_id || payload.order || payload.id || payload.client_id;
  let orderId = Number(rawOrderId);
  if (!orderId && payload.label) {
    const match = String(payload.label).match(/order[_-](\d+)/i);
    if (match) orderId = Number(match[1]);
  }
  if (orderId) {
    const byId = orders.findIndex(o => o.id === orderId);
    if (byId >= 0) return byId;
  }

  const phone = payload.phone || payload.Phone || payload.called_phone || payload.customer_phone;
  if (phone) return orders.findLastIndex(o => samePhone(o.phone, phone));
  return -1;
}

function getZvonokDigit(payload) {
  const value = payload.button || payload.digit || payload.button_num || payload.ivr_button || payload.key || payload.user_choice;
  const match = String(value || '').match(/[12]/);
  return match ? match[0] : '';
}

function getZvonokStatus(payload) {
  return String(payload.status || payload.call_status || payload.dial_status || payload.event || '').toLowerCase();
}

function formatOrderForZvonokMessage(order) {
  return (
    `Имя: ${escapeHtml(order?.name || '-')}\n` +
    `Телефон: ${escapeHtml(order?.phone || '-')}\n` +
    `Размер: ${escapeHtml(order?.size || '-')}\n` +
    (order?.fullName ? `ФИО: ${escapeHtml(order.fullName)}\n` : '') +
    (order?.city ? `Город: ${escapeHtml(order.city)}\n` : '') +
    (order?.district ? `Район: ${escapeHtml(order.district)}\n` : '') +
    (order?.postOffice ? `Новая Почта: ${escapeHtml(order.postOffice)}\n` : '') +
    `Order ID: ${escapeHtml(order?.id || '-')}`
  );
}

/* ═══════════════════════════════════════════════════════════
   ANALYTICS
═══════════════════════════════════════════════════════════ */

/** POST /api/analytics — receive batched events from client */
app.post('/api/analytics', rateLimit(60 * 1000, 30), (req, res) => {
  const { events, ua } = req.body;
  if (!Array.isArray(events) || !events.length)
    return res.status(400).json({ error: 'Invalid events' });

  const existing = read(F.analytics);
  const ip       = req.ip || 'unknown';
  const now      = new Date().toISOString();

  events.forEach(ev => {
    if (!ev.event || !ev.sessionId) return;
    existing.push({
      event:     String(ev.event).slice(0, 50),
      sessionId: String(ev.sessionId).slice(0, 60),
      timestamp: ev.timestamp || now,
      data:      ev.data || {},
      referrer:  String(ev.referrer || '').slice(0, 200),
      ua:        String(ua || '').slice(0, 200),
      ip,
    });
  });

  // Prune entries older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const pruned = existing.filter(e => (e.timestamp || '') >= cutoff);

  write(F.analytics, pruned);
  res.json({ success: true });
});

/** GET /api/analytics/summary?period=today|hour|week — aggregated (bot only) */
app.get('/api/analytics/summary', authBot, (req, res) => {
  const period  = req.query.period || 'today';
  const all     = read(F.analytics);
  const now     = Date.now();

  let cutoff;
  if      (period === 'hour')  cutoff = now - 3600 * 1000;
  else if (period === 'week')  cutoff = now - 7 * 24 * 3600 * 1000;
  else /* today */             cutoff = new Date().setHours(0, 0, 0, 0);

  const filtered = all.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  // Session stats — exclude likely-admin sessions (duration > 7200s)
  const sessionMap = {};
  filtered.forEach(ev => {
    if (!sessionMap[ev.sessionId]) sessionMap[ev.sessionId] = { events: [], ip: ev.ip };
    sessionMap[ev.sessionId].events.push(ev);
  });

  const ipCounts = {};
  filtered.forEach(ev => { ipCounts[ev.ip] = (ipCounts[ev.ip] || 0) + 1; });
  const hotIps = new Set(Object.entries(ipCounts).filter(([,c]) => c > 80).map(([ip]) => ip));

  const validSessions = Object.entries(sessionMap)
    .filter(([, s]) => !hotIps.has(s.ip))
    .map(([id, s]) => {
      const endEv = s.events.find(e => e.event === 'session_end');
      const dur   = endEv?.data?.duration || null;
      return { id, eventCount: s.events.length, duration: dur };
    });

  const durSamples  = validSessions.map(s => s.duration).filter(d => d !== null && d > 3 && d < 7200);
  const avgDuration = durSamples.length ? Math.round(durSamples.reduce((a, b) => a + b, 0) / durSamples.length) : 0;

  // Bounce = session with only 1–2 events
  const bounces   = validSessions.filter(s => s.eventCount <= 2).length;
  const bounceRate = validSessions.length ? +(bounces / validSessions.length).toFixed(2) : 0;

  // Scroll depth distribution
  const scrollDepth = { 25: 0, 50: 0, 75: 0, 90: 0, 100: 0 };
  filtered.filter(e => e.event === 'scroll_depth').forEach(e => {
    const d = e.data?.depth;
    if (scrollDepth[d] !== undefined) scrollDepth[d]++;
  });

  // Button clicks
  const buttonClicks = {};
  filtered.filter(e => e.event === 'button_click').forEach(e => {
    const label = e.data?.label || 'unknown';
    buttonClicks[label] = (buttonClicks[label] || 0) + 1;
  });
  const topButtons = Object.entries(buttonClicks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));

  // Form funnel
  const formStart  = filtered.filter(e => e.event === 'form_start').length;
  const formSubmit = filtered.filter(e => e.event === 'form_submit').length;
  const orderOk    = filtered.filter(e => e.event === 'order_success').length;

  // Active sessions in last hour
  const hourCutoff    = now - 3600 * 1000;
  const recentSessIds = new Set(all.filter(e => new Date(e.timestamp).getTime() >= hourCutoff).map(e => e.sessionId));
  const activeLastHr  = recentSessIds.size;

  // Last 10 actions
  const lastActions = [...filtered]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 10)
    .map(e => ({ event: e.event, timestamp: e.timestamp, data: e.data }));

  // Page views (unique sessions)
  const pvSessions = new Set(filtered.filter(e => e.event === 'page_view').map(e => e.sessionId));

  res.json({
    period,
    sessions: {
      total:       validSessions.length,
      unique:      pvSessions.size,
      avgDuration, // seconds
      bounceRate,
    },
    scrollDepth,
    topButtons,
    formFunnel: { started: formStart, submitted: formSubmit, succeeded: orderOk },
    activeLastHour: activeLastHr,
    lastActions,
  });
});

/** GET /api/analytics — raw dump (bot only) */
app.get('/api/analytics', authBot, (_req, res) => res.json(read(F.analytics)));

/* ═══════════════════════════════════════════════════════════
   ADMIN API (BOT)
═══════════════════════════════════════════════════════════ */
app.get('/api/admin/orders',       authBot, (_req, res) => res.json(read(F.orders)));
app.get('/api/admin/orders/:id',   authBot, (req, res) => {
  const order = read(F.orders).find(x => x.id === Number(req.params.id));
  order ? res.json(order) : res.status(404).json({ error: 'Not found' });
});
app.patch('/api/admin/orders/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.orders, arr);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) updateOrderQueueNotice(arr[idx]).catch(e => console.error('[order notice]', e.message));
  res.json(arr[idx]);
});

const npConfig = novaPoshta.configStatus();
if (npConfig.autoSync && npConfig.apiConfigured) {
  const intervalMs = Math.max(5, Number(process.env.NP_SYNC_INTERVAL_MINUTES || 30)) * 60 * 1000;
  setInterval(() => {
    syncOpenNovaPoshtaOrders(100)
      .then(result => {
        if (result.checked || result.errors.length) console.log('[NovaPoshta sync]', result);
      })
      .catch(error => console.error('[NovaPoshta sync]', error.message));
  }, intervalMs).unref();
} else if (!npConfig.apiConfigured) {
  console.warn('[NovaPoshta] NOVA_POSHTA_API_KEY is not set; tracking and TTN creation are disabled.');
}
app.delete('/api/admin/orders/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.orders, arr.filter(x => x.id !== id));
  updateOrderQueueNotice().catch(e => console.error('[order notice]', e.message));
  res.json({ success: true });
});
app.post('/api/admin/orders/:id/expense', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const amount = asMoneyNumber(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Invalid amount' });
  const expense = {
    id: nextId(Array.isArray(arr[idx].expenses) ? arr[idx].expenses : []),
    title: sanitizeStr(req.body?.title || 'Витрата по замовленню', 160),
    amount,
    category: sanitizeStr(req.body?.category || 'order', 40),
    createdAt: new Date().toISOString(),
  };
  arr[idx].expenses = [...(Array.isArray(arr[idx].expenses) ? arr[idx].expenses : []), expense];
  if (expense.category === 'return') arr[idx].returnExpense = amount;
  arr[idx].updatedAt = new Date().toISOString();
  write(F.orders, arr); res.json(arr[idx]);
});
app.post('/api/admin/orders/:id/comment', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx].managerComment = sanitizeStr(req.body?.comment, 1000);
  arr[idx].updatedAt = new Date().toISOString();
  write(F.orders, arr); res.json(arr[idx]);
});
app.get('/api/admin/finance', authBot, (_req, res) => res.json(read(F.finance)));
app.post('/api/admin/finance', authBot, (req, res) => {
  const arr = read(F.finance);
  const amount = asMoneyNumber(req.body?.amount);
  const type = sanitizeStr(req.body?.type, 20);
  if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Invalid amount' });
  const item = {
    id: nextId(arr),
    type,
    title: sanitizeStr(req.body?.title || (type === 'income' ? 'Дохід' : 'Витрата'), 180),
    amount,
    category: sanitizeStr(req.body?.category || 'manual', 60),
    source: sanitizeStr(req.body?.source || 'manual', 60),
    orderId: req.body?.orderId ? Number(req.body.orderId) : null,
    createdAt: req.body?.createdAt || new Date().toISOString(),
  };
  arr.push(item); write(F.finance, arr); res.json(item);
});
app.get('/api/admin/finance/summary', authBot, (req, res) => {
  res.json(buildCrmSummary(sanitizeStr(req.query.period || 'today', 20)));
});
app.get('/api/admin/crm/summary', authBot, (req, res) => {
  res.json(buildCrmSummary(sanitizeStr(req.query.period || 'today', 20)));
});
app.get('/api/admin/crm/problems', authBot, (_req, res) => {
  const orders = read(F.orders).map(o => {
    const problems = [];
    const hasReturnExpense = Object.prototype.hasOwnProperty.call(o, 'returnExpense') || (Array.isArray(o.expenses) && o.expenses.some(e => e.category === 'return'));
    if (o.status === 'confirmed') problems.push('Підтверджено, але не відправлено');
    if (o.status === 'shipped' && !o.ttn) problems.push('Відправлено, але немає ТТН');
    if (o.status === 'shipped' && orderPaymentStatus(o) !== 'paid') problems.push('Відправлено, але не оплачено');
    if ((o.status === 'paid' || orderPaymentStatus(o) === 'paid') && !asMoneyNumber(o.price)) problems.push('Оплачено, але немає ціни');
    if ((o.status === 'returned' || orderPaymentStatus(o) === 'returned') && !hasReturnExpense) problems.push('Повернення без витрати');
    if (o.status === 'completed' && orderProfit(o) <= 0) problems.push('Завершено, але прибуток <= 0');
    return { ...o, problems };
  }).filter(o => o.problems.length);
  res.json({ orders });
});
app.get('/api/admin/np/config', authBot, (_req, res) => {
  res.json(novaPoshta.configStatus());
});
app.get('/api/admin/np/track/:ttn', authBot, async (req, res) => {
  try {
    const [track] = await novaPoshta.trackDocuments([{ DocumentNumber: sanitizeStr(req.params.ttn, 40) }]);
    if (!track) return res.status(404).json({ error: 'TTN not found' });
    res.json(track);
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
});
app.post('/api/admin/orders/:id/np/create', authBot, async (req, res) => {
  const id = Number(req.params.id);
  const orders = read(F.orders);
  const idx = orders.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const order = { ...orders[idx], ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  if (orders[idx].ttn && !req.body?.force) return res.json({ success: true, duplicate: true, order: orders[idx], ttn: orders[idx].ttn });
  try {
    const created = await novaPoshta.createInternetDocument(order);
    const now = new Date().toISOString();
    orders[idx] = {
      ...orders[idx],
      ...order,
      ttn: created.ttn,
      npRef: created.ref,
      npEstimatedDeliveryDate: created.estimatedDeliveryDate,
      npDeliveryCost: created.cost || orders[idx].npDeliveryCost || null,
      deliveryStatus: 'shipped',
      status: ['paid', 'completed'].includes(orders[idx].status) ? orders[idx].status : 'shipped',
      novaPoshta: {
        ...(orders[idx].novaPoshta && typeof orders[idx].novaPoshta === 'object' ? orders[idx].novaPoshta : {}),
        ref: created.ref,
        ttn: created.ttn,
        city: created.city,
        warehouse: created.warehouse,
        recipient: {
          ref: created.recipient.ref,
          contactRef: created.recipient.contactRef,
          description: created.recipient.description,
          phone: created.recipient.phone,
        },
        estimatedDeliveryDate: created.estimatedDeliveryDate,
        raw: created.raw,
      },
      ttnCreatedAt: now,
      updatedAt: now,
    };
    write(F.orders, orders);
    if (created.cost > 0) {
      addFinanceEntryOnce({
        type: 'expense',
        title: `Nova Poshta delivery #${id}`,
        amount: created.cost,
        category: 'shipping',
        source: 'nova-poshta',
        orderId: id,
        externalId: financeExternalId('nova-poshta', 'shipping', id, created.ttn),
      });
    }
    updateOrderQueueNotice(orders[idx]).catch(e => console.error('[order notice]', e.message));
    res.json({ success: true, order: orders[idx], novaPoshta: created, ttn: created.ttn });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
});
app.post('/api/admin/orders/:id/np/sync', authBot, async (req, res) => {
  const id = Number(req.params.id);
  const orders = read(F.orders);
  const idx = orders.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (!orders[idx].ttn) return res.status(400).json({ error: 'Order has no TTN' });
  try {
    const { updated, track } = await syncOrderWithNovaPoshta(orders[idx]);
    orders[idx] = updated;
    write(F.orders, orders);
    updateOrderQueueNotice(orders[idx]).catch(e => console.error('[order notice]', e.message));
    res.json({ success: true, order: orders[idx], track });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
});
app.post('/api/admin/np/sync', authBot, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.body?.limit || 100)));
    res.json({ success: true, ...(await syncOpenNovaPoshtaOrders(limit)) });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
});
app.get('/api/admin/reviews',       authBot, (_req, res) => res.json(read(F.reviews)));
app.delete('/api/admin/reviews/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.reviews);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.reviews, arr.filter(x => x.id !== id)); res.json({ success: true });
});
app.get('/api/admin/support',       authBot, (_req, res) => res.json(read(F.support)));
app.patch('/api/admin/support/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.support);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, arr); res.json(arr[idx]);
});
app.get('/api/admin/backup', authBot, (_req, res) => {
  res.json({
    exportedAt: new Date().toISOString(),
    dataDir: DATA,
    orders: read(F.orders),
    reviews: read(F.reviews),
    support: read(F.support),
    analytics: read(F.analytics),
    finance: read(F.finance),
  });
});
app.post('/api/admin/backup/restore', authBot, (req, res) => {
  const { orders, reviews, support, analytics, finance } = req.body || {};
  const restored = {};
  if (Array.isArray(orders)) {
    write(F.orders, orders);
    restored.orders = orders.length;
  }
  if (Array.isArray(reviews)) {
    write(F.reviews, reviews);
    restored.reviews = reviews.length;
  }
  if (Array.isArray(support)) {
    write(F.support, support);
    restored.support = support.length;
  }
  if (Array.isArray(analytics)) {
    write(F.analytics, analytics);
    restored.analytics = analytics.length;
  }
  if (Array.isArray(finance)) {
    write(F.finance, finance);
    restored.finance = finance.length;
  }
  res.json({ success: true, restored });
});

/* ── SSE endpoint ──────────────────────────────────────────── */
app.get('/api/support/stream', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Tell client to retry after 3.5s on disconnect
  res.write('retry: 3500\n\n');
  res.flushHeaders();

  const sess = getSession(sessionId);
  sess.res   = res;

  // Immediately flush any messages that arrived while disconnected
  flushQueue(sessionId);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    if (sessions[sessionId]) sessions[sessionId].res = null;
  });
});

/* ── Bot relay ─────────────────────────────────────────────── */
app.post('/api/support/relay', authBot, (req, res) => {
  const { sessionId, text, managerName } = req.body;
  if (!sessionId || !text) return res.status(400).json({ error: 'Missing fields' });
  sseWrite(sessionId, { type: 'message', text, managerName: managerName || 'Оператор' });
  res.json({ success: true });
});

app.post('/api/support/accept', authBot, (req, res) => {
  const { sessionId, managerId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  const support = updateSupportRecord(sessionId, {
    accepted: true,
    answered: false,
    managerId: managerId || null,
    acceptedAt: new Date().toISOString(),
  });
  const realSessionId = supportSessionKey(support?.sessionId, sessionId);
  const sess = getSession(realSessionId);
  sess.accepted  = true;
  sess.managerId = managerId;
  sseWrite(realSessionId, { type: 'accepted' });
  res.json({ success: true, id: support?.id || null, sessionId: realSessionId });
});

app.post('/api/support/end', authBot, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  const msgs = read(F.support);
  const idx  = findOpenSupportIndex(msgs, sessionId);
  const realSessionId = supportSessionKey(msgs[idx]?.sessionId, sessionId);
  sseWrite(realSessionId, { type: 'end' });
  if (idx >= 0) {
    msgs[idx].answered = true;
    msgs[idx].endedAt  = new Date().toISOString();
    write(F.support, msgs);
  }
  res.json({ success: true });
});

app.get('/api/support/sessions', authBot, (_req, res) => {
  const active = Object.entries(sessions).map(([id, s]) => ({
    sessionId: id, accepted: s.accepted, managerId: s.managerId, connected: !!s.res,
    pending: (pendingMessages[id] || []).length,
  }));
  res.json(active);
});

/* ═══════════════════════════════════════════════════════════
   ORDERS (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/order', rateLimit(60 * 1000, 5), async (req, res) => {
  const {
    name, phone, size, color, product, price, contactViaTelegram,
    orderMode, fullName, city, district, postOffice, delivery,
    replaceOrderId, clientOrderKey,
  } = req.body;
  if (!name || !phone || !size) return res.status(400).json({ error: 'Missing fields' });

  const cleanName  = sanitizeStr(name, 100);
  const cleanPhone = sanitizeStr(phone, 20);
  const cleanSize  = sanitizeStr(size, 10);
  const cleanColor = sanitizeStr(color, 40);
  const cleanProduct = sanitizeStr(product, 100);
  const cleanPrice = sanitizeStr(price, 20);
  const cleanClientOrderKey = sanitizeStr(clientOrderKey, 80);
  const cleanOrderMode = sanitizeStr(orderMode, 20) === 'instant' ? 'instant' : 'manual';
  const deliveryData = delivery && typeof delivery === 'object' ? delivery : {};
  const cleanFullName = sanitizeStr(fullName || deliveryData.fullName || deliveryData.name, 140);
  const cleanCity = sanitizeStr(city || deliveryData.city, 80);
  const cleanDistrict = sanitizeStr(district || deliveryData.district || deliveryData.area, 80);
  const cleanPostOffice = sanitizeStr(postOffice || deliveryData.postOffice || deliveryData.novaPoshta || deliveryData.branch, 80);
  if (!cleanName || !cleanPhone || !cleanSize)
    return res.status(400).json({ error: 'Invalid fields' });
  if (cleanOrderMode === 'instant' && (!cleanFullName || !cleanCity || !cleanPostOffice))
    return res.status(400).json({ error: 'Missing delivery fields' });

  const orders = read(F.orders);
  if (cleanOrderMode === 'manual' && cleanClientOrderKey) {
    const existing = orders.find(x => x.clientOrderKey === cleanClientOrderKey);
    if (existing) return res.json({ success: true, id: existing.id, duplicate: true });
  }
  let activeOrders = orders;
  let replacedOrderId = null;
  const replaceId = Number(replaceOrderId || 0);
  if (cleanOrderMode === 'instant' && replaceId) {
    const replaceIdx = orders.findIndex(x => (
      x.id === replaceId &&
      (x.status || 'new') === 'new' &&
      (x.orderMode || 'manual') === 'manual' &&
      String(x.phone || '').replace(/\D/g, '') === cleanPhone.replace(/\D/g, '')
    ));
    if (replaceIdx >= 0) {
      replacedOrderId = orders[replaceIdx].id;
      activeOrders = orders.filter(x => x.id !== replacedOrderId);
    }
  }
  const o = {
    id: nextId(orders), name: cleanName, phone: cleanPhone, size: cleanSize,
    color: cleanColor || null, product: cleanProduct || null, price: cleanPrice || null,
    clientOrderKey: cleanClientOrderKey || null,
    orderMode: cleanOrderMode,
    replacedOrderId,
    fullName: cleanFullName || null,
    city: cleanCity || null,
    district: cleanDistrict || null,
    postOffice: cleanPostOffice || null,
    contactViaTelegram: !!contactViaTelegram, status: 'new', createdAt: new Date().toISOString(),
  };
  activeOrders.push(o); write(F.orders, activeOrders);
  await updateOrderQueueNotice(o);

  const ts = new Date(o.createdAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const isInstant = o.orderMode === 'instant';
  await tg(
    `🛒 <b>${isInstant ? 'ПОВНЕ ЗАМОВЛЕННЯ' : 'НОВА ЗАЯВКА'} #${o.id}</b>\n━━━━━━━━━━━━━━━━━━\n` +
    (o.product ? `🛍 Товар: <b>${o.product}</b>\n` : '') +
    `👤 Ім'я: <b>${o.name}</b>\n📱 Телефон: <b>${o.phone}</b>\n` +
    `👟 Розмір: <b>${o.size}</b>\n` +
    (o.fullName ? `🧾 Ім'я та прізвище: <b>${o.fullName}</b>\n` : '') +
    (o.city ? `🏙 Місто: <b>${o.city}</b>\n` : '') +
    (o.district ? `📍 Район: <b>${o.district}</b>\n` : '') +
    (o.postOffice ? `📦 Відділення Нової Пошти: <b>${o.postOffice}</b>\n` : '') +
    (o.color ? `🎨 Колір: <b>${o.color}</b>\n` : '') +
    (o.price ? `💵 Ціна: <b>${o.price} грн</b>\n` : '') +
    (o.contactViaTelegram ? `💬 Зв'язок: <b>Telegram</b>\n` : `📞 Зв'язок: <b>Дзвінок</b>\n`) +
    (isInstant
      ? `✅ Тип: <b>оформлено одразу</b>\n🤖 ZVONOK: <b>запускаємо автоматичне підтвердження</b>\n`
      : `👩‍💼 Обробка: <b>передзвонить менеджер, без ZVONOK</b>\n`) +
    (replacedOrderId ? `🔁 Попередню заявку #${replacedOrderId} видалено\n` : '') +
    `📅 ${ts}\n━━━━━━━━━━━━━━━━━━`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Підтвердити', callback_data: `confirm_${o.id}` },
      { text: '❌ Скасувати',  callback_data: `cancel_${o.id}` },
    ], [
      { text: '🗑 Видалити', callback_data: `del_order_${o.id}` },
    ]] } }
  );
  if (isInstant) {
    try { await startZvonokCall(o, req); }
    catch (e) { console.error(`[Zvonok] unexpected order #${o.id} error:`, e.message); }
  }

  res.json({ success: true, id: o.id });
});

app.get('/api/orders',        (_req, res) => res.json(read(F.orders)));
app.get('/api/orders/:id',    (req, res) => {
  const o = read(F.orders).find(x => x.id === +req.params.id);
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
});
app.patch('/api/orders/:id',  (req, res) => {
  const arr = read(F.orders); const idx = arr.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.orders, arr);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) updateOrderQueueNotice(arr[idx]).catch(e => console.error('[order notice]', e.message));
  res.json(arr[idx]);
});
app.delete('/api/orders/:id', (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.orders, arr.filter(x => x.id !== id));
  updateOrderQueueNotice().catch(e => console.error('[order notice]', e.message));
  res.json({ success: true });
});

app.all('/api/zvonok/ivr', async (req, res) => {
  const payload = { ...req.query, ...req.body };

  if (ZVONOK_WEBHOOK_SECRET) {
    const secret = payload.secret || req.headers['x-zvonok-secret'];
    if (secret !== ZVONOK_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }

  const orders = read(F.orders);
  const idx = findOrderIndexByZvonokPayload(orders, payload);
  if (idx < 0) {
    console.warn('[Zvonok] webhook order not found:', payload);
    return res.status(404).json({ error: 'Order not found' });
  }

  const order = orders[idx];
  const digit = getZvonokDigit(payload);
  const status = getZvonokStatus(payload);
  const noAnswerStatuses = ['no_answer', 'noanswer', 'busy', 'failed', 'fail', 'error', 'unanswered', 'not_available'];

  let nextStatus = null;
  let message = null;

  if (digit === '1') {
    nextStatus = 'confirmed';
    message =
      `✅ Замовлення підтверджено автоматичним дзвінком\n` +
      formatOrderForZvonokMessage(order);
  } else if (digit === '2') {
    nextStatus = 'cancelled';
    message =
      `❌ Клієнт скасував замовлення через автоматичний дзвінок\n` +
      formatOrderForZvonokMessage(order);
  } else if (noAnswerStatuses.some(s => status.includes(s))) {
    nextStatus = 'no_answer';
    message =
      `📞 Клієнт не відповів на автоматичний дзвінок — потрібна ручна перевірка\n` +
      formatOrderForZvonokMessage(order);
  }

  if (!nextStatus) {
    console.log(`[Zvonok] webhook received for order #${order.id}:`, payload);
    return res.json({ success: true, ignored: true });
  }

  orders[idx] = {
    ...order,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
    zvonokStatus: status || null,
    zvonokButton: digit || null,
  };
  write(F.orders, orders);

  await tg(message);
  console.log(`[Zvonok] webhook order #${order.id}: ${nextStatus}`, payload);
  res.json({ success: true, orderId: order.id, status: nextStatus });
});

/* ═══════════════════════════════════════════════════════════
   REVIEWS (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/review', rateLimit(60 * 1000, 3), async (req, res) => {
  const { name, rating, text, date } = req.body;
  if (!name || !rating || !text) return res.status(400).json({ error: 'Missing fields' });
  const cleanName = sanitizeStr(name, 100);
  const cleanText = sanitizeStr(text, 1000);
  const ratingNum = Math.min(5, Math.max(1, Number(rating)));
  if (!cleanName || !cleanText || isNaN(ratingNum))
    return res.status(400).json({ error: 'Invalid fields' });

  const reviews = read(F.reviews);
  const rv = { id: nextId(reviews), name: cleanName, rating: ratingNum, text: cleanText,
    date: date || new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() };
  reviews.push(rv); write(F.reviews, reviews);

  const st = '★'.repeat(rv.rating) + '☆'.repeat(5 - rv.rating);
  await tg(
    `💬 <b>НОВИЙ ВІДГУК #${rv.id}</b>\n━━━━━━━━━━━━━━\n👤 <b>${rv.name}</b> ${st}\n<i>${rv.text}</i>`,
    { reply_markup: { inline_keyboard: [[{ text: '🗑 Видалити', callback_data: `del_review_${rv.id}` }]] } }
  );
  res.json({ success: true, id: rv.id });
});

app.get('/api/reviews',        (_req, res) => res.json(read(F.reviews)));
app.delete('/api/reviews/:id', (req, res) => {
  const id = Number(req.params.id); const arr = read(F.reviews);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.reviews, arr.filter(x => x.id !== id)); res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════
   SUPPORT (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/support', rateLimit(60 * 1000, 10), async (req, res) => {
  const { message, sessionId, timestamp } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  const cleanMsg = sanitizeStr(message, 2000);
  if (!cleanMsg) return res.status(400).json({ error: 'Empty message' });

  const msgs = read(F.support);
  const existingIdx = findOpenSupportIndex(msgs, sessionId);

  if (existingIdx >= 0) {
    msgs[existingIdx].message   = cleanMsg;
    msgs[existingIdx].timestamp = timestamp || new Date().toISOString();
    msgs[existingIdx].updatedAt = new Date().toISOString();
    write(F.support, msgs);
    const current = msgs[existingIdx];
    if (current.accepted) {
      await notifySupportRequest(current, 'dialog');
      return res.json({ success: true, id: current.id, repeated: true, human: true });
    }

    const needsHuman = wantsHumanOperator(cleanMsg);
    const ai = needsHuman ? null : await askSupportAi(sessionId, cleanMsg);
    if (ai?.action === 'answer') {
      msgs[existingIdx] = { ...current, answered: true, aiHandled: true, aiLastReply: ai.reply, updatedAt: new Date().toISOString() };
      write(F.support, msgs);
      return res.json({ success: true, id: current.id, repeated: true, aiReply: ai.reply, ai: true });
    }

    if (!needsHuman && !ai) {
      msgs[existingIdx] = { ...current, answered: false, aiError: true, updatedAt: new Date().toISOString() };
      write(F.support, msgs);
      return res.json({
        success: true,
        id: current.id,
        repeated: true,
        aiError: true,
        aiReply: 'Gemini зараз не відповів. Перевірте GEMINI_API_KEY / GEMINI_MODEL у Render Logs.',
      });
    }

    msgs[existingIdx] = {
      ...current,
      accepted: false,
      answered: false,
      handoffReason: needsHuman ? 'Клієнт попросив менеджера' : (ai?.reason || 'Gemini попросив передати менеджеру'),
      updatedAt: new Date().toISOString(),
    };
    write(F.support, msgs);
    await notifySupportRequest(msgs[existingIdx], 'handoff');
    return res.json({
      success: true,
      id: current.id,
      repeated: true,
      handoff: true,
      aiReply: ai?.reply || 'Передаю питання менеджеру. Він підключиться й допоможе з деталями.',
    });
    const ts = new Date(current.timestamp).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
    if (current.accepted) {
      await tg(`💬 <b>НОВЕ ПОВІДОМЛЕННЯ В ДІАЛОЗІ #${current.id}</b>\n━━━━━━━━━━━━━━\n🆔 <code>${current.sessionId}</code>\n💬 ${current.message}\n📅 ${ts}`);
    } else {
      await tg(
        `💭 <b>КЛІЄНТ ДОПИСАВ У ЗАПИТ #${current.id}</b>\n━━━━━━━━━━━━━━\n💬 ${current.message}\n📅 ${ts}`,
        { reply_markup: { inline_keyboard: [[{ text: '✋ Прийняти діалог', callback_data: `accept_${current.sessionId || current.id}` }]] } }
      );
    }
    return res.json({ success: true, id: current.id, repeated: true });
  }

  const requestedHuman = wantsHumanOperator(cleanMsg);
  const ai = requestedHuman ? null : await askSupportAi(sessionId, cleanMsg);

  if (ai?.action === 'answer') {
    const msg = {
      id: nextId(msgs), message: cleanMsg, sessionId: sessionId || null,
      timestamp: timestamp || new Date().toISOString(), answered: true, accepted: false,
      aiHandled: true, aiLastReply: ai.reply,
    };
    msgs.push(msg); write(F.support, msgs);
    return res.json({ success: true, id: msg.id, aiReply: ai.reply, ai: true });
  }

  if (!requestedHuman && !ai) {
    const msg = {
      id: nextId(msgs), message: cleanMsg, sessionId: sessionId || null,
      timestamp: timestamp || new Date().toISOString(), answered: false, accepted: false,
      aiError: true,
    };
    msgs.push(msg); write(F.support, msgs);
    return res.json({
      success: true,
      id: msg.id,
      aiError: true,
      aiReply: 'Gemini зараз не відповів. Перевірте GEMINI_API_KEY / GEMINI_MODEL у Render Logs.',
    });
  }

  const handoffMsg = {
    id: nextId(msgs), message: cleanMsg, sessionId: sessionId || null,
    timestamp: timestamp || new Date().toISOString(), answered: false, accepted: false,
    handoffReason: requestedHuman ? 'Клієнт попросив менеджера' : (ai?.reason || 'Gemini попросив передати менеджеру'),
  };
  msgs.push(handoffMsg); write(F.support, msgs);
  await notifySupportRequest(handoffMsg, requestedHuman || ai?.action === 'handoff' ? 'handoff' : 'new');
  return res.json({
    success: true,
    id: handoffMsg.id,
    handoff: true,
    aiReply: ai?.reply || 'Передаю питання менеджеру. Він підключиться й допоможе з деталями.',
  });

  const msg = {
    id: nextId(msgs), message: cleanMsg, sessionId: sessionId || null,
    timestamp: timestamp || new Date().toISOString(), answered: false, accepted: false,
  };
  msgs.push(msg); write(F.support, msgs);

  const ts = new Date(msg.timestamp).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  await tg(
    `🎧 <b>ПІДТРИМКА #${msg.id}</b>\n━━━━━━━━━━━━━━\n💬 ${msg.message}\n📅 ${ts}`,
    { reply_markup: { inline_keyboard: [[{ text: '✋ Прийняти діалог', callback_data: `accept_${sessionId || msg.id}` }]] } }
  );
  res.json({ success: true, id: msg.id });
});

app.get('/api/support',        (_req, res) => res.json(read(F.support)));
app.patch('/api/support/:id',  (req, res) => {
  const arr = read(F.support); const idx = arr.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, arr); res.json(arr[idx]);
});

/* ── Frontend fallback ─────────────────────────────────────── */
app.get('/', (_req, res) => { res.type('text/html'); res.sendFile(path.join(PUBLIC_ROOT, 'index.html')); });
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const possibleFile = path.join(PUBLIC_ROOT, req.path);
  if (fs.existsSync(possibleFile) && fs.statSync(possibleFile).isFile())
    return res.sendFile(possibleFile);
  res.type('text/html');
  res.sendFile(path.join(PUBLIC_ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🟣 ${SHOP_NAME} → http://localhost:${PORT}`);
  console.log(`🖥️  Landing directory: ${PUBLIC_ROOT}`);
  if (!TG_TOKEN) console.warn('⚠️  TG_TOKEN not set — Telegram disabled');
  console.log(`🔑 API key: ${API_KEY}`);
});
