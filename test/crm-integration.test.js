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

async function createHarness(t, initialOrders, partnerUrl = '', options = {}) {
  process.env.PARTNER_CRM_API_KEY = 'test-partner-key-123456';
  if (partnerUrl) process.env.PARTNER_CRM_URL = partnerUrl;
  else delete process.env.PARTNER_CRM_URL;
  process.env.PARTNER_CRM_AUTO_SYNC = 'false';
  delete process.env.PARTNER_CRM_ALLOW_BACKFILL;
  if (options.allowInboundDelete === false) delete process.env.PARTNER_CRM_ALLOW_INBOUND_DELETE;
  else process.env.PARTNER_CRM_ALLOW_INBOUND_DELETE = 'true';
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
    onOrderStatusChanged: options.onOrderStatusChanged || (() => {}),
    logger: silentLogger,
    stateWriter: options.stateWriter || null,
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
  delete process.env.PARTNER_CRM_ALLOW_BACKFILL;

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
    logger: silentLogger,
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

  response = await fetch(`${base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: partnerHeaders,
    body: JSON.stringify({ externalId: 'google-77', status: 'cancelled', updatedAt: '2026-07-16T08:30:00.000Z' }),
  });
  body = await response.json();
  assert.equal(body.staleIgnored, true);
  assert.equal(body.order.status, 'confirmed');

  response = await fetch(`${base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: partnerHeaders,
    body: JSON.stringify({ externalId: 'google-77', status: 'not-a-real-status' }),
  });
  assert.equal(response.status, 422);

  response = await fetch(`${base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: partnerHeaders,
    body: JSON.stringify({ externalId: 'google-77', name: '', updatedAt: '2026-07-16T09:30:00.000Z' }),
  });
  assert.equal(response.status, 422);
  assert.equal(orders[0].name, 'Test Client');

  response = await fetch(`${base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: partnerHeaders,
    body: JSON.stringify({ externalId: 'google-77', status: 'cancelled', updatedAt: '2026-07-15T09:30:00.000Z' }),
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

test('PATCH by localId updates confirmed and cancelled, returns the persisted projection, and never creates', async t => {
  const notices = [];
  const harness = await createHarness(t, [validOrder(1, {
    integration: { partnerOrderId: 'universal-1' },
  })], '', {
    onOrderStatusChanged: order => notices.push({ id: order.id, status: order.status }),
  });

  let response = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: { ...harness.partnerHeaders, 'Idempotency-Key': 'confirm-local-1' },
    body: JSON.stringify({
      localId: '1',
      externalId: 'universal-1',
      status: 'confirmed',
      updatedAt: '2026-07-16T09:00:00.000Z',
    }),
  });
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    created: false,
    order: {
      localId: '1',
      externalId: 'universal-1',
      status: 'confirmed',
      updatedAt: '2026-07-16T09:00:00.000Z',
    },
  });
  assert.equal(harness.orders.length, 1);
  assert.equal(harness.orders[0].status, 'confirmed');

  response = await fetch(`${harness.base}/api/integration/v1/orders`, { headers: harness.partnerHeaders });
  body = await response.json();
  assert.equal(body.orders.filter(order => order.status === 'new').length, 0);
  assert.equal(body.orders[0].status, 'confirmed');

  response = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: { ...harness.partnerHeaders, 'Idempotency-Key': 'cancel-local-1' },
    body: JSON.stringify({
      localId: '1',
      externalId: 'universal-1',
      status: 'cancelled',
      updatedAt: '2026-07-16T10:00:00.000Z',
    }),
  });
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.order.status, 'cancelled');
  assert.equal(harness.orders[0].status, 'cancelled');

  response = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: harness.partnerHeaders,
    body: JSON.stringify({
      localId: '1',
      externalId: 'universal-1',
      status: 'shipped',
      updatedAt: '2026-07-16T11:00:00.000Z',
    }),
  });
  body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.error, 'invalid_status');
  assert.equal(harness.orders[0].status, 'cancelled');

  const beforeUnknown = JSON.parse(JSON.stringify(harness.orders));
  response = await fetch(`${harness.base}/api/integration/v1/orders/999`, {
    method: 'PATCH',
    headers: { ...harness.partnerHeaders, 'Idempotency-Key': 'unknown-local-999' },
    body: JSON.stringify({
      localId: '999',
      externalId: 'universal-999',
      name: 'Would Be A Duplicate',
      phone: '+380000000999',
      size: '40',
      status: 'confirmed',
      createdAt: '2026-07-16T08:00:00.000Z',
      updatedAt: '2026-07-16T11:00:00.000Z',
    }),
  });
  body = await response.json();
  assert.equal(response.status, 404);
  assert.deepEqual(body, { ok: false, created: false, error: 'order_not_found' });
  assert.deepEqual(harness.orders, beforeUnknown);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices, [
    { id: 1, status: 'confirmed' },
    { id: 1, status: 'cancelled' },
  ]);
});

