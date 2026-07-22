'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ORDER_FIELDS = [
  'name', 'phone', 'product', 'variant', 'size', 'color', 'quantity', 'price', 'status',
  'paymentStatus', 'deliveryStatus', 'fullName', 'city', 'district',
  'postOffice', 'ttn', 'managerComment',
];
const NUMBER_FIELDS = new Set(['price', 'quantity']);
const STRING_FIELDS = new Set(ORDER_FIELDS.filter(field => !NUMBER_FIELDS.has(field)));
const VALID_STATUSES = new Set([
  'new', 'no_answer', 'confirmed', 'cancelled', 'shipped', 'paid',
  'returned', 'completed',
]);
const MAX_BATCH = 200;
const MAX_HISTORY = 100;
const MAX_RETRY_ATTEMPTS = 8;
const MAX_DEAD_LETTER = 1000;
const MAX_QUARANTINE = 500;
const MAX_TOMBSTONES = 5000;
const MAX_IDEMPOTENCY_RECORDS = 2000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 300;
const REQUIRED_REMOTE_CREATE_FIELDS = ['name', 'phone', 'size'];
const UNIVERSAL_PATCH_STATUSES = new Set(['confirmed', 'cancelled']);
const UNIVERSAL_PENDING_STATUSES = new Set(['new', 'no_answer']);

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

function safeErrorMessage(value) {
  return safeString(value, 500)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-number]');
}

function boundedPartnerResponse(value) {
  if (value == null) return null;
  try {
    const json = JSON.stringify(value, (key, item) => {
      if (/api.?key|authorization|bearer|secret|token/i.test(key)) return '[redacted-secret]';
      if (/^(phone|email|name|fullName)$/i.test(key)) {
        if (key.toLowerCase() === 'phone') {
          const digits = String(item || '').replace(/\D/g, '');
          return digits ? `***${digits.slice(-4)}` : '';
        }
        return item ? '[redacted-personal-data]' : '';
      }
      return typeof item === 'string' ? safeErrorMessage(item).slice(0, 500) : item;
    });
    return String(json || '').slice(0, 1500) || null;
  } catch {
    return safeErrorMessage(String(value)).slice(0, 1500) || null;
  }
}

function sanitizedOrderSnapshot(order = {}) {
  const phoneDigits = String(order.phone || '').replace(/\D/g, '');
  return {
    localId: safeString(order.localId || order.violetId || order.id, 50) || null,
    externalId: safeString(order.externalId || order.partnerOrderId || order?.integration?.partnerOrderId, 200) || null,
    status: safeString(order.status, 50) || null,
    name: safeString(order.name, 200) ? '[present]' : '[empty]',
    phone: phoneDigits ? `***${phoneDigits.slice(-4)}` : '[empty]',
    product: safeString(order.product, 150) || null,
    variant: safeString(order.variant || order.productVariant, 100) || null,
    size: safeString(order.size, 50) || null,
    color: safeString(order.color, 50) || null,
    quantity: Number.isFinite(Number(order.quantity)) ? Number(order.quantity) : null,
    createdAt: safeString(order.createdAt, 50) || null,
    updatedAt: safeString(order.updatedAt || order.sourceUpdatedAt, 50) || null,
  };
}

