'use strict';

const { isDeepStrictEqual } = require('node:util');

// Fields written from Nova Poshta responses. Customer/CRM fields are deliberately
// absent: an async NP request must never replay an old full order snapshot over a
// newer CRM edit.
const NP_ORDER_FIELDS = new Set([
  'ttn',
  'ttnHistory',
  'ttnCreatedAt',
  'deliveryStatus',
  'status',
  'shippedAt',
  'paymentStatus',
  'settlementStatus',
  'returnExpected',
  'returnSettlementStatus',
  'returnScope',
  'returnedAt',
  'manualTtnAutoLinked',
  'manualTtnAutoLinkedAt',
  'novaPoshta',
]);

function isNpOrderField(field) {
  return NP_ORDER_FIELDS.has(field) || field.startsWith('np');
}

function changedNpFields(base = {}, computed = {}) {
  return Object.keys(computed).filter(field => (
    field !== 'id'
    && field !== 'updatedAt'
    && isNpOrderField(field)
    && !isDeepStrictEqual(base[field], computed[field])
  ));
}

/**
 * Three-way merge of asynchronous Nova Poshta results.
 *
 * `base` is the order used for the external request, `computed` is the result of
 * that request, and `latest` is re-read immediately before persistence. Only NP
 * fields changed by the request are considered. A field concurrently changed
 * away from `base` wins and is reported as a conflict for a later retry.
 */
function mergeNovaPoshtaOrder(base, latest, computed, now) {
  const merged = { ...latest };
  const appliedFields = [];
  const conflictFields = [];

  for (const field of changedNpFields(base, computed)) {
    if (isDeepStrictEqual(latest[field], computed[field])) continue;
    if (!isDeepStrictEqual(latest[field], base[field])) {
      conflictFields.push(field);
      continue;
    }
    merged[field] = computed[field];
    appliedFields.push(field);
  }

  if (appliedFields.length) merged.updatedAt = now;
  return { order: merged, appliedFields, conflictFields };
}

function mergeNovaPoshtaOrders(latestOrders = [], changes = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const orders = latestOrders.slice();
  const changedOrderIds = [];
  const conflicts = [];
  const missingIds = [];

  for (const change of changes) {
    const base = change?.base;
    const computed = change?.computed;
    const id = String(base?.id ?? computed?.id ?? '');
    if (!id || String(computed?.id ?? '') !== id) {
      throw new TypeError('Nova Poshta merge requires matching stable order IDs');
    }

    const index = orders.findIndex(order => String(order?.id ?? '') === id);
    if (index < 0) {
      missingIds.push(id);
      continue;
    }

    const result = mergeNovaPoshtaOrder(base, orders[index], computed, now);
    if (result.appliedFields.length) {
      orders[index] = result.order;
      changedOrderIds.push(id);
    }
    if (result.conflictFields.length) {
      conflicts.push({ id, fields: result.conflictFields });
    }
  }

  return { orders, changedOrderIds, conflicts, missingIds };
}

module.exports = {
  NP_ORDER_FIELDS,
  changedNpFields,
  mergeNovaPoshtaOrder,
  mergeNovaPoshtaOrders,
};
