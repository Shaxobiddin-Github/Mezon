import { AsyncLocalStorage } from 'node:async_hooks';
import type { UuidV7 } from '@mezon/domain';

/**
 * T4.2 (variant B): which cash register the current operation runs on. `null` is the hub's own
 * register; a LAN terminal's register is its terminal id. The hub enters the scope once per HTTP
 * request (from the authenticated terminal id, never from the body); repositories read it when
 * they pick the open shift and stamp `register_id` on shifts, cashier sessions and cash moves.
 */
const registerScope = new AsyncLocalStorage<UuidV7 | null>();

export function runInRegisterScope<T>(registerId: UuidV7 | null, fn: () => T): T {
  return registerScope.run(registerId, fn);
}

export function currentRegisterId(): UuidV7 | null {
  return registerScope.getStore() ?? null;
}
