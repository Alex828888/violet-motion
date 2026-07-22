'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeNovaPoshtaOrders } = require('../np-order-merge');

test('Nova Poshta merge preserves concurrent CRM fields, status, and newly created orders', () => {
  const base = {
    id: 577,
    name: 'Original client',
    city: '',
    status: 'confirmed',
    deliveryStatus: 'ttn_created',
    ttn: '20450000000001',
    npStatus: 'Created',
    novaPoshta: { ref: 'base-ref' },
    updatedAt: '2026-07-22T10:00:00.000Z',
  };
  const computed = {
    ...base,
    status: 'shipped',
    deliveryStatus: 'in_transit',
    npStatus: 'Moving',
    novaPoshta: { ...base.novaPoshta, tracking: { statusCode: '5' } },
    updatedAt: '2026-07-22T10:00:05.000Z',
  };
  const latest = {
    ...base,
    name: 'CRM client name',
    city: 'Kyiv',
    status: 'cancelled',
    managerComment: 'Changed while NP request was in flight',
    updatedAt: '2026-07-22T10:00:03.000Z',
  };
  const concurrentNewOrder = {
    id: 578,
    name: 'New client',
    status: 'new',
    updatedAt: '2026-07-22T10:00:04.000Z',
  };

  const result = mergeNovaPoshtaOrders(
    [latest, concurrentNewOrder],
    [{ base, computed }],
    { now: '2026-07-22T10:00:06.000Z' },
  );

  assert.equal(result.orders.length, 2);
  assert.deepEqual(result.orders[1], concurrentNewOrder);
  assert.equal(result.orders[0].name, 'CRM client name');
  assert.equal(result.orders[0].city, 'Kyiv');
  assert.equal(result.orders[0].managerComment, 'Changed while NP request was in flight');
  assert.equal(result.orders[0].status, 'cancelled');
  assert.equal(result.orders[0].deliveryStatus, 'in_transit');
  assert.equal(result.orders[0].npStatus, 'Moving');
  assert.deepEqual(result.orders[0].novaPoshta.tracking, { statusCode: '5' });
  assert.equal(result.orders[0].updatedAt, '2026-07-22T10:00:06.000Z');
  assert.deepEqual(result.changedOrderIds, ['577']);
  assert.deepEqual(result.conflicts, [{ id: '577', fields: ['status'] }]);
  assert.deepEqual(result.missingIds, []);
});

test('Nova Poshta merge applies an uncontested status but never recreates a concurrently deleted order', () => {
  const base = { id: 10, status: 'confirmed', npStatus: 'Created', updatedAt: '2026-07-22T10:00:00.000Z' };
  const computed = { ...base, status: 'shipped', npStatus: 'Moving', updatedAt: '2026-07-22T10:00:01.000Z' };

  const applied = mergeNovaPoshtaOrders([base], [{ base, computed }], { now: '2026-07-22T10:00:02.000Z' });
  assert.equal(applied.orders[0].status, 'shipped');
  assert.equal(applied.orders[0].npStatus, 'Moving');

  const deleted = mergeNovaPoshtaOrders([], [{ base, computed }], { now: '2026-07-22T10:00:02.000Z' });
  assert.deepEqual(deleted.orders, []);
  assert.deepEqual(deleted.changedOrderIds, []);
  assert.deepEqual(deleted.missingIds, ['10']);
});
