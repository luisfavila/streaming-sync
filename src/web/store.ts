// Signed-in accounts. Kept in memory, and in this browser's localStorage when "Remember" is on.
// Tokens never leave the browser except to the app they belong to.

import type { Account, Side } from '../auth.ts';

const KEY = 'streaming-sync:v1';

export interface Saved {
  remember: boolean;
  accounts: Account[];
  from?: Side;
  to?: Side;
}

export function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw) as Partial<Saved>;
      if (data.remember === false) return { remember: false, accounts: [] };
      return { remember: true, accounts: Array.isArray(data.accounts) ? data.accounts : [], from: data.from, to: data.to };
    }
  } catch {
    // storage blocked or corrupt: start fresh
  }
  return { remember: true, accounts: [] };
}

export function save(s: Saved): void {
  try {
    // Not remembering: keep only that choice (no accounts, no tokens), so it holds on the next visit.
    localStorage.setItem(KEY, JSON.stringify(s.remember ? s : { remember: false }));
  } catch {
    // storage blocked (private mode): keep working in memory
  }
}
