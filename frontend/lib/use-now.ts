"use client";

import { useSyncExternalStore } from "react";

/** One shared clock for "5m ago" / "down for 12m" labels, ticking every 30 s (keeps render pure). */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => 0, // static prerender: no data is shown before the client loads anyway
  );
}
