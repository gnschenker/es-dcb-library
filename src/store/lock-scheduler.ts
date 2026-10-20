/** Per-store lock scheduler. Not part of the public API. */
export type LockScheduler = (
  pairCount: number,
  acquireNext: () => Promise<void>,
) => Promise<void>;

const schedulers = new WeakMap<object, LockScheduler>();

export function setLockScheduler(store: object, scheduler: LockScheduler): void {
  schedulers.set(store, scheduler);
}

export function getLockScheduler(store: object): LockScheduler | undefined {
  return schedulers.get(store);
}