test('Idempotency-Key replays the exact first PATCH response without a second update or notice', async t => {
  const notices = [];
  const harness = await createHarness(t, [validOrder(1, {
    integration: { partnerOrderId: 'universal-idempotent-1' },
  })], '', {
    onOrderStatusChanged: order => notices.push(order.status),
  });
  const headers = { ...harness.partnerHeaders, 'Idempotency-Key': 'same-request-key' };
  const payload = {
    localId: '1',
    externalId: 'universal-idempotent-1',
    status: 'confirmed',
    updatedAt: '2026-07-16T09:00:00.000Z',
  };

  const firstResponse = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH', headers, body: JSON.stringify(payload),
  });
  const firstBody = await firstResponse.json();
  const afterFirst = JSON.parse(JSON.stringify(harness.orders));

  const secondResponse = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH', headers, body: JSON.stringify(payload),
  });
  const secondBody = await secondResponse.json();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(secondBody, firstBody);
  assert.deepEqual(harness.orders, afterFirst);
  assert.equal(harness.orders.length, 1);
  assert.equal(harness.orders[0].updatedAt, '2026-07-16T09:00:00.000Z');
  assert.deepEqual(notices, ['confirmed']);

  const sameExternalResponse = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: { ...harness.partnerHeaders, 'Idempotency-Key': 'different-key-same-order' },
    body: JSON.stringify(payload),
  });
  const sameExternalBody = await sameExternalResponse.json();
  assert.equal(sameExternalResponse.status, 200);
  assert.deepEqual(sameExternalBody, firstBody);
  assert.equal(harness.orders.length, 1);
  assert.equal(harness.orders[0].integration.partnerOrderId, 'universal-idempotent-1');
  assert.deepEqual(notices, ['confirmed']);

  const conflictResponse = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ ...payload, status: 'cancelled', updatedAt: '2026-07-16T10:00:00.000Z' }),
  });
  const conflict = await conflictResponse.json();
  assert.equal(conflictResponse.status, 409);
  assert.equal(conflict.error, 'idempotency_key_reused');
  assert.equal(harness.orders[0].status, 'confirmed');
  assert.deepEqual(notices, ['confirmed']);

  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.idempotency.length, 2);
  assert.equal(JSON.stringify(state).includes('same-request-key'), false);

  harness.applyLocal([{
    ...harness.orders[0],
    status: 'cancelled',
    updatedAt: '2026-07-16T10:00:00.000Z',
  }]);
  let restartWrites = 0;
  const restartApp = express();
  restartApp.use(express.json());
  createCrmIntegration({
    app: restartApp,
    stateFile: harness.stateFile,
    readOrders: () => harness.orders,
    persistOrders: () => { restartWrites++; },
    adminAuth: (_req, _res, next) => next(),
    onOrderStatusChanged: order => notices.push(order.status),
    logger: silentLogger,
  });
  const restarted = await listen(restartApp);
  t.after(() => restarted.server.close());
  const replayAfterRestart = await fetch(`${restarted.base}/api/integration/v1/orders/1`, {
    method: 'PATCH', headers, body: JSON.stringify(payload),
  });
  const replayAfterRestartBody = await replayAfterRestart.json();
  assert.equal(replayAfterRestart.status, 200);
  assert.deepEqual(replayAfterRestartBody, firstBody);
  assert.equal(harness.orders[0].status, 'cancelled');
  assert.equal(restartWrites, 0);
  assert.deepEqual(notices, ['confirmed']);
});

test('PATCH rejects externalId rebinding and old timestamps without modifying either order', async t => {
  const notices = [];
  const initial = [
    validOrder(1, {
      status: 'confirmed',
      updatedAt: '2026-07-16T10:00:00.000Z',
      integration: { partnerOrderId: 'universal-bound-1' },
    }),
    validOrder(2),
  ];
  const harness = await createHarness(t, initial, '', {
    onOrderStatusChanged: order => notices.push(order.status),
  });
  const original = JSON.parse(JSON.stringify(harness.orders));

  let response = await fetch(`${harness.base}/api/integration/v1/orders/2`, {
    method: 'PATCH',
    headers: harness.partnerHeaders,
    body: JSON.stringify({
      localId: '2',
      externalId: 'universal-bound-1',
      status: 'confirmed',
      updatedAt: '2026-07-16T11:00:00.000Z',
    }),
  });
  let body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, 'external_id_conflict');
  assert.deepEqual(harness.orders, original);

  response = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: harness.partnerHeaders,
    body: JSON.stringify({
      localId: '1',
      externalId: 'replacement-external',
      status: 'cancelled',
      updatedAt: '2026-07-16T11:00:00.000Z',
    }),
  });
  body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, 'external_id_rebind_forbidden');
  assert.deepEqual(harness.orders, original);

  response = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: { ...harness.partnerHeaders, 'Idempotency-Key': 'stale-cancel-key' },
    body: JSON.stringify({
      localId: '1',
      externalId: 'universal-bound-1',
      status: 'cancelled',
      updatedAt: '2026-07-16T09:00:00.000Z',
    }),
  });
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.staleIgnored, true);
  assert.equal(body.order.status, 'confirmed');
  assert.deepEqual(harness.orders, original);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices, []);
});

