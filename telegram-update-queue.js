'use strict';

function updateChatId(update) {
  return update?.chat?.id
    ?? update?.message?.chat?.id
    ?? update?.callback_query?.message?.chat?.id
    ?? update?.callback_query?.from?.id
    ?? update?.from?.id
    ?? null;
}

function createKeyedTaskQueue({ onError = null } = {}) {
  const tails = new Map();

  function enqueue(key, task, context = null) {
    if (typeof task !== 'function') throw new TypeError('task must be a function');

    const queueKey = key == null ? '__unknown_chat__' : String(key);
    const previous = tails.get(queueKey) || Promise.resolve();
    const running = previous.then(() => task());
    const settled = running.catch(async error => {
      if (typeof onError !== 'function') return undefined;
      try {
        await onError(error, context);
      } catch (reportError) {
        console.error('[telegram update error reporter]', reportError?.message || reportError);
      }
      return undefined;
    });

    tails.set(queueKey, settled);
    void settled.then(() => {
      if (tails.get(queueKey) === settled) tails.delete(queueKey);
    });
    return settled;
  }

  async function onIdle() {
    while (tails.size > 0) {
      await Promise.all([...tails.values()]);
    }
  }

  return {
    enqueue,
    onIdle,
    size: () => tails.size,
  };
}

module.exports = {
  createKeyedTaskQueue,
  updateChatId,
};
