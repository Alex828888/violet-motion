'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SERVER_FILE = path.join(ROOT, 'server.js');
const API_KEY = 'e2e-admin-key';

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function eventually(check, { timeout = 4_000, interval = 25 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }
  throw lastError || new Error('Condition was not met');
}

async function startServer(t, { orders = [], support = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violet-server-e2e-'));
  const fastTimerPreload = path.join(dataDir, 'fast-support-timer.cjs');
  fs.writeFileSync(fastTimerPreload, [
    "'use strict';",
    'const nativeSetInterval = global.setInterval;',
    'global.setInterval = (callback, delay, ...args) => nativeSetInterval(callback, Number(delay) === 60000 ? 25 : delay, ...args);',
  ].join('\n'), 'utf8');
  const port = await unusedPort();
  const logs = [];
  const child = spawn(process.execPath, ['--require', fastTimerPreload, SERVER_FILE], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      LANDING_DIR: ROOT,
      API_KEY,
      TG_TOKEN: '',
      BOT_TOKEN: '',
      TG_CHAT_ID: '',
      ZAPUSK_TG_TOKEN: '',
      ZAPUSK_TG_CHAT_ID: '',
      GEMINI_API_KEY: '',
      SUPPORT_AI_ENABLED: 'false',
      SUPPORT_AI_IDLE_MINUTES: '2',
      ZVONOK_API_KEY: '',
      ZVONOK_CAMPAIGN_ID: '',
      NOVA_POSHTA_API_KEY: '',
      NP_AUTO_SYNC: 'false',
      MONOBANK_CRM_ENABLED: 'false',
      PARTNER_CRM_AUTO_SYNC: 'false',
      PARTNER_CRM_URL: '',
      PARTNER_CRM_API_KEY: 'e2e-partner-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = chunk => {
    logs.push(String(chunk));
    if (logs.length > 100) logs.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  t.after(async () => {
    if (child.exitCode == null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 1_000)),
      ]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await eventually(async () => {
    if (child.exitCode != null) throw new Error(`Server exited (${child.exitCode}):\n${logs.join('')}`);
    const response = await fetch(`${base}/favicon.ico`);
    assert.equal(response.status, 204);
  }, { timeout: 8_000, interval: 50 });

  // DATA_DIR initialization may copy bundled development data. Replace it only
  // after startup so every test begins from a deliberate, isolated snapshot.
  atomicJson(path.join(dataDir, 'orders.json'), orders);
  atomicJson(path.join(dataDir, 'support.json'), support);

  return {
    base,
    dataDir,
    logs,
    read(name) {
      return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
    },
    write(name, value) {
      atomicJson(path.join(dataDir, name), value);
    },
  };
}

async function jsonRequest(base, pathname, {
  method = 'GET',
  body,
  authorized = false,
  ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
} = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
  };
  if (authorized) headers['x-api-key'] = API_KEY;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function manualOrder(overrides = {}) {
  return {
    name: 'Test Customer',
    phone: '+38 (067) 111-22-33',
    size: '39',
    color: 'Violet',
    product: 'Violet Motion Sneakers',
    variant: 'p.39',
    quantity: 1,
    orderMode: 'manual',
    clientOrderKey: 'manual-key-1',
    ...overrides,
  };
}

test('public order API deduplicates semantically, upgrades in place, and serializes races', async t => {
  const app = await startServer(t);

  await t.test('private order reads and mutations require the API key', async () => {
    let result = await jsonRequest(app.base, '/api/orders');
    assert.equal(result.response.status, 401);

    result = await jsonRequest(app.base, '/api/orders/1', { method: 'PATCH', body: { status: 'confirmed' } });
    assert.equal(result.response.status, 401);

    result = await jsonRequest(app.base, '/api/orders', { authorized: true });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, []);
  });

  await t.test('same active new checkout is one order even with another key and phone formatting', async () => {
    const first = await jsonRequest(app.base, '/api/order', {
      method: 'POST', body: manualOrder(), ip: '198.51.100.10',
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.payload.success, true);
    assert.equal(first.payload.duplicate, undefined);

    const idempotentRetry = await jsonRequest(app.base, '/api/order', {
      method: 'POST',
      body: manualOrder({ name: 'Changed by a retried request', size: '36' }),
      ip: '198.51.100.15',
    });
    assert.equal(idempotentRetry.response.status, 200);
    assert.equal(idempotentRetry.payload.duplicate, true);
    assert.equal(idempotentRetry.payload.id, first.payload.id);

    const repeated = await jsonRequest(app.base, '/api/order', {
      method: 'POST',
      body: manualOrder({ phone: '380671112233', clientOrderKey: 'manual-key-2' }),
      ip: '198.51.100.11',
    });
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.payload.duplicate, true);
    assert.equal(repeated.payload.id, first.payload.id);
    assert.equal(app.read('orders.json').length, 1);
  });

  await t.test('manual checkout becomes instant checkout without changing ID or adding a row', async () => {
    const before = app.read('orders.json')[0];
    const instant = await jsonRequest(app.base, '/api/order', {
      method: 'POST',
      body: manualOrder({
        orderMode: 'instant',
        replaceOrderId: before.id,
        clientOrderKey: before.clientOrderKey,
        fullName: 'Test Customer Full',
        city: 'Kyiv',
        district: 'Shevchenkivskyi',
        postOffice: '12',
      }),
      ip: '198.51.100.12',
    });
    assert.equal(instant.response.status, 200);
    assert.equal(instant.payload.upgraded, true);
    assert.equal(instant.payload.id, before.id);

    const stored = app.read('orders.json');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, before.id);
    assert.equal(stored[0].createdAt, before.createdAt);
    assert.equal(stored[0].orderMode, 'instant');
    assert.equal(stored[0].fullName, 'Test Customer Full');
    assert.ok(stored[0].upgradedFromManualAt);
    assert.equal(stored[0].zvonokDispatchAttempts, 1);

    const repeated = await jsonRequest(app.base, '/api/order', {
      method: 'POST',
      body: manualOrder({
        orderMode: 'instant',
        replaceOrderId: before.id,
        clientOrderKey: before.clientOrderKey,
        fullName: 'Test Customer Full',
        city: 'Kyiv',
        district: 'Shevchenkivskyi',
        postOffice: '12',
      }),
      ip: '198.51.100.16',
    });
    assert.equal(repeated.payload.duplicate, true);
    assert.equal(repeated.payload.id, before.id);
    assert.equal(app.read('orders.json')[0].zvonokDispatchAttempts, 1);
  });

  await t.test('completed/non-new order does not suppress a legitimate later order', async () => {
    const existing = app.read('orders.json')[0];
    let result = await jsonRequest(app.base, `/api/orders/${existing.id}`, {
      method: 'PATCH', authorized: true, body: { status: 'confirmed' }, ip: '198.51.100.13',
    });
    assert.equal(result.response.status, 200);

    result = await jsonRequest(app.base, '/api/order', {
      method: 'POST',
      body: manualOrder({ clientOrderKey: 'legitimate-new-order' }),
      ip: '198.51.100.14',
    });
    assert.equal(result.response.status, 200);
    assert.notEqual(result.payload.id, existing.id);
    assert.equal(result.payload.duplicate, undefined);
    assert.equal(app.read('orders.json').length, 2);
  });

  await t.test('parallel submissions with different idempotency keys create exactly one row', async () => {
    const phone = '+380991234567';
    const requests = Array.from({ length: 5 }, (_, index) => jsonRequest(app.base, '/api/order', {
      method: 'POST',
      body: manualOrder({
        name: 'Race Customer',
        phone,
        size: '37',
        variant: 'race-p.37',
        clientOrderKey: `race-${index}`,
      }),
      ip: '203.0.113.1',
    }));
    const results = await Promise.all(requests);
    results.forEach(({ response, payload }) => {
      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
    });
    assert.equal(new Set(results.map(item => item.payload.id)).size, 1);
    assert.equal(app.read('orders.json').filter(order => order.phone === phone).length, 1);
  });
});

