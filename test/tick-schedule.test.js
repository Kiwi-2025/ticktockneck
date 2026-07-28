const test = require('node:test');
const assert = require('node:assert');
const { nextTickDelay } = require('../lib/tick-schedule.js');

test('idle phase polls cheaply at 60s', () => {
  assert.strictEqual(nextTickDelay('idle', 0), 60000);
});

test('activity with > 60s remaining wakes once a minute', () => {
  assert.strictEqual(nextTickDelay('activity', 30 * 60 * 1000), 60000);
  assert.strictEqual(nextTickDelay('activity', 61 * 1000), 60000);
});

test('activity between 10s and 60s tightens to 5s', () => {
  assert.strictEqual(nextTickDelay('activity', 60 * 1000), 5000);
  assert.strictEqual(nextTickDelay('activity', 11 * 1000), 5000);
});

test('activity within final 10s counts down at 1s', () => {
  assert.strictEqual(nextTickDelay('activity', 10 * 1000), 1000);
  assert.strictEqual(nextTickDelay('activity', 1 * 1000), 1000);
});

test('rest phase always counts down at 1s', () => {
  assert.strictEqual(nextTickDelay('rest', 120 * 1000), 1000);
  assert.strictEqual(nextTickDelay('rest', 1 * 1000), 1000);
});

test('delay is never below 1s', () => {
  assert.ok(nextTickDelay('activity', 0) >= 1000);
  assert.ok(nextTickDelay('rest', 0) >= 1000);
});