function createCrmIntegration({
  app,
  stateFile,
  readOrders,
  persistOrders,
  adminAuth,
  onOrderStatusChanged = () => {},
  logger = console,
  stateWriter = null,
}) {
  const asyncHandler = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const apiKey = String(process.env.PARTNER_CRM_API_KEY || '').trim();
  const partnerUrl = String(process.env.PARTNER_CRM_URL || '').trim();
  const autoSync = process.env.PARTNER_CRM_AUTO_SYNC !== 'false';
  const allowBackfill = process.env.PARTNER_CRM_ALLOW_BACKFILL === 'true';
  const allowInboundDelete = process.env.PARTNER_CRM_ALLOW_INBOUND_DELETE === 'true';
  const intervalMinutes = Math.max(1, Number(process.env.PARTNER_CRM_SYNC_INTERVAL_MINUTES || 5));
  const requestTimeoutMs = Math.max(3000, Number(process.env.PARTNER_CRM_TIMEOUT_MS || 15000));
  let flushTimer = null;
  let flushPromise = null;
  let fullSyncPromise = null;
  let lastValidStateRaw = null;

  function emptyState() {
    return {
      version: 3,
      pending: [],
      deadLetter: [],
      history: [],
      tombstones: [],
      quarantine: [],
      idempotency: [],
      syncErrors: [],
      lastPushAt: null,
      lastPullAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastReconciliation: null,
    };
  }

  function normalizeState(parsed) {
    if (Array.isArray(parsed) && parsed.length === 0) return emptyState();
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      const error = new Error('CRM sync state has an invalid shape');
      error.code = 'CRM_STATE_INVALID';
      throw error;
    }
    return {
        ...emptyState(),
        ...parsed,
        version: 3,
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        deadLetter: Array.isArray(parsed.deadLetter) ? parsed.deadLetter : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
        quarantine: Array.isArray(parsed.quarantine) ? parsed.quarantine : [],
        idempotency: Array.isArray(parsed.idempotency) ? parsed.idempotency : [],
        syncErrors: Array.isArray(parsed.syncErrors) ? parsed.syncErrors : [],
    };
  }

  function readState() {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const state = normalizeState(JSON.parse(raw));
      lastValidStateRaw = JSON.stringify(state);
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      if (lastValidStateRaw != null) return normalizeState(JSON.parse(lastValidStateRaw));
      try {
        const backupRaw = fs.readFileSync(`${stateFile}.bak`, 'utf8');
        const backup = normalizeState(JSON.parse(backupRaw));
        lastValidStateRaw = JSON.stringify(backup);
        logger.error('[CRM state] primary state is unreadable; using validated backup');
        return backup;
      } catch {
        const stateError = new Error('CRM sync state is unreadable and no valid backup is available');
        stateError.code = 'CRM_STATE_UNREADABLE';
        throw stateError;
      }
    }
  }

  function writeState(state) {
    if (typeof stateWriter === 'function') {
      const result = stateWriter(state);
      lastValidStateRaw = JSON.stringify(state);
      return result;
    }
    const tmp = `${stateFile}.tmp`;
    const backup = `${stateFile}.bak`;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    if (fs.existsSync(stateFile)) {
      try {
        normalizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
        fs.copyFileSync(stateFile, backup);
      } catch {}
    }
    const raw = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmp, raw, 'utf8');
    fs.renameSync(tmp, stateFile);
    lastValidStateRaw = JSON.stringify(state);
  }

  function safeError(error, fallbackCode = 'SYNC_ERROR') {
    return {
      code: safeString(error?.code || fallbackCode, 80),
      message: safeErrorMessage(error?.message || String(error || 'Unknown sync error')),
      httpStatus: Number.isFinite(Number(error?.httpStatus)) ? Number(error.httpStatus) : null,
      partnerResponse: boundedPartnerResponse(error?.partnerResponse),
    };
  }

  function recordSyncError(state, error, context = {}) {
    const safe = safeError(error);
    const item = {
      at: new Date().toISOString(),
      operation: safeString(context.operation || 'sync', 80),
      eventId: safeString(context.eventId, 100) || null,
      localId: safeString(context.localId, 50) || null,
      externalId: safeString(context.externalId, 200) || null,
      code: safe.code,
      message: safe.message,
      httpStatus: safe.httpStatus,
      order: context.order ? sanitizedOrderSnapshot(context.order) : null,
      partnerResponse: boundedPartnerResponse(context.partnerResponse) || safe.partnerResponse,
    };
    state.syncErrors.push(item);
    state.syncErrors = state.syncErrors.slice(-MAX_HISTORY);
    state.lastError = item.message;
    logger.error('[CRM sync]', JSON.stringify(item));
    return item;
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
      if (NUMBER_FIELDS.has(field)) {
        const value = Number(input[field]);
        if (field === 'quantity') patch[field] = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : null;
        else patch[field] = Number.isFinite(value) ? value : null;
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

  function remoteIdentity(input = {}, fallbackExternalId = '') {
    return {
      localId: safeString(input.localId || input.violetId || input.id, 50) || null,
      externalId: safeString(
        input.externalId || input.partnerOrderId || input?.integration?.partnerOrderId || fallbackExternalId,
        200,
      ) || null,
    };
  }

  function remoteFingerprint(input = {}, fallbackExternalId = '') {
    const identity = remoteIdentity(input, fallbackExternalId);
    const snapshot = { identity, createdAt: input.createdAt || null, updatedAt: input.updatedAt || input.sourceUpdatedAt || null };
    for (const field of ORDER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, field)) snapshot[field] = input[field];
    }
    return stableHash(snapshot);
  }

  function validationError(message, code = 'REMOTE_VALIDATION_FAILED') {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function validateRemoteCreate(input = {}, fallbackExternalId = '') {
    const identity = remoteIdentity(input, fallbackExternalId);
    if (!identity.localId && !identity.externalId) {
      throw validationError('Remote order has no stable localId or externalId', 'REMOTE_ID_REQUIRED');
    }
    const missing = REQUIRED_REMOTE_CREATE_FIELDS.filter(field => !safeString(input[field], 300));
    if (missing.length) {
      throw validationError(`Remote order is missing required fields: ${missing.join(', ')}`, 'REMOTE_REQUIRED_FIELDS');
    }
    const createdSupplied = input.createdAt != null && String(input.createdAt).trim() !== '';
    const updatedValue = input.updatedAt || input.sourceUpdatedAt;
    const updatedSupplied = updatedValue != null && String(updatedValue).trim() !== '';
    const createdAt = createdSupplied ? asIsoDate(input.createdAt) : null;
    const updatedAt = updatedSupplied ? asIsoDate(updatedValue) : null;
    if (createdSupplied && !createdAt) throw validationError('Remote order has invalid createdAt', 'REMOTE_INVALID_DATE');
    if (updatedSupplied && !updatedAt) throw validationError('Remote order has invalid updatedAt', 'REMOTE_INVALID_DATE');
    if (createdAt && updatedAt && new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
      throw validationError('Remote order updatedAt is earlier than createdAt', 'REMOTE_INVALID_DATE_ORDER');
    }
  }

  function validateRemoteUpdate(input = {}, existing = {}) {
    const blank = REQUIRED_REMOTE_CREATE_FIELDS.filter(field => (
      Object.prototype.hasOwnProperty.call(input, field) && !safeString(input[field], 300)
    ));
    if (blank.length) {
      throw validationError(`Remote order explicitly blanks required fields: ${blank.join(', ')}`, 'REMOTE_REQUIRED_FIELDS');
    }
    const createdSupplied = input.createdAt != null && String(input.createdAt).trim() !== '';
    const updatedValue = input.updatedAt || input.sourceUpdatedAt;
    const updatedSupplied = updatedValue != null && String(updatedValue).trim() !== '';
    const createdAt = createdSupplied ? asIsoDate(input.createdAt) : asIsoDate(existing.createdAt);
    const updatedAt = updatedSupplied ? asIsoDate(updatedValue) : null;
    if (createdSupplied && !createdAt) throw validationError('Remote order has invalid createdAt', 'REMOTE_INVALID_DATE');
    if (updatedSupplied && !updatedAt) throw validationError('Remote order has invalid updatedAt', 'REMOTE_INVALID_DATE');
    if (createdAt && updatedAt && new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
      throw validationError('Remote order updatedAt is earlier than createdAt', 'REMOTE_INVALID_DATE_ORDER');
    }
  }

  function tombstoneMatches(tombstone, input = {}, fallbackExternalId = '') {
    const identity = remoteIdentity(input, fallbackExternalId);
    return !!(
      (identity.localId && tombstone.localId && identity.localId === tombstone.localId)
      || (identity.externalId && tombstone.externalId && identity.externalId === tombstone.externalId)
    );
  }

  function findTombstone(state, input = {}, fallbackExternalId = '') {
    return state.tombstones.find(item => tombstoneMatches(item, input, fallbackExternalId)) || null;
  }

  function addTombstone(state, input = {}, fallbackExternalId = '', reason = 'deleted') {
    const identity = remoteIdentity(input, fallbackExternalId);
    if (!identity.localId && !identity.externalId) return null;
    const existing = findTombstone(state, input, fallbackExternalId);
    const entry = {
      localId: identity.localId,
      externalId: identity.externalId,
      deletedAt: new Date().toISOString(),
      reason: safeString(reason, 100),
    };
    if (existing) Object.assign(existing, entry, {
      localId: identity.localId || existing.localId,
      externalId: identity.externalId || existing.externalId,
    });
    else state.tombstones.push(entry);
    state.tombstones = state.tombstones.slice(-MAX_TOMBSTONES);
    return existing || entry;
  }

  function removeMatchingTombstones(state, input = {}, fallbackExternalId = '') {
    state.tombstones = state.tombstones.filter(item => !tombstoneMatches(item, input, fallbackExternalId));
  }

  function quarantineRemote(state, input = {}, error, operation = 'pull') {
    const identity = remoteIdentity(input);
    const fingerprint = remoteFingerprint(input);
    const safe = safeError(error, 'REMOTE_QUARANTINED');
    let entry = state.quarantine.find(item => item.fingerprint === fingerprint);
    const isNew = !entry;
    if (entry) {
      entry.lastSeenAt = new Date().toISOString();
      entry.seenCount = Number(entry.seenCount || 1) + 1;
      entry.code = safe.code;
      entry.reason = safe.message;
    } else {
      entry = {
        fingerprint,
        localId: identity.localId,
        externalId: identity.externalId,
        code: safe.code,
        reason: safe.message,
        operation: safeString(operation, 80),
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        seenCount: 1,
      };
      state.quarantine.push(entry);
      state.quarantine = state.quarantine.slice(-MAX_QUARANTINE);
    }
    if (isNew) recordSyncError(state, error, { operation, ...identity, order: input });
    return entry;
  }

  function clearQuarantineForIdentity(state, input = {}, fallbackExternalId = '') {
    const identity = remoteIdentity(input, fallbackExternalId);
    state.quarantine = state.quarantine.filter(item => !(
      (identity.localId && item.localId === identity.localId)
      || (identity.externalId && item.externalId === identity.externalId)
    ));
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

  function findLocalOrdersById(orders, localId) {
    const wanted = safeString(localId, 50);
    if (!wanted) return [];
    return orders.filter(order => safeString(order?.id, 50) === wanted);
  }

  function findOrdersByExternalId(orders, externalId) {
    const wanted = safeString(externalId, 200);
    if (!wanted) return [];
    return orders.filter(order => safeString(order?.integration?.partnerOrderId, 200) === wanted);
  }

  function identityConflict(message, code) {
    const error = new Error(message);
    error.code = code;
    error.httpStatus = 409;
    return error;
  }

  function assertExternalBinding(orders, target, requestedExternalId = '') {
    const requested = safeString(requestedExternalId, 200);
    const current = safeString(target?.integration?.partnerOrderId, 200);
    const targetId = safeString(target?.id, 50);
    const effective = requested || current;

    if (requested && current && requested !== current) {
      throw identityConflict('Existing externalId binding cannot be changed', 'EXTERNAL_ID_REBIND_FORBIDDEN');
    }
    if (!effective) return;
    const owners = findOrdersByExternalId(orders, effective);
    if (owners.length > 1 || owners.some(order => safeString(order?.id, 50) !== targetId)) {
      throw identityConflict('externalId is already bound to another order', 'EXTERNAL_ID_CONFLICT');
    }
  }

  function identityConflictCounts(orders = readOrders()) {
    const localIds = new Map();
    const externalIds = new Map();
    for (const order of orders) {
      const localId = safeString(order?.id, 50);
      const externalId = safeString(order?.integration?.partnerOrderId, 200);
      if (localId) localIds.set(localId, Number(localIds.get(localId) || 0) + 1);
      if (externalId) externalIds.set(externalId, Number(externalIds.get(externalId) || 0) + 1);
    }
    return {
      localId: [...localIds.values()].filter(count => count > 1).length,
      externalId: [...externalIds.values()].filter(count => count > 1).length,
    };
  }

  function patchResponseOrder(order) {
    const view = publicOrder(order);
    return {
      localId: view.localId,
      externalId: view.externalId,
      status: view.status,
      updatedAt: view.updatedAt,
    };
  }

  function patchRequestHash(localId, input, patch, externalId) {
    const createdAt = input.createdAt == null ? null : String(input.createdAt);
    const updatedValue = input.updatedAt ?? input.sourceUpdatedAt;
    const updatedAt = updatedValue == null ? null : String(updatedValue);
    return stableHash({
      operation: 'universal_order_patch',
      localId: safeString(localId, 50),
      bodyLocalId: remoteIdentity(input).localId,
      externalId: safeString(externalId, 200) || null,
      createdAt,
      updatedAt,
      patch,
    });
  }

  function readIdempotencyReplay(state, idempotencyKey, requestHash) {
    const rawKey = String(idempotencyKey == null ? '' : idempotencyKey).trim();
    if (!rawKey) return null;
    if (rawKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      const error = validationError('Idempotency-Key is too long', 'IDEMPOTENCY_KEY_TOO_LONG');
      error.httpStatus = 400;
      throw error;
    }
    const keyHash = stableHash({ key: rawKey });
    const existing = state.idempotency.find(item => item.keyHash === keyHash);
    if (!existing) return { keyHash, replay: null };
    if (existing.requestHash !== requestHash) {
      throw identityConflict('Idempotency-Key was already used for another request', 'IDEMPOTENCY_KEY_REUSED');
    }
    return {
      keyHash,
      replay: {
        statusCode: Number(existing.statusCode) || 200,
        body: JSON.parse(JSON.stringify(existing.response)),
      },
    };
  }

  function rememberIdempotency(state, keyHash, requestHash, statusCode, response) {
    if (!keyHash) return;
    state.idempotency.push({
      keyHash,
      requestHash,
      statusCode,
      response: JSON.parse(JSON.stringify(response)),
      createdAt: new Date().toISOString(),
    });
    state.idempotency = state.idempotency.slice(-MAX_IDEMPOTENCY_RECORDS);
  }

  function supersedeOrderOutbox(state, localId, order) {
    const wanted = safeString(localId, 50);
    const found = state.pending.some(item => item.localId === wanted)
      || state.deadLetter.some(item => item.localId === wanted);
    if (!found) return false;
    state.pending = state.pending.filter(item => item.localId !== wanted);
    state.deadLetter = state.deadLetter.filter(item => item.localId !== wanted);
    queueItem(state, 'order.upsert', publicOrder(order));
    return true;
  }

  function normalizedPhone(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 10 && digits.startsWith('0')) digits = `38${digits}`;
    if (digits.length === 11 && digits.startsWith('80')) digits = `3${digits}`;
    return digits;
  }

  function semanticNewFingerprint(order = {}) {
    const phone = normalizedPhone(order.phone);
    const product = safeString(order.product || process.env.PRODUCT_NAME || 'Violet Motion sneakers', 300).toLowerCase().replace(/\s+/g, ' ');
    const variant = safeString(order.variant || order.productVariant, 150).toLowerCase().replace(/\s+/g, ' ');
    const size = safeString(order.size, 100).toLowerCase();
    const color = safeString(order.color, 100).toLowerCase();
    const quantity = String(Math.max(1, Number(order.quantity) || 1));
    if (!phone) return '';
    return stableHash({ phone, product, variant, size, color, quantity });
  }

  function findSemanticNewLocal(orders, input = {}) {
    const remoteStatus = safeString(input.status || 'new', 50).toLowerCase();
    if (remoteStatus !== 'new') return null;
    const fingerprint = semanticNewFingerprint(input);
    if (!fingerprint) return null;
    return orders.find(order => safeString(order.status || 'new', 50).toLowerCase() === 'new'
      && semanticNewFingerprint(order) === fingerprint) || null;
  }

  function upsertRemoteOrder(input = {}, externalId = '') {
    const orders = readOrders();
    const identity = remoteIdentity(input, externalId);
    const localMatches = findLocalOrdersById(orders, identity.localId);
    const externalMatches = findOrdersByExternalId(orders, identity.externalId);
    if (localMatches.length > 1) {
      throw identityConflict('localId is not unique', 'LOCAL_ID_CONFLICT');
    }
    if (externalMatches.length > 1) {
      throw identityConflict('externalId is not unique', 'EXTERNAL_ID_CONFLICT');
    }
    const byLocalId = localMatches[0] || null;
    const byExternalId = externalMatches[0] || null;
    if (byLocalId && byExternalId && safeString(byLocalId.id, 50) !== safeString(byExternalId.id, 50)) {
      throw identityConflict('localId and externalId refer to different orders', 'IDENTITY_BINDING_CONFLICT');
    }
    const exactExisting = byLocalId || byExternalId;
    const existing = exactExisting || findSemanticNewLocal(orders, input);
    const partnerId = safeString(input.externalId || input.partnerOrderId || externalId, 200);
    if (existing) assertExternalBinding(orders, existing, partnerId);
    const state = readState();
    const tombstone = findTombstone(state, input, externalId);
    if (tombstone && input.forceRecreate !== true) {
      return { order: null, created: false, tombstoneIgnored: true, tombstone };
    }
    if (existing) validateRemoteUpdate(input, existing);
    else validateRemoteCreate(input, externalId);
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
        createdAt: asIsoDate(input.createdAt, suppliedRemoteTime || now),
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
    clearQuarantineForIdentity(state, input, externalId);
    if (input.forceRecreate === true) removeMatchingTombstones(state, input, externalId);
    writeState(state);
    if (Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== existing?.status) {
      Promise.resolve().then(() => onOrderStatusChanged(saved))
        .catch(error => logger.error('[CRM sync notice]', safeErrorMessage(error.message)));
    }
    return { order: publicOrder(saved), created };
  }

  function patchExistingRemoteOrder(localId, input = {}, idempotencyKey = '') {
    const pathLocalId = safeString(localId, 50);
    const patch = normalizeRemotePatch(input);
    if (Object.prototype.hasOwnProperty.call(patch, 'status') && !UNIVERSAL_PATCH_STATUSES.has(patch.status)) {
      throw validationError('Universal PATCH accepts only confirmed or cancelled', 'INVALID_STATUS');
    }

    const bodyIdentity = remoteIdentity(input);
    if (bodyIdentity.localId && bodyIdentity.localId !== pathLocalId) {
      throw identityConflict('Body localId does not match path localId', 'LOCAL_ID_MISMATCH');
    }
    const requestedExternalId = safeString(
      input.externalId || input.partnerOrderId || input?.integration?.partnerOrderId,
      200,
    );
    const requestHash = patchRequestHash(pathLocalId, input, patch, requestedExternalId);
    const state = readState();
    const idempotency = readIdempotencyReplay(state, idempotencyKey, requestHash);
    if (idempotency?.replay) return idempotency.replay;

    const orders = readOrders();
    const matches = findLocalOrdersById(orders, pathLocalId);
    if (!matches.length) {
      return {
        statusCode: 404,
        body: { ok: false, created: false, error: 'order_not_found' },
      };
    }
    if (matches.length > 1) {
      throw identityConflict('localId is not unique', 'LOCAL_ID_CONFLICT');
    }

    const existing = matches[0];
    assertExternalBinding(orders, existing, requestedExternalId);
    validateRemoteUpdate(input, existing);

    const suppliedRemoteTime = asIsoDate(input.updatedAt || input.sourceUpdatedAt);
    const localTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
    const remoteTime = suppliedRemoteTime ? new Date(suppliedRemoteTime).getTime() : null;
    if (Number.isFinite(localTime) && Number.isFinite(remoteTime) && remoteTime < localTime) {
      const response = {
        ok: true,
        created: false,
        staleIgnored: true,
        order: patchResponseOrder(existing),
      };
      if (idempotency?.keyHash) {
        rememberIdempotency(state, idempotency.keyHash, requestHash, 200, response);
        writeState(state);
      }
      return { statusCode: 200, body: response };
    }

    const changedFields = Object.keys(patch).filter(field => {
      if (NUMBER_FIELDS.has(field)) return Number(existing[field]) !== Number(patch[field]);
      return safeString(existing[field], field === 'managerComment' ? 1000 : 300) !== patch[field];
    });
    const currentExternalId = safeString(existing?.integration?.partnerOrderId, 200);
    const externalIdChanged = !!requestedExternalId && requestedExternalId !== currentExternalId;
    const timestampAdvanced = Number.isFinite(remoteTime) && (!Number.isFinite(localTime) || remoteTime > localTime);

    if (!changedFields.length && !externalIdChanged && !timestampAdvanced) {
      const response = { ok: true, created: false, order: patchResponseOrder(existing) };
      const supersededOutbox = supersedeOrderOutbox(state, pathLocalId, existing);
      if (idempotency?.keyHash) {
        rememberIdempotency(state, idempotency.keyHash, requestHash, 200, response);
      }
      if (idempotency?.keyHash || supersededOutbox) writeState(state);
      if (supersededOutbox) scheduleFlushAfterCurrent(100);
      return { statusCode: 200, body: response };
    }

    const now = new Date().toISOString();
    const saved = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: suppliedRemoteTime || now,
      integration: {
        ...(existing.integration && typeof existing.integration === 'object' ? existing.integration : {}),
        partnerOrderId: requestedExternalId || currentExternalId || null,
        partnerUpdatedAt: suppliedRemoteTime || now,
        lastReceivedAt: now,
      },
    };
    const response = { ok: true, created: false, order: patchResponseOrder(saved) };
    const nextOrders = orders.map(order => (
      safeString(order?.id, 50) === pathLocalId ? saved : order
    ));
    const previousQuarantineCount = state.quarantine.length;
    clearQuarantineForIdentity(state, { localId: pathLocalId, externalId: requestedExternalId });
    const supersededOutbox = supersedeOrderOutbox(state, pathLocalId, saved);
    if (idempotency?.keyHash) {
      rememberIdempotency(state, idempotency.keyHash, requestHash, 200, response);
    }

    persistOrders(nextOrders, { suppressPartnerSync: true, source: 'partner_patch' });
    try {
      if (idempotency?.keyHash || supersededOutbox || state.quarantine.length !== previousQuarantineCount) writeState(state);
    } catch (error) {
      try {
        persistOrders(orders, { suppressPartnerSync: true, source: 'partner_patch_rollback' });
      } catch (rollbackError) {
        logger.error('[CRM patch rollback]', safeErrorMessage(rollbackError.message));
      }
      throw error;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== existing.status) {
      Promise.resolve().then(() => onOrderStatusChanged(saved))
        .catch(error => logger.error('[CRM sync notice]', safeErrorMessage(error.message)));
    }
    if (supersededOutbox) scheduleFlushAfterCurrent(100);
    return { statusCode: 200, body: response };
  }

  function queueItem(state, type, order) {
    const localId = String(order.localId || order.id || '');
    if (!localId) return false;
    const key = `${type}:${localId}`;
    const existing = state.pending.find(item => item.key === key);
    if (type === 'order.upsert' && existing?.order?.syncHash === order.syncHash) return false;
    state.pending = state.pending.filter(item => {
      if (type === 'order.delete') return item.localId !== localId;
      return item.key !== key && !(item.type === 'order.delete' && item.localId === localId);
    });
    state.pending.push({
      key,
      eventId: crypto.randomUUID(),
      type,
      localId,
      order: type === 'order.upsert' ? order : {
        localId,
        externalId: safeString(order.externalId || order?.integration?.partnerOrderId, 200) || null,
        updatedAt: asIsoDate(order.updatedAt || order.createdAt, new Date().toISOString()),
      },
      queuedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    });
    if (state.pending.length > 5000) state.pending = state.pending.slice(-5000);
    return true;
  }

  function scheduleFlush(delayMs = 300) {
    if (!partnerUrl || !autoSync) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushPending(false).catch(error => logger.error('[CRM sync push]', safeErrorMessage(error.message)));
    }, delayMs);
    if (flushTimer.unref) flushTimer.unref();
  }

  function scheduleFlushAfterCurrent(delayMs = 300) {
    if (flushPromise) {
      flushPromise.finally(() => scheduleFlush(delayMs)).catch(() => {});
      return;
    }
    scheduleFlush(delayMs);
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
        if (!old) removeMatchingTombstones(state, order);
        const snapshot = publicOrder(order);
        try {
          validateRemoteCreate(snapshot, snapshot.externalId);
          changed = queueItem(state, 'order.upsert', snapshot) || changed;
        } catch (error) {
          quarantineRemote(state, snapshot, error, 'local_change_validation');
          changed = true;
        }
      }
    }
    for (const [id, oldOrder] of before.entries()) {
      if (!after.has(id)) {
        const snapshot = publicOrder(oldOrder);
        addTombstone(state, snapshot, snapshot.externalId, options.source === 'partner' ? 'partner_delete' : 'local_delete');
        changed = queueItem(state, 'order.delete', snapshot) || changed;
      }
    }
    if (changed) {
      writeState(state);
      scheduleFlush();
    }
  }

  function validateLocalExport(order) {
    const snapshot = publicOrder(order);
    validateRemoteCreate(snapshot, snapshot.externalId);
    return snapshot;
  }

  function exportableOrders() {
    return readOrders().filter(order => {
      try {
        validateLocalExport(order);
        return true;
      } catch {
        return false;
      }
    });
  }

  function quarantineInvalidLocalOrders() {
    const orders = readOrders();
    const state = readState();
    let quarantined = 0;
    let stateChanged = false;
    for (const order of orders) {
      try {
        validateLocalExport(order);
      } catch (error) {
        const snapshot = publicOrder(order);
        const known = state.quarantine.some(item => item.fingerprint === remoteFingerprint(snapshot, snapshot.externalId));
        quarantineRemote(state, snapshot, error, 'local_export_validation');
        quarantined++;
        stateChanged = true;
        if (known) state.lastError = state.lastError || safeError(error).message;
      }
    }
    if (stateChanged) writeState(state);
    return { removed: 0, quarantined };
  }

  async function fetchPartner(body) {
    if (!partnerUrl) {
      const error = new Error('PARTNER_CRM_URL is not configured');
      error.code = 'PARTNER_URL_MISSING';
      throw error;
    }
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
      if (data && typeof data === 'object') {
        Object.defineProperty(data, '__httpStatus', { value: response.status, enumerable: false });
      }
      const hasPerEventResults = Array.isArray(data?.results) || Array.isArray(data?.events) || Array.isArray(data?.outcomes);
      if (
        (!response.ok && !hasPerEventResults)
        || (data?.error && !hasPerEventResults)
        || (data?.ok === false && !hasPerEventResults)
        || (data?.success === false && !hasPerEventResults)
      ) {
        const remoteMessage = typeof data?.error === 'string'
          ? data.error
          : (typeof data?.message === 'string' ? data.message : '');
        const error = new Error(remoteMessage || `Partner CRM returned HTTP ${response.status}`);
        error.code = safeString(data?.code || `PARTNER_HTTP_${response.status}`, 80);
        error.httpStatus = response.status;
        error.partnerResponse = data;
        throw error;
      }
      return data || {};
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error(`Partner CRM request timed out after ${requestTimeoutMs}ms`);
        timeoutError.code = 'PARTNER_TIMEOUT';
        timeoutError.httpStatus = null;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function eventAcknowledgements(data, due) {
    const results = Array.isArray(data?.results)
      ? data.results
      : (Array.isArray(data?.events) ? data.events : (Array.isArray(data?.outcomes) ? data.outcomes : null));
    if (!results) return new Map(due.map(item => [item.eventId, {
      ok: false,
      error: 'Partner response did not include per-event acknowledgements',
      code: 'EVENT_ACKS_MISSING',
      partnerResponse: data,
    }]));
    const byId = new Map();
    results.forEach(result => {
      const eventId = safeString(result?.eventId || result?.id, 100);
      if (!eventId) return;
      const status = safeString(result?.status, 40).toLowerCase();
      const ok = result?.ok !== false
        && result?.success !== false
        && !result?.error
        && !['failed', 'error', 'rejected'].includes(status);
      const message = typeof result?.error === 'string'
        ? result.error
        : (typeof result?.message === 'string' ? result.message : (ok ? null : `Partner rejected event (${status || 'unknown'})`));
      byId.set(eventId, {
        ok,
        error: message,
        code: result?.code || null,
        httpStatus: result?.httpStatus || data?.__httpStatus || null,
        partnerResponse: result,
      });
    });
    for (const item of due) {
      if (!byId.has(item.eventId)) {
        byId.set(item.eventId, {
          ok: false,
          error: 'Partner did not acknowledge this event',
          code: 'EVENT_NOT_ACKNOWLEDGED',
          partnerResponse: data,
        });
      }
    }
    return byId;
  }

  function markEventFailure(state, item, error) {
    const safe = safeError(error, 'EVENT_DELIVERY_FAILED');
    const entry = state.pending.find(candidate => candidate.eventId === item.eventId);
    if (entry) {
      entry.attempts = Number(entry.attempts || 0) + 1;
      entry.lastError = safe.message;
      entry.lastErrorCode = safe.code;
      entry.lastAttemptAt = new Date().toISOString();
      entry.nextAttemptAt = Date.now() + Math.min(60 * 60 * 1000, 5000 * (2 ** Math.min(entry.attempts, MAX_RETRY_ATTEMPTS)));
      if (entry.attempts >= MAX_RETRY_ATTEMPTS) {
        state.pending = state.pending.filter(candidate => candidate.eventId !== entry.eventId);
        state.deadLetter.push({ ...entry, deadLetterAt: new Date().toISOString() });
        state.deadLetter = state.deadLetter.slice(-MAX_DEAD_LETTER);
      }
    }
    state.history.push({
      eventId: item.eventId,
      type: item.type,
      localId: item.localId,
      ok: false,
      code: safe.code,
      error: safe.message,
      at: new Date().toISOString(),
    });
    recordSyncError(state, error, {
      operation: 'push_event',
      eventId: item.eventId,
      localId: item.localId,
      externalId: item.order?.externalId,
      order: item.order,
      partnerResponse: error?.partnerResponse,
    });
  }

  async function flushPending(force = false) {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      const initialState = readState();
      if (!partnerUrl) return { configured: false, sent: 0, attempted: 0, pending: initialState.pending.length };
      const now = Date.now();
      const due = initialState.pending
        .filter(item => force || Number(item.nextAttemptAt || 0) <= now)
        .slice(0, MAX_BATCH);
      if (!due.length) {
        return {
          configured: true,
          sent: 0,
          failed: 0,
          deadLettered: 0,
          attempted: 0,
          pending: initialState.pending.length,
          lastError: initialState.lastError,
        };
      }

      let acknowledgements;
      let requestError = null;
      try {
        const response = await fetchPartner({
          action: 'events',
          events: due.map(item => ({
            eventId: item.eventId,
            type: item.type,
            source: 'violet-motion',
            sentAt: new Date().toISOString(),
            order: item.order,
          })),
        });
        acknowledgements = eventAcknowledgements(response, due);
      } catch (error) {
        requestError = error;
        acknowledgements = new Map(due.map(item => [item.eventId, {
          ok: false,
          error: error.message,
          code: error.code,
          httpStatus: error.httpStatus,
          partnerResponse: error.partnerResponse,
        }]));
      }

      // Re-read after the network request. Local order changes may have queued newer
      // events while the request was in flight; only the exact attempted event IDs
      // are acknowledged or retried below.
      const state = readState();
      let sent = 0;
      let failed = 0;
      let deadLettered = 0;
      for (const item of due) {
        const result = acknowledgements.get(item.eventId);
        if (result?.ok) {
          const wasPending = state.pending.some(candidate => candidate.eventId === item.eventId);
          state.pending = state.pending.filter(candidate => candidate.eventId !== item.eventId);
          if (item.type === 'order.delete') {
            clearQuarantineForIdentity(state, item.order, item.order?.externalId);
          }
          state.history.push({
            eventId: item.eventId,
            type: item.type,
            localId: item.localId,
            ok: true,
            at: new Date().toISOString(),
          });
          if (wasPending) sent++;
          continue;
        }

        failed++;
        const beforeDeadLetter = state.deadLetter.length;
        const eventError = new Error(result?.error || 'Partner rejected event');
        eventError.code = result?.code || requestError?.code || 'EVENT_DELIVERY_FAILED';
        eventError.httpStatus = result?.httpStatus || requestError?.httpStatus || null;
        eventError.partnerResponse = result?.partnerResponse || requestError?.partnerResponse || null;
        markEventFailure(state, item, eventError);
        if (state.deadLetter.length > beforeDeadLetter) deadLettered++;
      }

      state.history = state.history.slice(-MAX_HISTORY);
      if (sent) state.lastPushAt = new Date().toISOString();
      if (!failed) {
        state.lastSuccessAt = state.lastPushAt || new Date().toISOString();
        const unresolved = state.deadLetter.length
          || state.quarantine.length
          || state.pending.some(item => item.lastError);
        if (!unresolved) state.lastError = null;
      }
      writeState(state);
      return {
        configured: true,
        sent,
        failed,
        deadLettered,
        attempted: due.length,
        pending: state.pending.length,
        lastError: state.lastError,
      };
    })();
    try {
      return await flushPromise;
    } finally {
      flushPromise = null;
    }
  }

  function deleteRemoteOrder(input = {}, externalId = '', reason = 'partner_delete') {
    const orders = readOrders();
    const identity = remoteIdentity(input, externalId);
    const localMatches = findLocalOrdersById(orders, identity.localId);
    const externalMatches = findOrdersByExternalId(orders, identity.externalId);
    if (localMatches.length > 1) throw identityConflict('localId is not unique', 'LOCAL_ID_CONFLICT');
    if (externalMatches.length > 1) throw identityConflict('externalId is not unique', 'EXTERNAL_ID_CONFLICT');
    const byLocalId = localMatches[0] || null;
    const byExternalId = externalMatches[0] || null;
    if (byLocalId && byExternalId && safeString(byLocalId.id, 50) !== safeString(byExternalId.id, 50)) {
      throw identityConflict('localId and externalId refer to different orders', 'IDENTITY_BINDING_CONFLICT');
    }
    if (byLocalId && identity.externalId) {
      const currentExternalId = safeString(byLocalId?.integration?.partnerOrderId, 200);
      if (currentExternalId && currentExternalId !== identity.externalId) {
        throw identityConflict('externalId does not match the existing binding', 'IDENTITY_BINDING_CONFLICT');
      }
    }
    const existing = byLocalId || byExternalId;
    const state = readState();
    const identitySource = existing ? publicOrder(existing) : input;
    addTombstone(state, identitySource, externalId, reason);
    clearQuarantineForIdentity(state, input, externalId);
    if (existing) {
      const next = orders.filter(order => Number(order.id) !== Number(existing.id));
      persistOrders(next, { suppressPartnerSync: true, source: 'partner' });
    }
    writeState(state);
    return {
      deleted: true,
      existed: !!existing,
      localId: existing ? String(existing.id) : remoteIdentity(input, externalId).localId,
      externalId: remoteIdentity(identitySource, externalId).externalId,
    };
  }

  function remoteIsDelete(input = {}) {
    return input?.deleted === true
      || safeString(input?.type, 50).toLowerCase() === 'order.delete'
      || safeString(input?.action, 50).toLowerCase() === 'delete';
  }

  function comparisonRemoteOrders(remoteOrders = []) {
    const state = readState();
    const quarantinedFingerprints = new Set(state.quarantine.map(item => item.fingerprint));
    return remoteOrders.filter(remote => {
      if (!remote || typeof remote !== 'object' || remoteIsDelete(remote)) return false;
      if (findTombstone(state, remote, remote.externalId)) return false;
      if (quarantinedFingerprints.has(remoteFingerprint(remote, remote.externalId))) return false;
      return true;
    });
  }

  function compareSnapshots(remoteOrders = []) {
    remoteOrders = comparisonRemoteOrders(remoteOrders);
    const localOrders = exportableOrders();
    const matchedLocalIds = new Set();
    const missingLocal = [];
    const mismatches = [];

    for (const remote of remoteOrders) {
      const local = findLocalOrder(localOrders, remote, remote.externalId);
      if (!local) {
        missingLocal.push({
          externalId: safeString(remote.externalId || remote.partnerOrderId, 200) || null,
          localId: safeString(remote.localId || remote.violetId, 50) || null,
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
      .map(order => ({ localId: String(order.id), status: order.status || 'new' }));
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

  function applyRemoteNewer(remoteOrders = [], options = {}) {
    const allowMissing = options.allowMissing === true;
    const allowDeletes = options.allowDeletes === true;
    let applied = 0;
    let imported = 0;
    let deleted = 0;
    let staleIgnored = 0;
    let tombstoneIgnored = 0;
    let quarantined = 0;
    const results = [];
    for (const remote of remoteOrders) {
      const identity = remoteIdentity(remote, remote?.externalId);
      try {
        if (!remote || typeof remote !== 'object') throw validationError('Remote order must be an object', 'REMOTE_INVALID_PAYLOAD');
        if (remoteIsDelete(remote)) {
          if (!allowDeletes || !allowInboundDelete) {
            results.push({ ...identity, ok: true, action: 'delete_skipped_disabled' });
            continue;
          }
          const deletion = deleteRemoteOrder(remote, remote.externalId, 'partner_delete');
          if (deletion.existed) deleted++;
          results.push({ ...identity, ok: true, action: 'delete', existed: deletion.existed });
          continue;
        }

        const state = readState();
        if (findTombstone(state, remote, remote.externalId) && remote.forceRecreate !== true) {
          tombstoneIgnored++;
          results.push({ ...identity, ok: true, action: 'tombstone_ignored' });
          continue;
        }

        const orders = readOrders();
        const local = findLocalOrder(orders, remote, remote.externalId);
        if (!local) {
          if (!allowMissing) {
            results.push({ ...identity, ok: true, action: 'missing_skipped_no_backfill' });
            continue;
          }
          const result = upsertRemoteOrder(remote, remote.externalId);
          if (result.tombstoneIgnored) tombstoneIgnored++;
          else if (result.created) imported++;
          else applied++;
          results.push({
            ...identity,
            ok: true,
            action: result.tombstoneIgnored ? 'tombstone_ignored' : (result.created ? 'import' : 'semantic_merge'),
          });
          continue;
        }

        validateRemoteUpdate(remote, local);

        const updatedValue = remote.updatedAt || remote.sourceUpdatedAt;
        if (!updatedValue) {
          staleIgnored++;
          results.push({ ...identity, ok: true, action: 'no_timestamp_ignored' });
          continue;
        }
        const remoteTime = new Date(updatedValue).getTime();
        if (!Number.isFinite(remoteTime)) throw validationError('Remote order has invalid updatedAt', 'REMOTE_INVALID_DATE');
        const localTime = new Date(local.updatedAt || local.createdAt || 0).getTime();
        const finalStatusUpgrade = UNIVERSAL_PENDING_STATUSES.has(safeString(local.status || 'new', 50))
          && UNIVERSAL_PATCH_STATUSES.has(safeString(remote.status, 50));
        if (Number.isFinite(localTime) && (
          remoteTime < localTime || (remoteTime === localTime && !finalStatusUpgrade)
        )) {
          staleIgnored++;
          results.push({ ...identity, ok: true, action: 'stale_ignored' });
          continue;
        }
        const fields = ORDER_FIELDS.filter(field => {
          if (!Object.prototype.hasOwnProperty.call(remote, field)) return false;
          return String(local[field] == null ? '' : local[field]).trim() !== String(remote[field] == null ? '' : remote[field]).trim();
        });
        if (!fields.length) {
          staleIgnored++;
          results.push({ ...identity, ok: true, action: 'unchanged' });
          continue;
        }
        upsertRemoteOrder(remote, remote.externalId);
        applied++;
        results.push({ ...identity, ok: true, action: 'update', fields });
      } catch (error) {
        const state = readState();
        quarantineRemote(state, remote || {}, error, 'pull_order');
        writeState(state);
        quarantined++;
        results.push({ ...identity, ok: true, action: 'quarantined', code: safeError(error).code });
      }
    }
    return { applied, imported, deleted, staleIgnored, tombstoneIgnored, quarantined, results };
  }

  function queueMissingRemote(reconciliation) {
    if (!reconciliation.missingRemote.length) return 0;
    const orders = exportableOrders();
    const ids = new Set(reconciliation.missingRemote.map(item => String(item.localId)));
    const state = readState();
    let queued = 0;
    for (const order of orders) {
      if (!ids.has(String(order.id))) continue;
      if (state.pending.some(item => item.type === 'order.upsert' && item.localId === String(order.id))) continue;
      if (queueItem(state, 'order.upsert', publicOrder(order))) queued++;
    }
    if (queued) writeState(state);
    return queued;
  }

  function queueLocalNewerMismatches(reconciliation) {
    if (!reconciliation.mismatches.length) return { queued: 0, equalTimeTieBreaks: 0 };
    const orders = exportableOrders();
    const byId = new Map(orders.map(order => [String(order.id), order]));
    const state = readState();
    let queued = 0;
    let equalTimeTieBreaks = 0;
    for (const mismatch of reconciliation.mismatches) {
      const local = byId.get(String(mismatch.localId));
      if (!local) continue;
      if (UNIVERSAL_PENDING_STATUSES.has(safeString(local.status || 'new', 50))
        && UNIVERSAL_PATCH_STATUSES.has(safeString(mismatch.remoteStatus, 50))) {
        // Never downgrade a final Universal status back to new. A strictly older
        // remote timestamp stays visible as a reconciliation error until retried.
        continue;
      }
      const localTime = new Date(mismatch.localUpdatedAt || local.updatedAt || local.createdAt || 0).getTime();
      const remoteTime = new Date(mismatch.remoteUpdatedAt || 0).getTime();
      // A newer remote snapshot is handled by applyRemoteNewer. Remaining local-newer
      // rows are pushed back to the partner. Equal timestamps use Violet as a stable
      // tie-breaker and receive a fresh outbound timestamp so the two CRMs cannot
      // repeat the same equal-time mismatch forever.
      if (Number.isFinite(remoteTime) && Number.isFinite(localTime) && localTime < remoteTime) continue;
      if (state.pending.some(item => item.type === 'order.upsert' && item.localId === String(local.id))) continue;
      const snapshot = publicOrder(local);
      if (Number.isFinite(remoteTime) && Number.isFinite(localTime) && localTime === remoteTime) {
        snapshot.updatedAt = new Date().toISOString();
        equalTimeTieBreaks++;
      }
      if (queueItem(state, 'order.upsert', snapshot)) queued++;
    }
    if (queued) writeState(state);
    return { queued, equalTimeTieBreaks };
  }

  async function performFullSync(options = {}) {
    const forcePending = options === true || options?.forcePending === true;
    try {
      quarantineInvalidLocalOrders();
      const firstPush = await flushPending(forcePending);
      if (!partnerUrl) return { configured: false, push: firstPush, reconciliation: null };
      const pulled = await fetchPartner({ action: 'list' });
      const remoteOrders = Array.isArray(pulled.orders) ? pulled.orders.slice(0, 10000) : [];
      const applied = applyRemoteNewer(remoteOrders, {
        allowMissing: allowBackfill,
        allowDeletes: allowBackfill,
      });
      let reconciliation = compareSnapshots(remoteOrders);
      const queuedMissing = allowBackfill ? queueMissingRemote(reconciliation) : 0;
      const mismatchQueue = queueLocalNewerMismatches(reconciliation);
      const queuedMismatches = mismatchQueue.queued;
      const queued = queuedMissing + queuedMismatches;
      const secondPush = queued
        ? await flushPending(forcePending)
        : { sent: 0, failed: 0, pending: readState().pending.length };

      if (queued && secondPush.sent && !secondPush.failed) {
        const refreshed = await fetchPartner({ action: 'list' });
        reconciliation = compareSnapshots(Array.isArray(refreshed.orders) ? refreshed.orders : remoteOrders);
      }
      const state = readState();
      state.lastPullAt = new Date().toISOString();
      const transportSucceeded = !firstPush.failed && !secondPush.failed;
      if (transportSucceeded) state.lastSuccessAt = state.lastPullAt;
      if (transportSucceeded && !state.deadLetter.length && !state.quarantine.length) state.lastError = null;
      state.lastReconciliation = reconciliation;
      writeState(state);
      return {
        configured: true,
        push: firstPush,
        applied,
        queued,
        queuedMissing,
        queuedMismatches,
        equalTimeTieBreaks: mismatchQueue.equalTimeTieBreaks,
        secondPush,
        reconciliation,
        partial: !!(firstPush.failed || secondPush.failed || applied.quarantined),
      };
    } catch (error) {
      const state = readState();
      recordSyncError(state, error, { operation: 'full_sync' });
      writeState(state);
      throw error;
    }
  }

  function runFullSync(options = {}) {
    if (fullSyncPromise) return fullSyncPromise;
    fullSyncPromise = performFullSync(options);
    fullSyncPromise.finally(() => {
      fullSyncPromise = null;
    }).catch(() => {});
    return fullSyncPromise;
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
      allowBackfill,
      allowInboundDelete,
      pending: state.pending.length,
      failed: failed.length,
      deadLetter: state.deadLetter.length,
      quarantine: state.quarantine.length,
      tombstones: state.tombstones.length,
      idempotencyRecords: state.idempotency.length,
      identityConflicts: identityConflictCounts(),
      lastError: state.lastError,
      lastPushAt: state.lastPushAt,
      lastPullAt: state.lastPullAt,
      lastSuccessAt: state.lastSuccessAt,
      lastReconciliation: state.lastReconciliation,
      recentErrors: state.syncErrors.slice(-10),
    };
  }

  function inputErrorStatus(error) {
    if (Number.isFinite(Number(error?.httpStatus))) return Number(error.httpStatus);
    if (error?.code === 'INVALID_STATUS' || safeString(error?.code, 80).startsWith('REMOTE_')) return 422;
    return 500;
  }

  function publicPatchError(error) {
    const code = safeString(error?.code || 'PATCH_FAILED', 80).toLowerCase();
    const allowed = new Set([
      'external_id_conflict',
      'external_id_rebind_forbidden',
      'identity_binding_conflict',
      'idempotency_key_reused',
      'idempotency_key_too_long',
      'invalid_status',
      'local_id_conflict',
      'local_id_mismatch',
      'remote_invalid_date',
      'remote_invalid_date_order',
      'remote_required_fields',
    ]);
    return allowed.has(code) ? code : 'patch_failed';
  }

  function recordPatchError(error, localId, externalId = '') {
    try {
      const state = readState();
      recordSyncError(state, error, {
        operation: 'inbound_patch',
        localId: safeString(localId, 50) || null,
        externalId: safeString(externalId, 200) || null,
      });
      writeState(state);
    } catch (loggingError) {
      logger.error('[CRM patch logging]', safeErrorMessage(loggingError.message));
    }
  }

  const startupIdentityConflicts = identityConflictCounts();
  if (startupIdentityConflicts.localId || startupIdentityConflicts.externalId) {
    logger.warn('[CRM identity audit]', JSON.stringify(startupIdentityConflicts));
  }

  app.get('/api/integration/v1/health', authPartner, (_req, res) => {
    res.json({ ok: true, service: 'violet-motion-crm', version: 1, time: new Date().toISOString() });
  });
  app.get('/api/integration/v1/orders', authPartner, (req, res) => {
    quarantineInvalidLocalOrders();
    const since = new Date(req.query.updatedSince || 0).getTime();
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
    const orders = exportableOrders()
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
    let accepted = 0;
    let quarantined = 0;
    for (const item of items) {
      const identity = remoteIdentity(item, item?.externalId);
      if (remoteIsDelete(item) && !allowInboundDelete) {
        results.push({ ...identity, ok: false, code: 'INBOUND_DELETE_DISABLED' });
        continue;
      }
      try {
        const result = remoteIsDelete(item)
          ? deleteRemoteOrder(item, item.externalId, 'partner_batch_delete')
          : upsertRemoteOrder(item, item.externalId);
        accepted++;
        results.push({ ...result, ...identity, ok: true });
      } catch (error) {
        const state = readState();
        quarantineRemote(state, item || {}, error, 'inbound_batch');
        writeState(state);
        quarantined++;
        results.push({ ...identity, ok: true, quarantined: true, code: safeError(error).code });
      }
    }
    // Invalid rows are durably quarantined and acknowledged individually, so a
    // poison record cannot keep the sender's cursor stuck on the whole batch.
    res.json({ ok: true, processed: items.length, accepted, quarantined, results });
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
    const orders = exportableOrders();
    const order = findLocalOrder(orders, { localId: req.params.id }, req.params.id);
    order ? res.json({ ok: true, order: publicOrder(order) }) : res.status(404).json({ error: 'Not found' });
  });
  app.put('/api/integration/v1/orders/:externalId', authPartner, (req, res) => {
    try {
      const result = upsertRemoteOrder(req.body || {}, req.params.externalId);
      res.status(result.created ? 201 : 200).json({ ok: true, ...result });
    } catch (error) {
      res.status(inputErrorStatus(error)).json({ error: error.message, code: error.code || 'INVALID_ORDER' });
    }
  });
  app.patch('/api/integration/v1/orders/:localId', authPartner, (req, res) => {
    const externalId = safeString(
      req.body?.externalId || req.body?.partnerOrderId || req.body?.integration?.partnerOrderId,
      200,
    );
    try {
      const result = patchExistingRemoteOrder(
        req.params.localId,
        req.body || {},
        req.headers['idempotency-key'],
      );
      if (result.statusCode >= 400) {
        const error = validationError('Order was not found for inbound PATCH', 'ORDER_NOT_FOUND');
        error.httpStatus = result.statusCode;
        recordPatchError(error, req.params.localId, externalId);
      }
      res.status(result.statusCode).json(result.body);
    } catch (error) {
      recordPatchError(error, req.params.localId, externalId);
      res.status(inputErrorStatus(error)).json({
        ok: false,
        created: false,
        error: publicPatchError(error),
      });
    }
  });
  app.delete('/api/integration/v1/orders/:externalId', authPartner, (req, res) => {
    if (!allowInboundDelete) {
      return res.status(403).json({ ok: false, deleted: false, error: 'inbound_delete_disabled' });
    }
    try {
      const result = deleteRemoteOrder(req.body || {}, req.params.externalId, 'partner_api_delete');
      res.json({ ok: true, ...result });
    } catch (error) {
      recordPatchError(error, req.body?.localId, req.params.externalId);
      res.status(inputErrorStatus(error)).json({
        ok: false,
        deleted: false,
        error: publicPatchError(error),
      });
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
      deadLetter: state.deadLetter.map(item => ({
        eventId: item.eventId,
        localId: item.localId,
        type: item.type,
        attempts: item.attempts,
        error: item.lastError,
        deadLetterAt: item.deadLetterAt,
      })),
      quarantine: state.quarantine,
      recentErrors: state.syncErrors.slice(-25),
      reconciliation: state.lastReconciliation,
    });
  });
  app.post('/api/admin/crm-sync/retry', adminAuth, (req, res) => {
    const requestedId = safeString(req.body?.eventId, 100);
    const state = readState();
    const retryable = requestedId
      ? state.deadLetter.filter(item => item.eventId === requestedId)
      : state.deadLetter.slice();
    for (const item of retryable) {
      state.pending = state.pending.filter(candidate => candidate.key !== item.key);
      state.pending.push({
        ...item,
        eventId: crypto.randomUUID(),
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        lastErrorCode: null,
        retriedFromEventId: item.eventId,
        queuedAt: new Date().toISOString(),
      });
    }
    const retriedIds = new Set(retryable.map(item => item.eventId));
    state.deadLetter = state.deadLetter.filter(item => !retriedIds.has(item.eventId));
    writeState(state);
    if (retryable.length) scheduleFlush(100);
    res.json({ ok: true, retried: retryable.length, pending: state.pending.length, deadLetter: state.deadLetter.length });
  });
  app.post('/api/admin/crm-sync/run', adminAuth, asyncHandler(async (req, res) => {
    try {
      res.json(await runFullSync({ forcePending: req.body?.forcePending === true }));
    } catch (error) {
      const state = readState();
      state.lastError = safeErrorMessage(error.message);
      writeState(state);
      res.status(502).json({ error: safeErrorMessage(error.message), status: statusPayload() });
    }
  }));

  if (autoSync && partnerUrl) {
    const startup = setTimeout(() => runFullSync().catch(error => logger.error('[CRM sync startup]', safeErrorMessage(error.message))), 20000);
    if (startup.unref) startup.unref();
    const interval = setInterval(() => runFullSync().catch(error => logger.error('[CRM sync interval]', safeErrorMessage(error.message))), intervalMinutes * 60 * 1000);
    if (interval.unref) interval.unref();
  }

  return { onOrdersChanged, flushPending, runFullSync, status: statusPayload, publicOrder };
}

module.exports = { createCrmIntegration, ORDER_FIELDS, VALID_STATUSES };