test('support keeps a durable transcript, verified order context, summary, and private admin API', async t => {
  const order = {
    id: 42,
    name: 'Real Order Name',
    fullName: 'Real Customer Full Name',
    phone: '+380501112233',
    size: '38',
    status: 'new',
    createdAt: '2026-07-22T08:00:00.000Z',
    updatedAt: '2026-07-22T08:00:00.000Z',
  };
  const app = await startServer(t, { orders: [order] });

  let result = await jsonRequest(app.base, '/api/support');
  assert.equal(result.response.status, 401);
  result = await jsonRequest(app.base, '/api/support/1', { method: 'PATCH', body: { answered: true } });
  assert.equal(result.response.status, 401);

  const sessionId = 'support-session-one';
  result = await jsonRequest(app.base, '/api/support', {
    method: 'POST',
    body: {
      sessionId,
      message: 'Яка зараз ціна?',
      customer: { orderId: 42, name: 'Spoofed Name', phone: '000' },
    },
    ip: '192.0.2.30',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.ai, true);
  assert.match(result.payload.aiReply, /895/);
  const supportId = result.payload.id;

  result = await jsonRequest(app.base, '/api/support', {
    method: 'POST',
    body: { sessionId, message: 'А як доставляєте?', customer: { orderId: 42 } },
    ip: '192.0.2.31',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.ai, true);
  assert.equal(result.payload.id, supportId);
  assert.equal(result.payload.repeated, true);

  result = await jsonRequest(app.base, '/api/support', { authorized: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.length, 1);
  let conversation = result.payload[0];
  assert.equal(conversation.category, 'ai_history');
  assert.equal(conversation.status, 'active');
  assert.equal(conversation.customer.name, 'Real Customer Full Name');
  assert.equal(conversation.customer.phone, order.phone);
  assert.equal(conversation.customer.orderId, 42);
  assert.deepEqual(conversation.messages.map(message => message.role), ['user', 'ai', 'user', 'ai']);
  assert.ok(conversation.summaryDueAt);

  // Make the already-scheduled idle completion due now; the test preload only
  // shortens the scanner interval, not the production idle-time calculation.
  const records = app.read('support.json');
  records[0].summaryDueAt = '2020-01-01T00:00:00.000Z';
  app.write('support.json', records);

  conversation = await eventually(async () => {
    const current = (await jsonRequest(app.base, '/api/support', { authorized: true })).payload[0];
    assert.equal(current.status, 'closed');
    return current;
  });
  assert.equal(conversation.category, 'ai_history');
  assert.equal(conversation.summary.resolved, true);
  assert.equal(conversation.summary.managerRequired, false);
  assert.ok(conversation.summary.topic);
  assert.ok(conversation.completedAt);
  assert.ok(conversation.summaryNotifiedAt);
  assert.equal(conversation.messages.length, 4);

  result = await jsonRequest(app.base, '/api/support', {
    method: 'POST',
    body: { sessionId: 'manager-session', message: 'Хочу поговорити з менеджером' },
    ip: '192.0.2.32',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.handoff, true);
  const managerRecord = app.read('support.json').find(item => item.id === result.payload.id);
  assert.equal(managerRecord.category, 'manager_required');
  assert.equal(managerRecord.status, 'waiting_manager');
  assert.equal(managerRecord.summary.managerRequired, true);
  assert.equal(managerRecord.summary.resolved, false);

  result = await jsonRequest(app.base, '/api/support', {
    method: 'POST',
    body: { sessionId: 'cancel-session', message: 'Хочу отменить заказ №42' },
    ip: '192.0.2.33',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.handoff, true);
  const cancelRecord = app.read('support.json').find(item => item.id === result.payload.id);
  assert.equal(cancelRecord.category, 'manager_required');
  assert.equal(cancelRecord.status, 'waiting_manager');
});

function extractFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const firstBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = firstBrace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

test('instant-order frontend requires explicit final confirmation and offers editing', () => {
  const source = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const answerStep = extractFunction(source, 'submitQuickAnswer');
  const review = extractFunction(source, 'showQuickOrderReview');
  const confirmed = extractFunction(source, 'submitConfirmedQuickOrder');
  const reviewText = extractFunction(source, 'quickOrderReviewText');

  assert.match(answerStep, /showQuickOrderReview\(\)/);
  assert.match(review, /quick-order-review-confirm/);
  assert.match(review, /quick-order-review-edit/);
  assert.doesNotMatch(review, /sendPendingOrder\s*\(\s*['"]instant['"]/);
  assert.match(confirmed, /sendPendingOrder\s*\(\s*['"]instant['"]/);
  assert.match(confirmed, /if \(!sent\)/);
  ['name', 'phone', 'product', 'size', 'color', 'quantity', 'fullName', 'city', 'district', 'postOffice']
    .forEach(field => assert.match(reviewText, new RegExp(`(?:order|quickOrderData)\\.${field}`)));
});

test('Telegram bot dependency exposes the runtime API used by bot.js', () => {
  const { TelegramBot } = require('node-telegram-bot-api');
  const bot = new TelegramBot('123456:TESTTOKEN', { polling: false });
  ['onText', 'on', 'sendMessage', 'editMessageText', 'answerCallbackQuery', 'setWebHook', 'processUpdate']
    .forEach(method => assert.equal(typeof bot[method], 'function', `${method} must be available`));
});
