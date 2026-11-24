// The "Remember accounts on this device" setting.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Account } from '../src/auth.ts';
import * as store from '../src/web/store.ts';

const data = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  },
});
beforeEach(() => data.clear());

const account = { id: 'stremio:1', app: 'stremio', who: 'me@example.com', authKey: 'secret-key' } as unknown as Account;

test('remembers accounts by default', () => {
  assert.deepEqual(store.load(), { remember: true, accounts: [] });
  store.save({ remember: true, accounts: [account] });
  assert.deepEqual(store.load().accounts, [account]);
});

test('turning Remember off forgets the accounts and stays off on the next visit', () => {
  store.save({ remember: true, accounts: [account] });
  store.save({ remember: false, accounts: [account] });
  assert.ok(![...data.values()].some(v => v.includes('secret-key')), 'no tokens left in storage');
  assert.deepEqual(store.load(), { remember: false, accounts: [] });
});
