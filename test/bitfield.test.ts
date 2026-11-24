import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderVideoIds, WatchedBitField } from '../src/providers/stremio/bitfield.ts';

// Vectors from stremio-core's stremio-watched-bitfield tests.

test('parses, round-trips and modifies a real Stremio value', () => {
  const videos = Array.from({ length: 9 }, (_, i) => `tt2934286:1:${i + 1}`);
  const watched = 'tt2934286:1:5:5:eJyTZwAAAEAAIA==';
  const wb = WatchedBitField.parse(watched, videos);
  assert.equal(wb.getVideo('tt2934286:1:5'), true);
  assert.equal(wb.getVideo('tt2934286:1:6'), false);
  assert.equal(wb.toString(), watched);
  wb.setVideo('tt2934286:1:6', true);
  assert.equal(wb.getVideo('tt2934286:1:6'), true);
});

test('empty field serializes like Stremio', () => {
  assert.equal(WatchedBitField.empty([]).toString(), 'undefined:1:eJwDAAAAAAE=');
  assert.equal(WatchedBitField.parse('undefined:1:eJwDAAAAAAE=', []).watchedVideoIds().length, 0);
});

test('anchor points to the last watched video', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `tt0:1:${i + 1}`);
  const wb = WatchedBitField.empty(ids);
  wb.setVideo('tt0:1:16', true);
  assert.ok(wb.toString().startsWith('tt0:1:16:16:'));
});

test('alternating bits survive a round trip over 499 videos', () => {
  const ids = Array.from({ length: 499 }, (_, i) => `tt2934286:1:${i + 1}`);
  const wb = WatchedBitField.empty(ids);
  for (let i = 0; i < ids.length; i++) wb.set(i, i % 2 === 0);
  const back = WatchedBitField.parse(wb.toString(), ids);
  ids.forEach((id, i) => {
    assert.equal(back.getVideo(id), i % 2 === 0);
  });
});

test('realigns when episodes are added before the anchor', () => {
  const before = ['s:1:1', 's:1:2', 's:1:3'];
  const wb = WatchedBitField.empty(before);
  wb.setVideo('s:1:2', true);
  wb.setVideo('s:1:3', true);
  const after = ['s:0:1', ...before, 's:1:4']; // a special was inserted at the front, a new episode at the end
  const moved = WatchedBitField.parse(wb.toString(), after);
  assert.deepEqual(moved.watchedVideoIds(), ['s:1:2', 's:1:3']);
});

test('unknown anchor gives a blank field, like Stremio', () => {
  const wb = WatchedBitField.empty(['a:1:1', 'a:1:2']);
  wb.setVideo('a:1:2', true);
  assert.deepEqual(WatchedBitField.parse(wb.toString(), ['b:1:1', 'b:1:2']).watchedVideoIds(), []);
});

test('orders videos by season, episode, then release date', () => {
  const ordered = orderVideoIds([
    { id: 'x:2:1', season: 2, episode: 1 },
    { id: 'x:1:2', season: 1, episode: 2 },
    { id: 'x:0:1', season: 0, episode: 1 },
    { id: 'x:1:1', season: 1, episode: 1 },
  ]);
  assert.deepEqual(ordered, ['x:0:1', 'x:1:1', 'x:1:2', 'x:2:1']);
});
