# Performance Optimization & Auto-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the Electron app's runtime memory/CPU footprint and add a toggleable "launch at login" that starts silently to the tray with minimal boot impact.

**Architecture:** A `--hidden` launch flag suppresses the main window on boot so the app starts to tray only; `app.setLoginItemSettings` toggles the OS-level login item and persists intent to `config.json`. Performance is improved by replacing the fixed 1s `setInterval` with a self-scheduling `setTimeout` whose delay is derived from a pure `nextTickDelay` helper, deduplicating snapshot broadcasts when the displayed `mm:ss` is unchanged, and releasing the reminder `<video>` media pipeline on teardown.

**Tech Stack:** Electron 31, Node.js `node --test`, vanilla JS, electron-builder.

## Global Constraints

- Platform: Windows 11 (target build: `electron-builder --win portable`).
- Electron version: 31.x (already installed as `electron@31.7.7`).
- Do NOT modify `lib/timer.js` phase-transition logic — existing 11 tests in `test/timer.test.js` must stay green.
- Conservative optimization only: do NOT disable GPU/hardware acceleration.
- Timer stays minute-exact via the `endAt` epoch-ms mechanism in `lib/timer.js`.
- All UI strings are Chinese (Simplified) to match existing UI.
- No separate settings window — the autostart checkbox goes in the existing `index.html` main window.
- Test command: `node --test` (runs `test/*.test.js`).
- Commit on each task after tests pass.

---

## File Structure

| File | Responsibility | Status |
|------|-----------------|--------|
| `lib/tick-schedule.js` | Pure helper: `nextTickDelay(phase, remainingMs)` → delay in ms | NEW |
| `test/tick-schedule.test.js` | Unit tests for `nextTickDelay` | NEW |
| `main.js` | `--hidden` parse; autostart IPC + config; setTimeout tick loop; broadcast dedupe | MODIFY |
| `preload.js` | Expose `getAutostart` / `setAutostart` | MODIFY |
| `index.html` | Add "开机自启" checkbox | MODIFY |
| `renderer.js` | Wire checkbox to API | MODIFY |
| `reminder.html` | `preload="metadata"` on video | MODIFY |
| `reminder.js` | Media-release on teardown | MODIFY |

---

### Task 1: Tick schedule helper (TDD)

**Files:**
- Create: `lib/tick-schedule.js`
- Test: `test/tick-schedule.test.js`

**Interfaces:**
- Produces: `nextTickDelay(phase, remainingMs)` where:
  - `phase`: `'idle' | 'activity' | 'rest'` (string)
  - `remainingMs`: number (ms, ≥ 0)
  - Returns: number (delay in ms, always ≥ 1000)

- [ ] **Step 1: Write the failing tests**

Create `test/tick-schedule.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tick-schedule.test.js`
Expected: FAIL — `Cannot find module '../lib/tick-schedule.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/tick-schedule.js`:

```javascript
// Delay (ms) until the next timer tick, based on current phase and remaining time.
// Conservative: keep 1s resolution only when the displayed countdown needs it,
// otherwise let the main process idle for up to a minute between checks.
function nextTickDelay(phase, remainingMs) {
  if (phase === 'rest') return 1000;
  if (phase !== 'activity') return 60000; // idle / not running
  if (remainingMs <= 10 * 1000) return 1000;      // final 10s: smooth countdown
  if (remainingMs <= 60 * 1000) return 5000;       // approaching minute boundary
  return 60000;                                    // early in activity phase
}

module.exports = { nextTickDelay };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tick-schedule.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `node --test`
Expected: PASS (11 timer + 6 schedule = 17 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/tick-schedule.js test/tick-schedule.test.js
git commit -m "feat: add tick-schedule helper for throttled timer polling"
```

---

### Task 2: setTimeout-based tick loop with broadcast dedupe (main.js)

**Files:**
- Modify: `main.js` (replace `setInterval(tick, 1000)` + `broadcast`)

**Interfaces:**
- Consumes: `nextTickDelay(phase, remainingMs)` from `lib/tick-schedule.js`
- Produces: no new exports; changes internal `tick()` / `broadcast()` behavior in `main.js`

**Context — current `main.js` relevant code:**

