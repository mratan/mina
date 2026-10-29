// One dialog at a time across every mina extension. Pi has one dialog slot: a select/confirm/input/editor opened while
// another is shown hides the first without settling it, and the hidden one's countdown later closes whichever dialog is
// on screen, whose promise then never settles (2026-10-28: two parallel mina_sandbox_request calls hung a turn).
// The lock lives on globalThis so every extension and module copy shares it. It is reentrant: a flow that holds it
// (select, then the editor view, then select again) opens its later dialogs directly instead of waiting for itself.
import { AsyncLocalStorage } from 'node:async_hooks';

const KEY = Symbol.for('mina:dialog-lock');
const lock = (globalThis[KEY] ??= { owner: null, waiters: [], held: new AsyncLocalStorage() });

// Runs fn when no other mina dialog is open. Returns undefined, without running fn, if signal aborts first.
export async function oneDialog(fn, signal) {
  if (lock.owner && lock.held.getStore() === lock.owner) return fn();   // a stale context from an ended flow does not match
  if (signal?.aborted) return undefined;
  if (lock.owner) {
    const turn = await new Promise((resolve) => {
      const onAbort = () => { const i = lock.waiters.indexOf(waiter); if (i >= 0) lock.waiters.splice(i, 1); resolve(false); };
      const waiter = () => { signal?.removeEventListener('abort', onAbort); resolve(true); };
      lock.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (!turn) return undefined;
  }
  const owner = {};
  lock.owner = owner;
  try { return await lock.held.run(owner, fn); } finally {
    const next = lock.waiters.shift();
    lock.owner = next ? {} : null;                                      // handed over: taken until the next flow starts
    next?.();
  }
}

const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);

// ctx with each dialog method taken through the lock, for code mina does not own (pi-goal's /goal handler).
export function serialUi(ctx) {
  if (!ctx) return ctx;
  return new Proxy(ctx, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'ui' || !value) return value;
      return new Proxy(value, {
        get(ui, name) {
          const method = Reflect.get(ui, name);
          if (typeof method !== 'function') return method;
          return DIALOGS.has(name) ? (...args) => oneDialog(() => method.apply(ui, args)) : method.bind(ui);
        },
      });
    },
  });
}
