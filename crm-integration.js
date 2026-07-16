'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ORDER_FIELDS = [
  'name', 'phone', 'product', 'size', 'color', 'price', 'status',
  'paymentStatus', 'deliveryStatus', 'fullName', 'city', 'district',
  'postOffice', 'ttn', 'managerComment',
];
const STRING_FIELDS = new Set(ORDER_FIELDS.filter(field => field !== 'price'));
const VALID_STATUSES = new Set([
  'new', 'no_answer', 'confirmed', 'cancelled', 'shipped', 'paid',
  'returned', 'completed',
]);
const MAX_BATCH = 200;
const MAX_HISTORY = 100;

function safeString(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function asIsoDate(value, fallback = null) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : fallback;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createCrmIntegration({
  app,
  stateFile,
  readOrders,
  persistOrders,
  adminAuth,
  onOrderStatusChanged = () => {},
  logger = console,
}) {
  const apiKey = String(process.env.PARTNER_CRM_API_KEY || '').trim();
  const partnerUrl = String(process.env.PARTNER_CRM_URL || '').trim();
  const autoSync = process.env.PARTNER_CRM_AUTO_SYNC !== 'false';
  const intervalMinutes = Math.max(1, Number(process.env.PARTNER_CRM_SYNC_INTERVAL_MINUTES || 5));
  const requestTimeoutMs = Math.max(3000, Number(process.env.PARTNER_CRM_TIMEOUT_MS || 15000));
  let flushTimer = null;
  let flushPromise = null;

  function emptyState() {
    return {
      version: 1,
      pending: [],
      history: [],
      lastPushAt: null,
      lastPullAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastReconciliation: null,
    };
  }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return emptyState();
      return {
        ...emptyState(),
        ...parsed,
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch {
      return emptyState();
    }
  }

  function writeState(state) {
    const tmp = `${stateFile}.tmp`;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, stateFile);
  }

  function publicOrder(order) {
    const result = {
      localId: String(order.id),
      externalId: safeString(order?.integration?.partnerOrderId, 200) || null,
      createdAt: asIsoDate(order.createdAt),
      updatedAt: asIsoDate(order.updatedAt || order.createdAt),
    };
    for (const field of ORDER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(order, field)) result[field] = order[field];
      else result[field] = null;
    }
    result.syncHash = stableHash(ORDER_FIELDS.reduce((acc, field) => {
      acc[field] = result[field];
      return acc;
    }, {}));
    return result;
  }

  function comparableOrder(order) {
    const view = publicOrder(order);
    return ORDER_FIELDS.reduce((acc, field) => {
      const value = view[field];
      acc[field] = value == null ? '' : String(value).trim();
      return acc;
    }, {});
  }

  function normalizeRemotePatch(input = {}) {
    const patch = {};
    for (const field of ORDER_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
      if (field === 'price') {
        const value = Number(input[field]);
        patch[field] = Number.isFinite(value) ? value : null;
      } else if (STRING_FIELDS.has(field)) {
        patch[field] = safeString(input[field], field === 'managerComment' ? 1000 : 300);
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'status') && !VALID_STATUSES.has(patch.status)) {
      const error = new Error(`Unsupported status: ${patch.status}`);
      error.code = 'INVALID_STATUS';
      throw error;
    }
    return patch;
  }

  function findLocalOrder(orders, input = {}, externalId = '') {
    const localId = Number(input.localId || input.violetId || 0);
    if (localId) {
      const byId = orders.find(order => Number(order.id) === localId);
      if (byId) return byId;
    }
    const partnerId = safeString(input.externalId || input.partnerOrderId || externalId, 200);
    if (!partnerId) return null;
    return orders.find(order => safeString(order?.integration?.partnerOrderId, 200) === partnerId) || null;
  }

  function upsertRemoteOrder(input = {}, externalId = '') {
    const orders = readOrders();
    const existing = findLocalOrder(orders, input, externalId);
    const partnerId = safeString(input.externalId || input.partnerOrderId || externalId, 200);
    const patch = normalizeRemotePatch(input);
    const suppliedRemoteTime = asIsoDate(input.updatedAt || input.sourceUpdatedAt);
    const remoteUpdatedAt = suppliedRemoteTime || new Date().toISOString();
    const now = new Date().toISOString();
    let saved;
    let created = false;

    if (existing && suppliedRemoteTime) {
      const localTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
      const remoteTime = new Date(suppliedRemoteTime).getTime();
      if (Number.isFinite(localTime) && localTime > remoteTime) {
        return { order: publicOrder(existing), created: false, staleIgnored: true };
      }
    }

    if (existing) {
      const idx = orders.findIndex(order => Number(order.id) === Number(existing.id));
      saved = {
        ...existing,
        ...patch,
        id: existing.id,
        updatedAt: remoteUpdatedAt,
        integration: {
          ...(existing.integration && typeof existing.integration === 'object' ? existing.integration : {}),
          partnerOrderId: partnerId || existing?.integration?.partnerOrderId || null,
          partnerUpdatedAt: remoteUpdatedAt,
          lastReceivedAt: now,
        },
      };
      orders[idx] = saved;
    } else {
      const nextId = orders.length ? Math.max(...orders.map(order => Number(order.id) || 0)) + 1 : 1;
      saved = {
        id: nextId,
        name: '',
        phone: '',
        size: '',
        status: 'new',
        ...patch,
        createdAt: asIsoDate(input.createdAt, now),
        updatedAt: remoteUpdatedAt,
        integration: {
          partnerOrderId: partnerId || `partner-${crypto.randomUUID()}`,
          partnerUpdatedAt: remoteUpdatedAt,
          lastReceivedAt: now,
        },
      };
      orders.push(saved);
      created = true;
    }

    persistOrders(orders, { suppressPartnerSync: true, source: 'partner' });
    if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
      Promise.resolve(onOrderStatusChanged(saved)).catch(error => logger.error('[CRM sync notice]', error.message));
    }
    return { order: publicOrder(saved), created };
  }

  function queueItem(state, type, order) {
    const localId = String(order.localId || order.id || '');
    if (!localId) return;
    const key = `${type}:${localId}`;
    state.pending = state.pending.filter(item => item.key !== key && !(type === 'delete' && item.localId === localId));
    state.pending.push({
      key,
      eventId: crypto.randomUUID(),
      type,
      localId,
      order: type === 'order.upsert' ? order : { localId },
      queuedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    });
    if (state.pending.length > 5000) state.pending = state.pending.slice(-5000);
  }

  function scheduleFlush(delayMs = 300) {
    if (!partnerUrl || !autoSync) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushPending(false).catch(error => logger.error('[CRM sync push]', error.message));
    }, delayMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function onOrdersChanged(previous = [], current = [], options = {}) {
    if (options.suppressPartnerSync) return;
    const before = new Map(previous.map(order => [String(order.id), order]));
    const after = new Map(current.map(order => [String(order.id), order]));
    const state = readState();
    let changed = false;

    for (const [id, order] of after.entries()) {
      const old = before.get(id);
      if (!old || stableHash(comparableOrder(old)) !== stableHash(comparableOrder(order))) {
        queueItem(state, 'order.upsert', publicOrder(order));
        changed = true;
      }
    }
    for (const [id] of before.entries()) {
      if (!after.has(id)) {
        queueItem(state, 'order.delete', { localId: id });
        changed = true;
      }
    }
    if (changed) {
      writeState(state);
      scheduleFlush();
    }
  }

  async function fetchPartner(body) {
    if (!partnerUrl) throw new Error('PARTNER_CRM_URL is not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(partnerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ...body, apiKey }),
        signal: controller.signal,
        redirect: 'follow',
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
      if (!response.ok || data?.ok === false || data?.error) {
        throw new Error(data?.error || `Partner CRM returned HTTP ${response.status}`);
      }
      return data || {};
    } finally {
      clearTimeout(timeout);
    }
  }

  async function flushPending(force = false) {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      const state = readState();
      if (!partnerUrl) return { configured: false, sent: 0, pending: state.pending.length };
      let sent = 0;
      const now = Date.now();
      const due = state.pending.filter(item => force || Number(item.nextAttemptAt || 0) <= now).slice(0, MAX_BATCH);
      if (due.length) {
        try {
          await fetchPartner({
            action: 'events',
            events: due.map(item => ({
              eventId: item.eventId,
              type: item.type,
              source: 'violet-motion',
              sentAt: new Date().toISOString(),
              order: item.order,
            })),
          });
          const sentIds = new Set(due.map(item => item.eventId));
          state.pending = state.pending.filter(entry => !sentIds.has(entry.eventId));
          due.forEach(item => state.history.push({
            eventId: item.eventId,
            type: item.type,
            localId: item.localId,
            ok: true,
            at: new Date().toISOString(),
          }));
          state.lastPushAt = new Date().toISOString();
          state.lastSuccessAt = state.lastPushAt;
          state.lastError = null;
          sent += due.length;
        } catch (error) {
          due.forEach(item => {
            const entry = state.pending.find(candidate => candidate.eventId === item.eventId);
            if (entry) {
              entry.attempts = Number(entry.attempts || 0) + 1;
              entry.lastError = error.message;
              entry.nextAttemptAt = Date.now() + Math.min(60 * 60 * 1000, 5000 * (2 ** Math.min(entry.attempts, 8)));
            }
            state.history.push({ eventId: item.eventId, type: item.type, localId: item.localId, ok: false, error: error.message, at: new Date().toISOString() });
          });
          state.lastError = error.message;
        }
        state.history = state.history.slice(-MAX_HISTORY);
        writeState(state);
      }
      return { configured: true, sent, attempted: due.length, pending: state.pending.length, lastError: state.lastError };
    })();
    try {
      return await flushPromise;
    } finally {
      flushPromise = null;
    }
  }

  function compareSnapshots(remoteOrders = []) {
    const localOrders = readOrders();
    const matchedLocalIds = new Set();
    const missingLocal = [];
    const mismatches = [];

    for (const remote of remoteOrders) {
      const local = findLocalOrder(localOrders, remote, remote.externalId);
      if (!local) {
        missingLocal.push({
          externalId: safeString(remote.externalId || remote.partnerOrderId, 200) || null,
          localId: safeString(remote.localId || remote.violetId, 50) || null,
          name: safeString(remote.name, 200),
        });
        continue;
      }
      matchedLocalIds.add(String(local.id));
      const localComparable = comparableOrder(local);
      const remoteComparable = comparableOrder({ id: local.id, ...remote });
      const fields = ORDER_FIELDS.filter(field => localComparable[field] !== remoteComparable[field]);
      if (fields.length) {
        mismatches.push({
          localId: String(local.id),
          externalId: safeString(remote.externalId || remote.partnerOrderId, 200) || null,
          fields,
          localStatus: local.status || 'new',
          remoteStatus: remote.status || 'new',
          localUpdatedAt: asIsoDate(local.updatedAt || local.createdAt),
          remoteUpdatedAt: asIsoDate(remote.updatedAt || remote.sourceUpdatedAt),
        });
      }
    }

    const missingRemote = localOrders
      .filter(order => !matchedLocalIds.has(String(order.id)))
      .map(order => ({ localId: String(order.id), name: order.name || '', status: order.status || 'new' }));
    return {
      checkedAt: new Date().toISOString(),
      localCount: localOrders.length,
      remoteCount: remoteOrders.length,
      matched: matchedLocalIds.size,
      missingLocal,
      missingRemote,
      mismatches,
      statusMismatches: mismatches.filter(item => item.fields.includes('status')).length,
      ok: missingLocal.length === 0 && missingRemote.length === 0 && mismatches.length === 0,
    };
  }

  function applyRemoteNewer(remoteOrders = []) {
    let applied = 0;
    let imported = 0;
    for (const remote of remoteOrders) {
      const orders = readOrders();
      const local = findLocalOrder(orders, remote, remote.externalId);
      if (!local) {
        const missingId = String(remote.localId || remote.violetId || '');
        const pendingDelete = readState().pending.some(item => item.type === 'order.delete' && item.localId === missingId);
        if (!pendingDelete && (remote.externalId || !missingId)) {
          upsertRemoteOrder(remote, remote.externalId);
          imported++;
        }
        continue;
      }
      const remoteTime = new Date(remote.updatedAt || remote.sourceUpdatedAt || 0).getTime();
      const localTime = new Date(local.updatedAt || local.createdAt || 0).getTime();
      if (!Number.isFinite(remoteTime) || remoteTime <= localTime) continue;
      const fields = ORDER_FIELDS.filter(field => {
        if (!Object.prototype.hasOwnProperty.call(remote, field)) return false;
        return String(local[field] == null ? '' : local[field]).trim() !== String(remote[field] == null ? '' : remote[field]).trim();
      });
      if (!fields.length) continue;
      upsertRemoteOrder(remote, remote.externalId);
      applied++;
    }
    return { applied, imported };
  }

  function queueMissingRemote(reconciliation) {
    if (!reconciliation.missingRemote.length) return 0;
    const orders = readOrders();
    const ids = new Set(reconciliation.missingRemote.map(item => String(item.localId)));
    const state = readState();
    let queued = 0;
    for (const order of orders) {
      if (!ids.has(String(order.id))) continue;
      queueItem(state, 'order.upsert', publicOrder(order));
      queued++;
    }
    if (queued) writeState(state);
    return queued;
  }

  async function runFullSync() {
    const firstPush = await flushPending(true);
    if (!partnerUrl) return { configured: false, push: firstPush, reconciliation: null };
    const pulled = await fetchPartner({ action: 'list' });
    const remoteOrders = Array.isArray(pulled.orders) ? pulled.orders.slice(0, 10000) : [];
    const applied = applyRemoteNewer(remoteOrders);
    let reconciliation = compareSnapshots(remoteOrders);
    const queued = queueMissingRemote(reconciliation);
    const secondPush = queued ? await flushPending(true) : { sent: 0, pending: readState().pending.length };

    if (queued && secondPush.sent) {
      const refreshed = await fetchPartner({ action: 'list' });
      reconciliation = compareSnapshots(Array.isArray(refreshed.orders) ? refreshed.orders : remoteOrders);
    }
    const state = readState();
    state.lastPullAt = new Date().toISOString();
    state.lastSuccessAt = state.lastPullAt;
    state.lastError = null;
    state.lastReconciliation = reconciliation;
    writeState(state);
    return { configured: true, push: firstPush, applied, queued, secondPush, reconciliation };
  }

  function authPartner(req, res, next) {
    if (!apiKey) return res.status(503).json({ error: 'Partner CRM integration is not configured' });
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const supplied = req.headers['x-api-key'] || bearer || req.body?.apiKey;
    if (!safeEqual(supplied, apiKey)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }

  function statusPayload() {
    const state = readState();
    const failed = state.pending.filter(item => item.lastError);
    return {
      enabled: !!apiKey,
      outboundConfigured: !!partnerUrl,
      autoSync,
      pending: state.pending.length,
      failed: failed.length,
      lastError: state.lastError,
      lastPushAt: state.lastPushAt,
      lastPullAt: state.lastPullAt,
      lastSuccessAt: state.lastSuccessAt,
      lastReconciliation: state.lastReconciliation,
    };
  }

  app.get('/api/integration/v1/health', authPartner, (_req, res) => {
    res.json({ ok: true, service: 'violet-motion-crm', version: 1, time: new Date().toISOString() });
  });
  app.get('/api/integration/v1/orders', authPartner, (req, res) => {
    const since = new Date(req.query.updatedSince || 0).getTime();
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
    const orders = readOrders()
      .filter(order => !since || new Date(order.updatedAt || order.createdAt || 0).getTime() > since)
      .sort((a, b) => new Date(a.updatedAt || a.createdAt || 0) - new Date(b.updatedAt || b.createdAt || 0))
      .slice(0, limit)
      .map(publicOrder);
    res.json({ ok: true, orders, count: orders.length });
  });
  app.post('/api/integration/v1/orders/batch', authPartner, (req, res) => {
    const items = Array.isArray(req.body?.orders) ? req.body.orders.slice(0, MAX_BATCH) : null;
    if (!items) return res.status(400).json({ error: 'orders must be an array' });
    const results = [];
    try {
      for (const item of items) results.push(upsertRemoteOrder(item, item.externalId));
      res.json({ ok: true, processed: results.length, results });
    } catch (error) {
      res.status(error.code === 'INVALID_STATUS' ? 422 : 400).json({ error: error.message, processed: results.length });
    }
  });
  app.post('/api/integration/v1/reconcile', authPartner, (req, res) => {
    const items = Array.isArray(req.body?.orders) ? req.body.orders.slice(0, 10000) : null;
    if (!items) return res.status(400).json({ error: 'orders must be an array' });
    const applied = req.body?.applyRemoteNewer === true ? applyRemoteNewer(items) : { applied: 0, imported: 0 };
    const reconciliation = compareSnapshots(items);
    const state = readState();
    state.lastReconciliation = reconciliation;
    state.lastPullAt = new Date().toISOString();
    writeState(state);
    res.json({ ok: reconciliation.ok, applied, reconciliation });
  });
  app.get('/api/integration/v1/orders/:id', authPartner, (req, res) => {
    const orders = readOrders();
    const order = findLocalOrder(orders, { localId: req.params.id }, req.params.id);
    order ? res.json({ ok: true, order: publicOrder(order) }) : res.status(404).json({ error: 'Not found' });
  });
  app.put('/api/integration/v1/orders/:externalId', authPartner, (req, res) => {
    try {
      const result = upsertRemoteOrder(req.body || {}, req.params.externalId);
      res.status(result.created ? 201 : 200).json({ ok: true, ...result });
    } catch (error) {
      res.status(error.code === 'INVALID_STATUS' ? 422 : 400).json({ error: error.message });
    }
  });
  app.patch('/api/integration/v1/orders/:externalId', authPartner, (req, res) => {
    try {
      const result = upsertRemoteOrder(req.body || {}, req.params.externalId);
      res.status(result.created ? 201 : 200).json({ ok: true, ...result });
    } catch (error) {
      res.status(error.code === 'INVALID_STATUS' ? 422 : 400).json({ error: error.message });
    }
  });

  app.get('/api/admin/crm-sync/status', adminAuth, (_req, res) => res.json(statusPayload()));
  app.get('/api/admin/crm-sync/problems', adminAuth, (_req, res) => {
    const state = readState();
    res.json({
      pendingFailures: state.pending.filter(item => item.lastError).map(item => ({
        localId: item.localId,
        type: item.type,
        attempts: item.attempts,
        error: item.lastError,
      })),
      reconciliation: state.lastReconciliation,
    });
  });
  app.post('/api/admin/crm-sync/run', adminAuth, async (_req, res) => {
    try {
      res.json(await runFullSync());
    } catch (error) {
      const state = readState();
      state.lastError = error.message;
      writeState(state);
      res.status(502).json({ error: error.message, status: statusPayload() });
    }
  });

  if (autoSync && partnerUrl) {
    const startup = setTimeout(() => runFullSync().catch(error => logger.error('[CRM sync startup]', error.message)), 20000);
    if (startup.unref) startup.unref();
    const interval = setInterval(() => runFullSync().catch(error => logger.error('[CRM sync interval]', error.message)), intervalMinutes * 60 * 1000);
    if (interval.unref) interval.unref();
  }

  return { onOrdersChanged, flushPending, runFullSync, status: statusPayload, publicOrder };
}

module.exports = { createCrmIntegration, ORDER_FIELDS, VALID_STATUSES };