```javascript
const timer = new TimerState(loadConfig());
// ...
let intervalId = null;

function broadcast() {
  const snap = timer.snapshot;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer:tick', snap);
  }
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.webContents.send('timer:tick', snap);
  }
}

function tick() {
  const { event } = timer.tick(Date.now());
  if (event === 'rest-start') createReminderWindow();
  if (event === 'rest-end') closeReminderWindow();
  broadcast();
}
// ... inside app.whenReady().then(() => { ... }):
  intervalId = setInterval(tick, 1000);
// ... app.on('before-quit', ...):
  if (intervalId) clearInterval(intervalId);
```

- [ ] **Step 1: Replace the interval with a self-scheduling timeout**

In `main.js`, replace the `let intervalId = null;` declaration and the `tick` / `broadcast` functions with a dedupe-aware version. Replace these lines:

```javascript
let intervalId = null;
```
and
```javascript
function broadcast() {
  const snap = timer.snapshot;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer:tick', snap);
  }
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.webContents.send('timer:tick', snap);
  }
}

function tick() {
  const { event } = timer.tick(Date.now());
  if (event === 'rest-start') createReminderWindow();
  if (event === 'rest-end') closeReminderWindow();
  broadcast();
}
```

with:

```javascript
let tickTimeoutId = null;
let lastSentClock = null; // last sent mm:ss string, to dedupe broadcasts

function broadcast(force = false) {
  const snap = timer.snapshot;
  const clock = fmtClock(snap.remainingMs);
  // Only send when the displayed mm:ss changes, or when forced (user actions).
  if (!force && clock === lastSentClock) return;
  lastSentClock = clock;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer:tick', snap);
  }
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.webContents.send('timer:tick', snap);
  }
}

function fmtClock(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function scheduleTick() {
  if (tickTimeoutId) clearTimeout(tickTimeoutId); // cancel any pending tick to avoid double-scheduling
  const { phase, remainingMs } = timer.snapshot;
  const delay = nextTickDelay(phase, remainingMs);
  tickTimeoutId = setTimeout(tick, delay);
}

function tick() {
  const { event } = timer.tick(Date.now());
  if (event === 'rest-start') createReminderWindow();
  if (event === 'rest-end') closeReminderWindow();
  broadcast();
  scheduleTick();
}
```

- [ ] **Step 2: Add the require for the helper**

Add to the top of `main.js` (after the existing requires):

```javascript
const { nextTickDelay } = require('./lib/tick-schedule.js');
```

- [ ] **Step 3: Force broadcasts on user-initiated IPC actions**

User actions (start/pause/reset/setTimes) must update the UI immediately — they should not wait for the next dedupe window. In each existing IPC handler, change `broadcast()` to `broadcast(true)` so the snapshot is sent even if `mm:ss` is unchanged. The handlers to update (inside `app.whenReady().then(() => { ... })`):

```javascript
  ipcMain.on('timer:start', () => { timer.start(Date.now()); broadcast(true); scheduleTick(); });
  ipcMain.on('timer:pause', () => { timer.pause(Date.now()); broadcast(true); });
  ipcMain.on('timer:reset', () => {
    timer.reset(Date.now());
    closeReminderWindow();
    broadcast(true);
    scheduleTick();
  });
  ipcMain.on('timer:setTimes', (_e, t) => {
    const activityMinutes = Math.max(1, Math.floor(Number(t.activityMinutes) || DEFAULTS.activityMinutes));
    const restMinutes = Math.max(DEFAULTS.restMinutes, Math.floor(Number(t.restMinutes) || DEFAULTS.restMinutes));
    timer.setTimes({ activityMinutes, restMinutes });
    saveConfig({ activityMinutes, restMinutes });
    broadcast(true);
    scheduleTick();
  });
  ipcMain.on('reminder:close', () => {
    timer.skipRest(Date.now());
    closeReminderWindow();
    broadcast(true);
    scheduleTick();
  });
```

Note: `scheduleTick()` is called after state-changing actions to reschedule the next poll based on the new phase/remaining time. `timer:pause` does not call `scheduleTick` because the existing behavior keeps polling while paused (idle polling at 60s) — actually it does need to keep polling to remain responsive, so `scheduleTick()` stays scheduled from the last `tick()`. Review: when paused, `timer.snapshot.running` is false and phase is the same, so `nextTickDelay` returns 60s; the previously scheduled `tick()` will fire and reschedule. So pause needs no `scheduleTick` call. Confirm this reasoning is correct before implementing: the pending timeout from before pause still fires, calls `tick()` (a no-op since not running), then `scheduleTick()` reschedules. Correct.

