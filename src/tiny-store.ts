import { useCallback, useSyncExternalStore } from "react";

type Listener = () => void;

export interface StoreApi<T> {
  get: () => T;
  set: (patch: Partial<T> | ((state: T) => Partial<T>)) => void;
  subscribe: (listener: Listener) => () => void;
}

export type StoreHook<T> = {
  <U>(selector: (state: T) => U): U;
  getState: () => T;
  setState: StoreApi<T>["set"];
};

/** 极简 zustand 风格 store：可调用 hook + useSyncExternalStore，无额外依赖。 */
export function create<T extends object>(
  initializer: (set: StoreApi<T>["set"], get: () => T) => T,
): StoreHook<T> {
  let state: T;
  const listeners = new Set<Listener>();

  const set: StoreApi<T>["set"] = (patch) => {
    const next = typeof patch === "function" ? (patch as (s: T) => Partial<T>)(state) : patch;
    const merged = { ...state, ...next };
    if (Object.keys(next).every((key) => (state as Record<string, unknown>)[key] === (merged as Record<string, unknown>)[key])) {
      return;
    }
    state = merged;
    listeners.forEach((listener) => listener());
  };

  const get = () => state;
  state = initializer(set, get);

  const subscribe = (listener: Listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  function useStore<U>(selector: (s: T) => U): U {
    const getSnapshot = useCallback(() => selector(state), [selector]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  const hook = useStore as StoreHook<T>;
  hook.getState = get;
  hook.setState = set;
  return hook;
}
