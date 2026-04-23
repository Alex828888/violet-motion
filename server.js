/**
 * VIOLET MOTION — SERVER
 * node server.js
 *
 * .env: PORT, TG_TOKEN, TG_CHAT_ID, API_KEY
 */

require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');

const app        = express();
const PORT       = process.env.PORT       || 3000;
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const API_KEY    = process.env.API_KEY    || 'violet-secret';

/* ── Data ──────────────────────────────────────────────────── */
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const F = {
  orders:  path.join(DATA, 'orders.json'),
  reviews: path.join(DATA, 'reviews.json'),
  support: path.join(DATA, 'support.json'),
};

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
for (const file of Object.values(F)) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(arr) {
  return arr.length ? Math.max(...arr.map(x => x.id || 0)) + 1 : 1;
}

/* ── Simple rate limiter ───────────────────────────────────── */
const rateLimits = new Map();

function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key  = req.ip || 'unknown';
    const now  = Date.now();
    const data = rateLimits.get(key) || { count: 0, start: now };

    if (now - data.start > windowMs) {
      data.count = 0;
      data.start = now;
    }

    data.count++;
    rateLimits.set(key, data);

    if (data.count > max) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }

    next();
  };
}

/* Очищення старих записів кожні 10 хвилин */
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimits.entries()) {
    if (now - val.start > 10 * 60 * 1000) rateLimits.delete(key);
  }
}, 10 * 60 * 1000);

/* ── Telegram ──────────────────────────────────────────────── */
async function tg(text, extra = {}) {
  if (!TG_TOKEN || !TG_CHAT_ID) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', ...extra }),
    });
    return await r.json();
  } catch (e) {
    console.error('[TG]', e.message);
    return null;
  }
}

/* ── SSE sessions ──────────────────────────────────────────── */
const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { res: null, accepted: false, managerId: null };
  return sessions[id];
}

function sseWrite(sessionId, data) {
  const s = sessions[sessionId];
  if (s?.res) {
    try { s.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  }
}

/* ── Middleware ────────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

/* ── Static files з правильними MIME ──────────────────────── */
app.get('/style.css', (_req, res) => { res.type('text/css'); res.sendFile(path.join(ROOT, 'style.css')); });
app.get('/script.js', (_req, res) => { res.type('application/javascript'); res.sendFile(path.join(ROOT, 'script.js')); });
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(ROOT, {
  extensions: false,
  fallthrough: true,
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

/* ── Input helpers ─────────────────────────────────────────── */
function sanitizeStr(val, max = 200) {
  return String(val || '').trim().slice(0, max);
}

/* ═══════════════════════════════════════════════════════════
   ADMIN API FOR BOT
═══════════════════════════════════════════════════════════ */

app.get('/api/admin/orders', authBot, (_req, res) => res.json(read(F.orders)));

app.get('/api/admin/orders/:id', authBot, (req, res) => {
  const order = read(F.orders).find(x => x.id === Number(req.params.id));
  order ? res.json(order) : res.status(404).json({ error: 'Not found' });
});

app.patch('/api/admin/orders/:id', authBot, (req, res) => {
  const id  = Number(req.params.id);
  const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });

  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.orders, arr);
  res.json(arr[idx]);
});

app.delete('/api/admin/orders/:id', authBot, (req, res) => {
  const id  = Number(req.params.id);
  const arr = read(F.orders);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.orders, arr.filter(x => x.id !== id));
  res.json({ success: true });
});

app.get('/api/admin/reviews', authBot, (_req, res) => res.json(read(F.reviews)));

app.delete('/api/admin/reviews/:id', authBot, (req, res) => {
  const id  = Number(req.params.id);
  const arr = read(F.reviews);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.reviews, arr.filter(x => x.id !== id));
  res.json({ success: true });
});

app.get('/api/admin/support', authBot, (_req, res) => res.json(read(F.support)));

app.patch('/api/admin/support/:id', authBot, (req, res) => {
  const id  = Number(req.params.id);
  const arr = read(F.support);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });

  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, arr);
  res.json(arr[idx]);
});

/* ── SSE endpoint ──────────────────────────────────────────── */
app.get('/api/support/stream', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sess = getSession(sessionId);
  sess.res   = res;

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

  const sess    = getSession(sessionId);
  sess.accepted = true;
  sess.managerId = managerId;

  const msgs = read(F.support);
  const idx  = msgs.findIndex(m => m.sessionId === sessionId && !m.answered);
  if (idx >= 0) {
    msgs[idx].accepted   = true;
    msgs[idx].managerId  = managerId || null;
    msgs[idx].acceptedAt = new Date().toISOString();
    write(F.support, msgs);
  }

  sseWrite(sessionId, { type: 'accepted' });
  res.json({ success: true });
});

app.post('/api/support/end', authBot, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  sseWrite(sessionId, { type: 'end' });

  if (sessions[sessionId]) {
    sessions[sessionId].accepted  = false;
    sessions[sessionId].managerId = null;
  }

  const msgs = read(F.support);
  const idx  = msgs.findIndex(m => m.sessionId === sessionId && !m.answered);
  if (idx >= 0) {
    msgs[idx].answered = true;
    msgs[idx].endedAt  = new Date().toISOString();
    write(F.support, msgs);
  }

  res.json({ success: true });
});

app.get('/api/support/sessions', authBot, (_req, res) => {
  const active = Object.entries(sessions).map(([id, s]) => ({
    sessionId: id,
    accepted:  s.accepted,
    managerId: s.managerId,
    connected: !!s.res,
  }));
  res.json(active);
});