- [ ] **Step 4: Replace the setInterval start with scheduleTick**

Replace:

```javascript
  intervalId = setInterval(tick, 1000);
```

with:

```javascript
  scheduleTick();
```

- [ ] **Step 5: Replace the clearInterval in before-quit**

Replace:

```javascript
app.on('before-quit', () => {
  if (intervalId) clearInterval(intervalId);
});
```

with:

```javascript
app.on('before-quit', () => {
  if (tickTimeoutId) clearTimeout(tickTimeoutId);
});
```

- [ ] **Step 6: Run full test suite**

Run: `node --test`
Expected: PASS (17 tests — no `main.js` logic is unit-tested, so the timer + schedule tests confirm no breakage in shared modules)

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "perf: throttle timer with self-scheduling timeout and dedupe broadcasts"
```

---

### Task 3: Reminder video lifecycle (reminder.html + reminder.js)

**Files:**
- Modify: `reminder.html` (video element attributes)
- Modify: `reminder.js` (teardown cleanup)

**Interfaces:**
- Consumes: existing `<video id="video">` element and `window.api`
- Produces: no new exports

- [ ] **Step 1: Add preload="metadata" to the video element**

In `reminder.html`, change:

```html
  <div class="video"><video id="video" autoplay muted playsinline></video></div>
```

to:

```html
  <div class="video"><video id="video" autoplay muted preload="metadata" playsinline></video></div>
```

- [ ] **Step 2: Add media-release teardown in reminder.js**

In `reminder.js`, add a `beforeunload` cleanup. After the existing `closeBtn` listener (the last line), append:

```javascript
window.addEventListener('beforeunload', () => {
  try {
    videoEl.pause();
    videoEl.src = '';
    videoEl.load();
  } catch {}
});
```

- [ ] **Step 3: Run full test suite**

Run: `node --test`
Expected: PASS (17 tests — reminder files aren't unit-tested, confirms shared modules intact)

- [ ] **Step 4: Commit**

```bash
git add reminder.html reminder.js
git commit -m "perf: release reminder video media on teardown and skip full preload"
```

---

### Task 4: Auto-start — launch flag + IPC + config (main.js)

**Files:**
- Modify: `main.js`

**Interfaces:**
- Consumes: existing `config.json` load/save (`loadConfig`, `saveConfig`, `configPath`)
- Produces:
  - IPC handler `settings:getAutostart` (invoke) → returns `boolean`
  - IPC handler `settings:setAutostart` (on) → receives `boolean`, sets login item, persists config
  - `mainWindow` creation is gated on a `--hidden` flag check

**Context — current `main.js` relevant code:**

```javascript
const DEFAULTS = { activityMinutes: 30, restMinutes: 2 };
// ...
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      activityMinutes: Number(cfg.activityMinutes) || DEFAULTS.activityMinutes,
      restMinutes: Number(cfg.restMinutes) || DEFAULTS.restMinutes,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg)); } catch {}
}
// ... in app.whenReady().then(() => { ... }):
  createMainWindow();
  intervalId = setInterval(tick, 1000);  // NOTE: this is now scheduleTick() after Task 2
```

- [ ] **Step 1: Add the --hidden flag constant near the top**

Near the top of `main.js` (after the `quitting`/`intervalId` declarations, or wherever the module-level `let` declarations live), add:

```javascript
const HIDDEN = process.argv.includes('--hidden');
```

- [ ] **Step 2: Extend config to carry autoStart**

Update `loadConfig` and `saveConfig` to round-trip an `autoStart` boolean. Replace the `loadConfig` function:

```javascript
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      activityMinutes: Number(cfg.activityMinutes) || DEFAULTS.activityMinutes,
      restMinutes: Number(cfg.restMinutes) || DEFAULTS.restMinutes,
      autoStart: Boolean(cfg.autoStart),
    };
  } catch {
    return { ...DEFAULTS, autoStart: false };
  }
}
```

Replace the `saveConfig` function — it currently overwrites the whole file with only activity/rest. To preserve other keys, read-modify-write. Replace:

```javascript
function saveConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg)); } catch {}
}
```

with:

```javascript
function saveConfig(patch) {
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
    Object.assign(cfg, patch);
    fs.writeFileSync(configPath(), JSON.stringify(cfg));
  } catch {}
}
```

Note: this changes `saveConfig`'s contract from "write whole file" to "merge patch". The existing caller in `ipcMain.on('timer:setTimes', ...)` calls `saveConfig({ activityMinutes, restMinutes })` — that still works (merges those two keys). The autostart handler will call `saveConfig({ autoStart: value })`.

- [ ] **Step 3: Gate createMainWindow on the HIDDEN flag**

In `app.whenReady().then(() => { ... })`, replace:

```javascript
  createMainWindow();