test('PATCH rolls the order back and returns retryable HTTP 500 when durable idempotency storage fails', async t => {
  const notices = [];
  const initial = validOrder(1, { integration: { partnerOrderId: 'rollback-external-1' } });
  const harness = await createHarness(t, [initial], '', {
    onOrderStatusChanged: order => notices.push(order.status),
    stateWriter: () => {
      const error = new Error('Simulated state storage failure');
      error.code = 'ENOSPC';
      throw error;
    },
  });
  const before = JSON.parse(JSON.stringify(harness.orders));

  const response = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: { ...harness.partnerHeaders, 'Idempotency-Key': 'rollback-key' },
    body: JSON.stringify({
      localId: '1',
      externalId: 'rollback-external-1',
      status: 'confirmed',
      updatedAt: '2026-07-16T09:00:00.000Z',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.deepEqual(body, { ok: false, created: false, error: 'patch_failed' });
  assert.deepEqual(harness.orders, before);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices, []);
  assert.equal(fs.existsSync(harness.stateFile), false);
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

test('full sync audits invalid and duplicate historical orders without changing or deleting them', async t => {
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
  const before = JSON.parse(JSON.stringify(harness.orders));

  await harness.integration.runFullSync();

  assert.deepEqual(harness.orders, before);
  assert.deepEqual(harness.orders.map(order => order.id), [564, 565, 573]);
  const state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.quarantine.some(item => item.localId === '573'), true);
  assert.equal(state.tombstones.length, 0);
  assert.equal(state.pending.some(item => item.type === 'order.delete'), false);
});

test('identity audit reports existing conflicts without historical backfill', async t => {
  const orders = [
    validOrder(1, { integration: { partnerOrderId: 'duplicate-external' } }),
    validOrder(1, { name: 'Second record', integration: { partnerOrderId: 'duplicate-external' } }),
  ];
  const harness = await createHarness(t, orders);
  const before = JSON.parse(JSON.stringify(harness.orders));
  const response = await fetch(`${harness.base}/api/admin/crm-sync/status`, { headers: harness.adminHeaders });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.identityConflicts, { localId: 1, externalId: 1 });
  assert.deepEqual(harness.orders, before);
});

test('inbound delete is disabled by default for direct and batch requests', async t => {
  const initial = [validOrder(1, { integration: { partnerOrderId: 'protected-delete-1' } })];
  const harness = await createHarness(t, initial, '', { allowInboundDelete: false });

  let response = await fetch(`${harness.base}/api/integration/v1/orders/protected-delete-1`, {
    method: 'DELETE',
    headers: harness.partnerHeaders,
    body: JSON.stringify({ localId: '1' }),
  });
  let body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error, 'inbound_delete_disabled');
  assert.equal(harness.orders.length, 1);

  response = await fetch(`${harness.base}/api/integration/v1/orders/batch`, {
    method: 'POST',
    headers: harness.partnerHeaders,
    body: JSON.stringify({ orders: [{ type: 'order.delete', localId: '1', externalId: 'protected-delete-1' }] }),
  });
  body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].code, 'INBOUND_DELETE_DISABLED');
  assert.equal(harness.orders.length, 1);
});

