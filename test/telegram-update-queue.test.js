'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyedTaskQueue, updateChatId } = require('../telegram-update-queue');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('serializes tasks for one chat in arrival order', async () => {
  const queue = createKeyedTaskQueue();
  const gate = deferred();
  const events = [];

  const first = queue.enqueue(10, async () => {
    events.push('first:start');
    await gate.promise;
    events.push('first:end');
  });
  const second = queue.enqueue(10, async () => {
    events.push('second');
  });

  await nextTurn();
  assert.deepEqual(events, ['first:start']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
  assert.equal(queue.size(), 0);
});

test('runs different chats concurrently', async () => {
  const queue = createKeyedTaskQueue();
  const gate = deferred();
  const started = [];

  const one = queue.enqueue(1, async () => {
    started.push(1);
    await gate.promise;
  });
  const two = queue.enqueue(2, async () => {
    started.push(2);
    await gate.promise;
  });

  await nextTurn();
  assert.deepEqual(started.sort(), [1, 2]);
  gate.resolve();
  await Promise.all([one, two]);
});

test('reports a rejection once and continues the same chat queue', async () => {
  const errors = [];
  const events = [];
  const queue = createKeyedTaskQueue({
    onError: async (error, context) => errors.push([error.message, context]),
  });

  const failed = queue.enqueue('chat', async () => {
    events.push('failed');
    throw new Error('boom');
  }, { kind: 'message' });
  const next = queue.enqueue('chat', async () => {
    events.push('next');
  });

  await Promise.all([failed, next]);
  assert.deepEqual(events, ['failed', 'next']);
  assert.deepEqual(errors, [['boom', { kind: 'message' }]]);
});

test('onIdle waits for all active chat queues', async () => {
  const queue = createKeyedTaskQueue();
  const gate = deferred();
  let idle = false;
  queue.enqueue(1, () => gate.promise);
  const waiting = queue.onIdle().then(() => { idle = true; });

  await nextTurn();
  assert.equal(idle, false);
  gate.resolve();
  await waiting;
  assert.equal(idle, true);
});

test('extracts a stable queue key from Telegram message and callback shapes', () => {
  assert.equal(updateChatId({ chat: { id: 11 } }), 11);
  assert.equal(updateChatId({ message: { chat: { id: 12 } } }), 12);
  assert.equal(updateChatId({ callback_query: { message: { chat: { id: 13 } } } }), 13);
  assert.equal(updateChatId({ callback_query: { from: { id: 14 } } }), 14);
  assert.equal(updateChatId({ from: { id: 15 } }), 15);
  assert.equal(updateChatId({}), null);
});
