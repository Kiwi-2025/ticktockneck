const test = require('node:test');
const assert = require('node:assert');
const { loginItemArgs } = require('../lib/login-item.js');

test('autostart off registers nothing', () => {
  assert.deepStrictEqual(loginItemArgs({ autoStart: false, silentStart: false }), []);
  assert.deepStrictEqual(loginItemArgs({ autoStart: false, silentStart: true }), []);
});

test('autostart on without silent start shows the main window at boot', () => {
  assert.deepStrictEqual(loginItemArgs({ autoStart: true, silentStart: false }), []);
});

test('autostart on with silent start passes --hidden', () => {
  assert.deepStrictEqual(loginItemArgs({ autoStart: true, silentStart: true }), ['--hidden']);
});

test('missing flags are treated as off', () => {
  assert.deepStrictEqual(loginItemArgs({}), []);
});
