const test = require('node:test');
const assert = require('node:assert');
const { TimerState } = require('../lib/timer.js');

const MIN = 60 * 1000;

test('constructs idle with full activity remaining', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  assert.strictEqual(t.snapshot.phase, 'idle');
  assert.strictEqual(t.snapshot.running, false);
  assert.strictEqual(t.snapshot.remainingMs, 30 * MIN);
  assert.strictEqual(t.snapshot.activityMinutes, 30);
  assert.strictEqual(t.snapshot.restMinutes, 1);
});

test('start begins activity phase', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  assert.strictEqual(t.snapshot.phase, 'activity');
  assert.strictEqual(t.snapshot.running, true);
  assert.strictEqual(t.snapshot.remainingMs, 30 * MIN);
});

test('tick reduces remaining and fires rest-start at zero', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  let r = t.tick(1000 + 10 * MIN);
  assert.strictEqual(r.event, null);
  assert.strictEqual(t.snapshot.remainingMs, 20 * MIN);
  r = t.tick(1000 + 30 * MIN);
  assert.strictEqual(r.event, 'rest-start');
  assert.strictEqual(t.snapshot.phase, 'rest');
  assert.strictEqual(t.snapshot.remainingMs, 1 * MIN);
  assert.strictEqual(t.snapshot.running, true);
});

test('rest ticking to zero fires rest-end and loops back to activity', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  t.tick(1000 + 30 * MIN); // -> rest
  const r = t.tick(1000 + 30 * MIN + 1 * MIN);
  assert.strictEqual(r.event, 'rest-end');
  assert.strictEqual(t.snapshot.phase, 'activity');
  assert.strictEqual(t.snapshot.remainingMs, 30 * MIN);
  assert.strictEqual(t.snapshot.running, true);
});

test('pause freezes remaining and start resumes', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  t.tick(1000 + 10 * MIN); // 20 min left
  t.pause(1000 + 10 * MIN);
  assert.strictEqual(t.snapshot.running, false);
  assert.strictEqual(t.snapshot.remainingMs, 20 * MIN);
  // no progress while paused
  const r = t.tick(1000 + 999 * MIN);
  assert.strictEqual(r.event, null);
  assert.strictEqual(t.snapshot.remainingMs, 20 * MIN);
  // resume
  t.start(1000 + 999 * MIN);
  assert.strictEqual(t.snapshot.running, true);
  assert.strictEqual(t.snapshot.remainingMs, 20 * MIN);
});

test('reset returns to idle with full activity remaining', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  t.tick(1000 + 5 * MIN);
  t.reset(2000);
  assert.strictEqual(t.snapshot.phase, 'idle');
  assert.strictEqual(t.snapshot.running, false);
  assert.strictEqual(t.snapshot.remainingMs, 30 * MIN);
});

test('setTimes updates durations and idle remaining', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.setTimes({ activityMinutes: 45, restMinutes: 2 });
  assert.strictEqual(t.snapshot.activityMinutes, 45);
  assert.strictEqual(t.snapshot.restMinutes, 2);
  assert.strictEqual(t.snapshot.remainingMs, 45 * MIN);
});

test('setTimes does not disrupt a running phase', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  t.tick(1000 + 10 * MIN); // 20 min left
  t.setTimes({ activityMinutes: 45, restMinutes: 2 });
  assert.strictEqual(t.snapshot.remainingMs, 20 * MIN); // unchanged mid-run
  assert.strictEqual(t.snapshot.activityMinutes, 45);    // applies next cycle
});

test('skipRest jumps from rest to a fresh activity phase', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  t.tick(1000 + 30 * MIN); // -> rest
  t.skipRest(2000);
  assert.strictEqual(t.snapshot.phase, 'activity');
  assert.strictEqual(t.snapshot.running, true);
  assert.strictEqual(t.snapshot.remainingMs, 30 * MIN);
});

test('skipRest is a no-op outside rest', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  t.skipRest(2000);
  assert.strictEqual(t.snapshot.phase, 'activity');
  assert.strictEqual(t.snapshot.remainingMs, 30 * MIN);
});

test('tick while not running changes nothing', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  const r = t.tick(999999);
  assert.strictEqual(r.event, null);
  assert.strictEqual(t.snapshot.phase, 'idle');
});

test('snapshotAt recomputes remaining time between ticks', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  t.tick(1000 + 10 * MIN); // 20 min left
  // snapshot 里的 remainingMs 只在 tick() 时刷新，这里读到的仍是旧值
  assert.strictEqual(t.snapshot.remainingMs, 20 * MIN);
  // snapshotAt 按给定时刻重算
  assert.strictEqual(t.snapshotAt(1000 + 13 * MIN).remainingMs, 17 * MIN);
  assert.strictEqual(t.snapshotAt(1000 + 10 * MIN).remainingMs, 20 * MIN);
});

test('snapshotAt never goes negative past the end of a phase', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  assert.strictEqual(t.snapshotAt(1000 + 99 * MIN).remainingMs, 0);
});

test('snapshotAt keeps the frozen value while paused', () => {
  const t = new TimerState({ activityMinutes: 30, restMinutes: 1 });
  t.start(1000);
  t.tick(1000 + 10 * MIN); // 20 min left
  t.pause(1000 + 10 * MIN);
  assert.strictEqual(t.snapshotAt(1000 + 500 * MIN).remainingMs, 20 * MIN);
});

