'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createCrmIntegration } = require('../crm-integration');

const silentLogger = { error() {}, warn() {}, log() {} };

async function listen(app) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function createHarness(t, initialOrders, partnerUrl = '') {
  process.env.PARTNER_CRM_API_KEY = 'test-partner-key-123456';
  if (partnerUrl) process.env.PARTNER_CRM_URL = partnerUrl;
  else delete process.env.PARTNER_CRM_URL;
  process.env.PARTNER_CRM_AUTO_SYNC = 'false';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violet-crm-hardening-test-'));
  const stateFile = path.join(tempDir, 'crm-sync.json');
  const app = express();
  app.use(express.json());
  let orders = initialOrders.map(order => ({ ...order }));
  let integration;
  const persistOrders = (next, options = {}) => {
    const previous = orders;
    orders = next;
    if (integration) integration.onOrdersChanged(previous, next, options);
  };
  const adminAuth = (req, res, next) => req.headers['x-admin-key'] === 'admin-test'
    ? next()
    : res.status(401).json({ error: 'Unauthorized' });
  integration = createCrmIntegration({
    app,
    stateFile,
    readOrders: () => orders,
    persistOrders,
    adminAuth,
    logger: silentLogger,
  });
  const listener = await listen(app);
  t.after(() => {
    listener.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return {
    ...listener,
    integration,
    stateFile,
    get orders() { return orders; },
    applyLocal(next) {
      const previous = orders;
      orders = next;
      integration.onOrdersChanged(previous, next);
    },
    partnerHeaders: { 'x-api-key': process.env.PARTNER_CRM_API_KEY, 'Content-Type': 'application/json' },
    adminHeaders: { 'x-admin-key': 'admin-test', 'Content-Type': 'application/json' },
  };
}

function validOrder(id, overrides = {}) {
  return {
    id,
    name: `Client ${id}`,
    phone: `+3800000000${String(id).padStart(2, '0')}`,
    product: 'Violet Motion Sneakers',
    size: '40',
    color: 'black',
    status: 'new',
    createdAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T08:00:00.000Z',
    ...overrides,
  };
}

test('partner API protects access, upserts orders, validates statuses and reports reconciliation', async t => {
  process.env.PARTNER_CRM_API_KEY = 'test-partner-key-123456';
  delete process.env.PARTNER_CRM_URL;
  process.env.PARTNER_CRM_AUTO_SYNC = 'false';

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'violet-crm-test-'));
  const app = express();
  app.use(express.json());
  let orders = [{
    id: 1,
    name: 'Test Client',
    phone: '+380000000001',
    size: '40',
    status: 'new',
    createdAt: '2026-07-16T08:00:00.000Z',
  }];
  let integration;
  const persistOrders = (next, options = {}) => {
    const previous = orders;
    orders = next;
    if (integration) integration.onOrdersChanged(previous, next, options);
  };
  const adminAuth = (req, res, next) => req.headers['x-admin-key'] === 'admin-test'
    ? next()
    : res.status(401).json({ error: 'Unauthorized' });

  integration = createCrmIntegration({
    app,
    stateFile: path.join(tempDir, 'crm-sync.json'),
    readOrders: () => orders,
    persistOrders,
    adminAuth,
  });

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const partnerHeaders = { 'x-api-key': process.env.PARTNER_CRM_API_KEY, 'Content-Type': 'application/json' };

  let response = await fetch(`${base}/api/integration/v1/orders`);
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/integration/v1/orders`, { headers: partnerHeaders });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.orders[0].status, 'new');

  response = await fetch(`${base}/api/integration/v1/orders/google-77`, {
    method: 'PUT',
    headers: partnerHeaders,
    body: JSON.stringify({
      localId: '1',
      externalId: 'google-77',
      status: 'confirmed',
      updatedAt: '2026-07-16T09:00:00.000Z',
    }),
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.order.status, 'confirmed');
  assert.equal(orders[0].integration.partnerOrderId, 'google-77');

  response = await fetch(`${base}/api/integration/v1/orders/google-77`, {
    method: 'PATCH',
    headers: partnerHeaders,
    body: JSON.stringify({ status: 'cancelled', updatedAt: '2026-07-16T08:30:00.000Z' }),
  });
  body = await response.json();
  assert.equal(body.staleIgnored, true);
  assert.equal(body.order.status, 'confirmed');

  response = await fetch(`${base}/api/integration/v1/orders/google-77`, {
    method: 'PATCH',
    headers: partnerHeaders,
    body: JSON.stringify({ status: 'not-a-real-status' }),
  });
  assert.equal(response.status, 422);

  response = await fetch(`${base}/api/integration/v1/orders/google-77`, {
    method: 'PATCH',
    headers: partnerHeaders,
    body: JSON.stringify({ name: '', updatedAt: '2026-07-16T09:30:00.000Z' }),
  });
  assert.equal(response.status, 422);
  assert.equal(orders[0].name, 'Test Client');

  response = await fetch(`${base}/api/integration/v1/orders/google-77`, {
    method: 'PATCH',
    headers: partnerHeaders,
    body: JSON.stringify({ status: 'cancelled', updatedAt: '2026-07-15T09:30:00.000Z' }),
  });
  assert.equal(response.status, 422);
  assert.equal(orders[0].status, 'confirmed');

  const previous = orders;
  orders = [{ ...orders[0], status: 'shipped', updatedAt: '2026-07-16T10:00:00.000Z' }];
  integration.onOrdersChanged(previous, orders);
  response = await fetch(`${base}/api/admin/crm-sync/status`, { headers: { 'x-admin-key': 'admin-test' } });
  body = await response.json();
  assert.equal(body.pending, 1);
  assert.equal(body.outboundConfigured, false);

  response = await fetch(`${base}/api/integration/v1/reconcile`, {
    method: 'POST',
    headers: partnerHeaders,
    body: JSON.stringify({
      orders: [{ localId: '1', externalId: 'google-77', name: 'Test Client', phone: '+380000000001', size: '40', status: 'confirmed' }],
    }),
  });
  body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.reconciliation.statusMismatches, 1);
});

test('batch quarantines a poison row without blocking valid rows or the sender cursor', async t => {
  const harness = await createHarness(t, [validOrder(1)]);
  const response = await fetch(`${harness.base}/api/integration/v1/orders/batch`, {
    method: 'POST',
    headers: harness.partnerHeaders,
    body: JSON.stringify({
      orders: [
        {
          localId: '573',
          externalId: 'poison-573',
          name: '',
          phone: '',
          product: null,
          size: '',
          status: 'cancelled',
          createdAt: '2026-07-22T07:20:41.496Z',
          updatedAt: '2026-07-22T07:19:21.697Z',
        },
        {
          localId: '77',
          externalId: 'remote-good-77',
          name: 'Valid Remote',
          phone: '+380991112233',
          product: 'Violet Motion Sneakers',
          size: '39',
          color: 'white',
          status: 'new',
          createdAt: '2026-07-22T07:20:41.496Z',
          updatedAt: '2026-07-22T07:20:41.496Z',
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.processed, 2);
  assert.equal(body.accepted, 1);
  assert.equal(body.quarantined, 1);
  assert.equal(body.results[0].quarantined, true);
  assert.equal(body.results[1].ok, true);
  assert.equal(harness.orders.length, 2);
  assert.equal(harness.orders.some(order => order.integration?.partnerOrderId === 'poison-573'), false);
  assert.equal(harness.orders.some(order => order.integration?.partnerOrderId === 'remote-good-77'), true);

  const statusResponse = await fetch(`${harness.base}/api/admin/crm-sync/status`, { headers: harness.adminHeaders });
  const status = await statusResponse.json();
  assert.equal(status.quarantine, 1);
  assert.equal(status.recentErrors[0].code, 'REMOTE_REQUIRED_FIELDS');
  assert.equal(JSON.stringify(status.recentErrors).includes('+380'), false);
});

test('startup removes an invalid partner import and merges only an active-new semantic partner duplicate', async t => {
  const canonical = validOrder(564, {
    name: 'Юлия Левченко',
    phone: '+380991234567',
    size: '39',
  });
  const importedDuplicate = validOrder(565, {
    name: 'Юлия (partner spelling)',
    phone: '+38 (099) 123-45-67',
    size: '39',
    integration: { partnerOrderId: 'stale-universal-563' },
  });
  const poison = validOrder(573, {
    name: '',
    phone: '',
    product: null,
    size: '',
    status: 'cancelled',
    createdAt: '2026-07-22T07:20:41.496Z',
    updatedAt: '2026-07-22T07:19:21.697Z',
    integration: { partnerOrderId: 'poison-partner-id' },
  });
  const harness = await createHarness(t, [canonical, importedDuplicate, poison]);

  assert.deepEqual(harness.orders.map(order => order.id), [564]);
  assert.equal(harness.orders[0].integration.partnerOrderId, 'stale-universal-563');
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.quarantine.some(item => item.localId === '573'), true);
  assert.equal(state.tombstones.some(item => item.localId === '573' && item.externalId === 'poison-partner-id'), true);
  assert.equal(state.tombstones.some(item => item.localId === '565' && !item.externalId), true);
  assert.equal(state.pending.some(item => item.type === 'order.delete' && item.localId === '573' && item.order.externalId === 'poison-partner-id'), true);
  assert.equal(state.pending.some(item => item.type === 'order.upsert' && item.localId === '564'), true);
});

test('acknowledged poison deletion resolves quarantine but keeps its tombstone', async t => {
  const partnerApp = express();
  partnerApp.use(express.json());
  partnerApp.post('/bridge', (req, res) => res.json({
    ok: true,
    results: (req.body?.events || []).map(event => ({ eventId: event.eventId, ok: true })),
  }));
  const partner = await listen(partnerApp);
  t.after(() => partner.server.close());
  const poison = validOrder(573, {
    name: '',
    phone: '',
    size: '',
    status: 'cancelled',
    integration: { partnerOrderId: 'poison-partner-id' },
  });
  const harness = await createHarness(t, [poison], `${partner.base}/bridge`);
  let state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.quarantine.length, 1);
  assert.equal(state.tombstones.length, 1);

  const result = await harness.integration.flushPending(true);
  assert.equal(result.sent, 1);
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.pending.length, 0);
  assert.equal(state.quarantine.length, 0);
  assert.equal(state.tombstones.length, 1);
});

test('inbound delete is idempotent and its tombstone blocks stale resurrection', async t => {
  const harness = await createHarness(t, [validOrder(1, { integration: { partnerOrderId: 'remote-delete-1' } })]);
  let response = await fetch(`${harness.base}/api/integration/v1/orders/remote-delete-1`, {
    method: 'DELETE',
    headers: harness.partnerHeaders,
    body: JSON.stringify({ localId: '1' }),
  });
  let body = await response.json();
  assert.equal(body.deleted, true);
  assert.equal(body.existed, true);
  assert.equal(harness.orders.length, 0);

  response = await fetch(`${harness.base}/api/integration/v1/orders/remote-delete-1`, {
    method: 'DELETE',
    headers: harness.partnerHeaders,
    body: JSON.stringify({ localId: '1' }),
  });
  body = await response.json();
  assert.equal(body.existed, false);

  response = await fetch(`${harness.base}/api/integration/v1/orders/remote-delete-1`, {
    method: 'PUT',
    headers: harness.partnerHeaders,
    body: JSON.stringify({
      localId: '1',
      name: 'Stale Remote',
      phone: '+380991111111',
      product: 'Sneakers',
      size: '40',
      status: 'new',
      createdAt: '2026-07-16T08:00:00.000Z',
      updatedAt: '2026-07-16T09:00:00.000Z',
    }),
  });
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.tombstoneIgnored, true);
  assert.equal(harness.orders.length, 0);
});

test('push handles partial acknowledgements and moves a repeatedly rejected event to dead-letter after eight attempts', async t => {
  const partnerApp = express();
  partnerApp.use(express.json());
  partnerApp.post('/bridge', (req, res) => {
    const events = req.body?.events || [];
    res.json({
      success: false,
      results: events.map(event => event.order.localId === '1'
        ? { eventId: event.eventId, success: true }
        : { eventId: event.eventId, success: false, code: 'REMOTE_REJECTED', message: 'Rejected test event' }),
    });
  });
  const partner = await listen(partnerApp);
  t.after(() => partner.server.close());
  const harness = await createHarness(t, [validOrder(1), validOrder(2)], `${partner.base}/bridge`);
  harness.applyLocal([
    validOrder(1, { status: 'confirmed', updatedAt: '2026-07-16T09:00:00.000Z' }),
    validOrder(2, { status: 'confirmed', updatedAt: '2026-07-16T09:00:00.000Z' }),
  ]);

  let result = await harness.integration.flushPending(true);
  assert.equal(result.attempted, 2);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  let state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].localId, '2');
  assert.equal(state.pending[0].attempts, 1);
  const firstError = state.syncErrors.at(-1);
  assert.equal(firstError.httpStatus, 200);
  assert.equal(firstError.order.localId, '2');
  assert.equal(firstError.order.phone.endsWith('0002'), true);
  assert.equal(firstError.order.phone.includes('+380'), false);
  assert.match(firstError.partnerResponse, /REMOTE_REJECTED/);

  for (let attempt = 0; attempt < 7; attempt++) await harness.integration.flushPending(true);
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.pending.length, 0);
  assert.equal(state.deadLetter.length, 1);
  assert.equal(state.deadLetter[0].attempts, 8);

  const retryResponse = await fetch(`${harness.base}/api/admin/crm-sync/retry`, {
    method: 'POST',
    headers: harness.adminHeaders,
    body: JSON.stringify({ eventId: state.deadLetter[0].eventId }),
  });
  const retry = await retryResponse.json();
  assert.equal(retry.retried, 1);
  assert.equal(retry.pending, 1);
  assert.equal(retry.deadLetter, 0);
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.pending[0].attempts, 0);
  assert.notEqual(state.pending[0].eventId, state.pending[0].retriedFromEventId);
});

test('a push acknowledgement cannot erase a newer event queued during the network request', async t => {
  let releaseRequest;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseRequest = resolve; });
  const partnerApp = express();
  partnerApp.use(express.json());
  partnerApp.post('/bridge', async (req, res) => {
    markStarted();
    await gate;
    res.json({ ok: true, results: req.body.events.map(event => ({ eventId: event.eventId, ok: true })) });
  });
  const partner = await listen(partnerApp);
  t.after(() => partner.server.close());
  const harness = await createHarness(t, [validOrder(1)], `${partner.base}/bridge`);
  harness.applyLocal([validOrder(1, { status: 'confirmed', updatedAt: '2026-07-16T09:00:00.000Z' })]);
  const inFlight = harness.integration.flushPending(true);
  await started;
  harness.applyLocal([validOrder(1, { status: 'shipped', updatedAt: '2026-07-16T10:00:00.000Z' })]);
  releaseRequest();
  await inFlight;

  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].localId, '1');
  assert.equal(state.pending[0].order.status, 'shipped');
  assert.equal(state.pending[0].attempts, 0);
});

test('full sync pushes local-newer field and status mismatches and refreshes to convergence', async t => {
  let remoteOrder = {
    ...validOrder(1, { status: 'new', updatedAt: '2026-07-16T09:00:00.000Z' }),
    localId: '1',
  };
  let listCalls = 0;
  const receivedEvents = [];
  const partnerApp = express();
  partnerApp.use(express.json());
  partnerApp.post('/bridge', (req, res) => {
    if (req.body?.action === 'list') {
      listCalls++;
      return res.json({ ok: true, orders: [remoteOrder] });
    }
    const events = req.body?.events || [];
    receivedEvents.push(...events);
    for (const event of events) {
      if (event.type === 'order.upsert') remoteOrder = { ...event.order };
    }
    return res.json({
      ok: true,
      results: events.map(event => ({ eventId: event.eventId, success: true })),
    });
  });
  const partner = await listen(partnerApp);
  t.after(() => partner.server.close());
  const harness = await createHarness(t, [validOrder(1, {
    status: 'confirmed',
    managerComment: 'Local manager value',
    updatedAt: '2026-07-16T10:00:00.000Z',
  })], `${partner.base}/bridge`);

  const result = await harness.integration.runFullSync();
  assert.equal(result.queuedMissing, 0);
  assert.equal(result.queuedMismatches, 1);
  assert.equal(receivedEvents.length, 1);
  assert.equal(receivedEvents[0].order.status, 'confirmed');
  assert.equal(receivedEvents[0].order.managerComment, 'Local manager value');
  assert.equal(remoteOrder.status, 'confirmed');
  assert.equal(remoteOrder.managerComment, 'Local manager value');
  assert.equal(listCalls, 2);
  assert.equal(result.reconciliation.ok, true);
  assert.equal(result.reconciliation.mismatches.length, 0);
});

test('overlapping full sync calls share one run and one partner list request', async t => {
  let listCalls = 0;
  let releaseList;
  let markListStarted;
  const listStarted = new Promise(resolve => { markListStarted = resolve; });
  const gate = new Promise(resolve => { releaseList = resolve; });
  const remote = validOrder(1);
  const partnerApp = express();
  partnerApp.use(express.json());
  partnerApp.post('/bridge', async (req, res) => {
    if (req.body?.action === 'list') {
      listCalls++;
      markListStarted();
      await gate;
      return res.json({ ok: true, orders: [{ ...remote, localId: '1' }] });
    }
    return res.json({ ok: true, results: (req.body?.events || []).map(event => ({ eventId: event.eventId, ok: true })) });
  });
  const partner = await listen(partnerApp);
  t.after(() => partner.server.close());
  const harness = await createHarness(t, [remote], `${partner.base}/bridge`);
  const first = harness.integration.runFullSync();
  const second = harness.integration.runFullSync();
  assert.equal(first, second);
  await listStarted;
  releaseList();
  await Promise.all([first, second]);
  assert.equal(listCalls, 1);
});