test('DELETE refuses conflicting localId and externalId instead of deleting either order', async t => {
  const initial = [
    validOrder(1, { integration: { partnerOrderId: 'delete-external-1' } }),
    validOrder(2, { integration: { partnerOrderId: 'delete-external-2' } }),
  ];
  const harness = await createHarness(t, initial);
  const before = JSON.parse(JSON.stringify(harness.orders));
  const response = await fetch(`${harness.base}/api/integration/v1/orders/delete-external-2`, {
    method: 'DELETE',
    headers: harness.partnerHeaders,
    body: JSON.stringify({ localId: '1' }),
  });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(body, { ok: false, deleted: false, error: 'identity_binding_conflict' });
  assert.deepEqual(harness.orders, before);
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

test('inbound final PATCH supersedes a stale in-flight outbox event and converges on the next flush', async t => {
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let pushCalls = 0;
  let remoteStatus = 'new';
  const partnerApp = express();
  partnerApp.use(express.json());
  partnerApp.post('/bridge', async (req, res) => {
    const events = req.body?.events || [];
    if (events.length) {
      pushCalls++;
      remoteStatus = events.at(-1).order.status;
      if (pushCalls === 1) {
        markFirstStarted();
        await firstGate;
      }
    }
    res.json({ ok: true, results: events.map(event => ({ eventId: event.eventId, ok: true })) });
  });
  const partner = await listen(partnerApp);
  t.after(() => partner.server.close());
  const integrationLink = { partnerOrderId: 'inflight-final-1' };
  const harness = await createHarness(t, [validOrder(1, { integration: integrationLink })], `${partner.base}/bridge`);
  harness.applyLocal([validOrder(1, {
    managerComment: 'Queued local edit',
    updatedAt: '2026-07-16T08:30:00.000Z',
    integration: integrationLink,
  })]);
  let state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  const staleEventId = state.pending[0].eventId;
  assert.equal(state.pending[0].order.status, 'new');

  const firstFlush = harness.integration.flushPending(true);
  await firstStarted;
  const patchResponse = await fetch(`${harness.base}/api/integration/v1/orders/1`, {
    method: 'PATCH',
    headers: { ...harness.partnerHeaders, 'Idempotency-Key': 'inflight-confirm-1' },
    body: JSON.stringify({
      localId: '1',
      externalId: 'inflight-final-1',
      status: 'confirmed',
      updatedAt: '2026-07-16T09:00:00.000Z',
    }),
  });
  assert.equal(patchResponse.status, 200);
  assert.equal(harness.orders[0].status, 'confirmed');
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.pending.length, 1);
  assert.notEqual(state.pending[0].eventId, staleEventId);
  assert.equal(state.pending[0].order.status, 'confirmed');

  releaseFirst();
  await firstFlush;
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].order.status, 'confirmed');
  assert.notEqual(state.pending[0].eventId, staleEventId);

  const secondFlush = await harness.integration.flushPending(true);
  assert.equal(secondFlush.sent, 1);
  assert.equal(remoteStatus, 'confirmed');
  assert.equal(harness.orders[0].status, 'confirmed');
  state = JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'));
  assert.equal(state.pending.length, 0);
});

test('automatic full sync does not backfill or delete missing historical orders by default', async t => {
  const receivedEvents = [];
  const partnerApp = express();
  partnerApp.use(express.json());
  partnerApp.post('/bridge', (req, res) => {
    if (req.body?.action === 'list') {
      return res.json({
        ok: true,
        orders: [{
          ...validOrder(999, { integration: undefined }),
          localId: '999',
          externalId: 'remote-only-999',
        }],
      });
    }
    receivedEvents.push(...(req.body?.events || []));
    return res.json({
      ok: true,
      results: (req.body?.events || []).map(event => ({ eventId: event.eventId, ok: true })),
    });
  });
  const partner = await listen(partnerApp);
  t.after(() => partner.server.close());
  const local = validOrder(1, { integration: { partnerOrderId: 'local-only-1' } });
  const harness = await createHarness(t, [local], `${partner.base}/bridge`);
  const before = JSON.parse(JSON.stringify(harness.orders));

  const result = await harness.integration.runFullSync();
  assert.equal(result.applied.imported, 0);
  assert.equal(result.applied.deleted, 0);
  assert.equal(result.applied.results[0].action, 'missing_skipped_no_backfill');
  assert.equal(result.queuedMissing, 0);
  assert.equal(receivedEvents.length, 0);
  assert.deepEqual(harness.orders, before);
});

test('equal-time final Universal status upgrades local no_answer and is never pushed back', async t => {
  const receivedEvents = [];
  const remoteOrder = {
    ...validOrder(1, { status: 'confirmed' }),
    localId: '1',
    externalId: 'equal-time-final-1',
  };
  const partnerApp = express();
  partnerApp.use(express.json());
  partnerApp.post('/bridge', (req, res) => {
    if (req.body?.action === 'list') return res.json({ ok: true, orders: [remoteOrder] });
    receivedEvents.push(...(req.body?.events || []));
    return res.json({
      ok: true,
      results: (req.body?.events || []).map(event => ({ eventId: event.eventId, ok: true })),
    });
  });
  const partner = await listen(partnerApp);
  t.after(() => partner.server.close());
  const harness = await createHarness(t, [validOrder(1, {
    status: 'no_answer',
    integration: { partnerOrderId: 'equal-time-final-1' },
  })], `${partner.base}/bridge`);

  const result = await harness.integration.runFullSync();
  assert.equal(result.applied.applied, 1);
  assert.equal(harness.orders[0].status, 'confirmed');
  assert.equal(receivedEvents.length, 0);
  assert.equal(result.reconciliation.statusMismatches, 0);
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