```

with:

```javascript
  if (!HIDDEN) createMainWindow();
```

- [ ] **Step 4: Add autostart IPC handlers**

Inside `app.whenReady().then(() => { ... })`, alongside the other `ipcMain.handle` calls, add:

```javascript
  ipcMain.handle('settings:getAutostart', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.on('settings:setAutostart', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
    saveConfig({ autoStart: Boolean(enabled) });
    broadcast(true);
  });
```

- [ ] **Step 5: Run full test suite**

Run: `node --test`
Expected: PASS (17 tests)

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat: add --hidden launch flag and autostart IPC handlers"
```

---

### Task 5: Auto-start UI (preload.js + index.html + renderer.js)

**Files:**
- Modify: `preload.js`
- Modify: `index.html`
- Modify: `renderer.js`

**Interfaces:**
- Consumes: IPC channels `settings:getAutostart` (invoke) and `settings:setAutostart` (on) from Task 4
- Produces: `window.api.getAutostart()` → `Promise<boolean>` and `window.api.setAutostart(boolean)` on the renderer side

- [ ] **Step 1: Expose autostart API in preload.js**

In `preload.js`, add two entries to the `contextBridge.exposeInMainWorld('api', { ... })` object. After the `closeReminder` entry, add:

```javascript
  getAutostart: () => ipcRenderer.invoke('settings:getAutostart'),
  setAutostart: (enabled) => ipcRenderer.send('settings:setAutostart', enabled),
```

- [ ] **Step 2: Add the checkbox to index.html**

In `index.html`, after the existing controls block and before `<script src="renderer.js"></script>`, add:

```html
  <div class="row">
    <label style="flex:0 0 96px; font-size:13px;">开机自启</label>
    <input id="autoStartInput" type="checkbox" style="width:auto;">
  </div>
```

- [ ] **Step 3: Wire the checkbox in renderer.js**

In `renderer.js`, add after the existing input listeners (end of file):

```javascript
const autoStartInput = document.getElementById('autoStartInput');
window.api.getAutostart().then((on) => { autoStartInput.checked = on; });
autoStartInput.addEventListener('change', () => window.api.setAutostart(autoStartInput.checked));
```

- [ ] **Step 4: Run full test suite**

Run: `node --test`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add preload.js index.html renderer.js
git commit -m "feat: add toggleable autostart checkbox in main window"
```

---

### Task 6: Build verification & manual smoke test

**Files:**
- Verify only (no code changes expected)

- [ ] **Step 1: Run full test suite one final time**

Run: `node --test`
Expected: PASS (17 tests)

- [ ] **Step 2: Verify asar is enabled in build config**

Run: `node -e "console.log(require('./package.json').build)" 2>&1` (or inspect `package.json`)
Expected: no explicit `asar: false` anywhere in the `build` block. electron-builder defaults `asar` to true; absence means it's on. If `asar: false` is present, remove it.

- [ ] **Step 3: Build the portable exe**

Run: `npm run dist`
Expected: `dist/ticktockneck 1.0.0.exe` is produced (or refreshed) without error.

- [ ] **Step 4: Manual smoke test (documented, not automated)**

Launch the built exe and verify:
1. App starts, main window shows with a new "开机自启" checkbox.
2. Toggling the checkbox on, then checking Windows Task Manager → Startup tab, shows `ticktockneck` listed (or registry `HKCU\...\Run` has the entry with `--hidden`).
3. Restart Windows: app starts to tray only (no main window, no reminder popup). Clicking the tray icon opens the window.
4. During the activity phase, observe (via Task Manager) that the process is idle — CPU near 0% — confirming the throttled tick is not waking every second.
5. Reminder popup still plays the 5 videos in sequence with pauses.

- [ ] **Step 5: Commit (if any build-config change was made)**

If Step 2 required removing `asar: false` from `package.json`:
```bash
git add package.json
git commit -m "build: ensure asar packaging is enabled"
```
Otherwise, no commit — the task is verification only.