/* ═══════════════════════════════════════════════════════════
   ORDERS (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/order', rateLimit(60 * 1000, 5), async (req, res) => {
  const { name, phone, size, contactViaTelegram } = req.body;
  if (!name || !phone || !size) return res.status(400).json({ error: 'Missing fields' });

  const cleanName  = sanitizeStr(name, 100);
  const cleanPhone = sanitizeStr(phone, 20);
  const cleanSize  = sanitizeStr(size, 10);

  if (!cleanName || !cleanPhone || !cleanSize) return res.status(400).json({ error: 'Invalid fields' });

  const orders = read(F.orders);
  const o = {
    id:                nextId(orders),
    name:              cleanName,
    phone:             cleanPhone,
    size:              cleanSize,
    contactViaTelegram: !!contactViaTelegram,
    status:            'new',
    createdAt:         new Date().toISOString(),
  };

  orders.push(o);
  write(F.orders, orders);

  const ts = new Date(o.createdAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  await tg(
    `🛒 <b>НОВЕ ЗАМОВЛЕННЯ #${o.id}</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `👤 Ім'я: <b>${o.name}</b>\n📱 Телефон: <b>${o.phone}</b>\n` +
    `👟 Розмір: <b>${o.size}</b>\n` +
    (o.contactViaTelegram ? `💬 Зв'язок: <b>Telegram</b>\n` : `📞 Зв'язок: <b>Дзвінок</b>\n`) +
    `📅 ${ts}\n━━━━━━━━━━━━━━━━━━`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Підтвердити', callback_data: `confirm_${o.id}` },
          { text: '❌ Скасувати',  callback_data: `cancel_${o.id}` },
        ]],
      },
    }
  );

  res.json({ success: true, id: o.id });
});

app.get('/api/orders', (_req, res) => res.json(read(F.orders)));

app.get('/api/orders/:id', (req, res) => {
  const o = read(F.orders).find(x => x.id === +req.params.id);
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
});

app.patch('/api/orders/:id', (req, res) => {
  const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.orders, arr);
  res.json(arr[idx]);
});

app.delete('/api/orders/:id', (req, res) => {
  const id  = Number(req.params.id);
  const arr = read(F.orders);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.orders, arr.filter(x => x.id !== id));
  res.json({ success: true });
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

  if (!cleanName || !cleanText || isNaN(ratingNum)) return res.status(400).json({ error: 'Invalid fields' });

  const reviews = read(F.reviews);
  const rv = {
    id:        nextId(reviews),
    name:      cleanName,
    rating:    ratingNum,
    text:      cleanText,
    date:      date || new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
  };

  reviews.push(rv);
  write(F.reviews, reviews);

  const st = '★'.repeat(rv.rating) + '☆'.repeat(5 - rv.rating);
  await tg(
    `💬 <b>НОВИЙ ВІДГУК #${rv.id}</b>\n━━━━━━━━━━━━━━\n👤 <b>${rv.name}</b> ${st}\n<i>${rv.text}</i>`,
    { reply_markup: { inline_keyboard: [[{ text: '🗑 Видалити', callback_data: `del_review_${rv.id}` }]] } }
  );

  res.json({ success: true, id: rv.id });
});

app.get('/api/reviews', (_req, res) => res.json(read(F.reviews)));

app.delete('/api/reviews/:id', (req, res) => {
  const id  = Number(req.params.id);
  const arr = read(F.reviews);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.reviews, arr.filter(x => x.id !== id));
  res.json({ success: true });
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

  const existingIdx = sessionId
    ? msgs.findIndex(m => m.sessionId === sessionId && !m.answered)
    : -1;

  if (existingIdx >= 0) {
    msgs[existingIdx].message   = cleanMsg;
    msgs[existingIdx].timestamp = timestamp || new Date().toISOString();
    msgs[existingIdx].updatedAt = new Date().toISOString();
    write(F.support, msgs);

    const current = msgs[existingIdx];
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

  const msg = {
    id:        nextId(msgs),
    message:   cleanMsg,
    sessionId: sessionId || null,
    timestamp: timestamp || new Date().toISOString(),
    answered:  false,
    accepted:  false,
  };

  msgs.push(msg);
  write(F.support, msgs);

  const ts = new Date(msg.timestamp).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  await tg(
    `🎧 <b>ПІДТРИМКА #${msg.id}</b>\n━━━━━━━━━━━━━━\n💬 ${msg.message}\n📅 ${ts}`,
    { reply_markup: { inline_keyboard: [[{ text: '✋ Прийняти діалог', callback_data: `accept_${sessionId || msg.id}` }]] } }
  );

  res.json({ success: true, id: msg.id });
});

app.get('/api/support', (_req, res) => res.json(read(F.support)));

app.patch('/api/support/:id', (req, res) => {
  const arr = read(F.support);
  const idx = arr.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, arr);
  res.json(arr[idx]);
});

/* ── Frontend fallback ─────────────────────────────────────── */
app.get('/', (_req, res) => {
  res.type('text/html');
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  const possibleFile = path.join(ROOT, req.path);
  if (fs.existsSync(possibleFile) && fs.statSync(possibleFile).isFile()) {
    return res.sendFile(possibleFile);
  }

  res.type('text/html');
  res.sendFile(path.join(ROOT, 'index.html'));
});

/* ── Start ─────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🟣 Violet Motion → http://localhost:${PORT}`);
  if (!TG_TOKEN) console.warn('⚠️  TG_TOKEN not set — Telegram disabled');
  console.log(`🔑 API key: ${API_KEY}`);
});