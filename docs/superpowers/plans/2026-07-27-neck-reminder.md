# Neck-Activity Reminder (ticktockneck) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pomodoro-style Windows desktop app that periodically reminds the user to move their neck: an adjustable activity interval counts down, then a frameless top-right popup plays a GIF and stays for an adjustable rest interval before auto-dismissing, with pause/reset and tray-minimize support.

**Architecture:** Electron app. A pure, unit-tested `TimerState` class owns the countdown state machine and lives in the main process; the main process broadcasts tick snapshots to the control window and the reminder popup over IPC. The control window shows settings + timer + controls; the reminder window is a frameless, always-on-top, top-right popup that plays the GIF and auto-closes when rest ends. Tray icon hides/restores the control window.

**Tech Stack:** Electron (renderer = plain HTML/CSS/JS), Node built-in `node --test` for unit tests, Node built-in `zlib` to generate a tray icon at runtime (zero non-Electron dependencies).

## Global Constraints

- Platform: Windows 11. Node v20.18.0, npm 10.9.8 already installed.
- Working directory: `E:\5_tempFile\ticktockneck` (already contains `gif\1403-x2chWLO.gif` and `gif\1403-x2chWLO.jpg`).
- No runtime dependencies except `electron` (devDependency). No `electron-store`, no canvas libs, no test framework — use `node --test` and Node built-ins.
- UI copy in Simplified Chinese (e.g. "该活动脖子啦！", "活动时间(分)", "休息时间(分)", "开始/继续", "暂停", "重置", "知道了").
- Default durations: activity 30 minutes, rest 1 minute. Both editable, integer minutes, minimum 1.
- Reminder loop is continuous: activity → rest → activity → rest … until paused or reset.
- The GIF to play is whatever `.gif` file exists in `gif\` at startup (resolved dynamically, so renaming the file is fine).
- Keep it simple: no router, no bundler, no framework, no TypeScript.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json` | npm manifest, electron devDep, `start` and `test` scripts. |
| `.gitignore` | Ignore `node_modules\`, `dist\`. |
| `lib\timer.js` | Pure `TimerState` class — the countdown state machine. No Electron. Unit-tested. |
| `test\timer.test.js` | `node --test` tests for `TimerState`. |
| `lib\icon.js` | Generates a 16×16 teal PNG `Buffer` at runtime via `zlib` (used for tray + window icon). |
| `main.js` | Electron main process: app lifecycle, single-instance lock, config load/save, `TimerState` wiring, control window + reminder window creation/positioning, tray, IPC handlers. |
| `preload.js` | `contextBridge` exposing a minimal safe `window.api` to both renderer windows. |
| `index.html` | Control window UI: settings inputs, timer display, buttons. |
| `renderer.js` | Control window logic: render ticks, wire buttons/inputs to `window.api`. |
| `reminder.html` | Reminder popup UI: message + GIF + rest countdown + close button. |
| `reminder.js` | Reminder popup logic: read GIF URL from query, render ticks, close button. |
| `styles.css` | Minimal shared styles for both windows. |

**Interfaces (locked here, referenced by tasks):**

`TimerState` (lib\timer.js) — consumed by main.js:
```js
class TimerState {
  constructor({ activityMinutes, restMinutes })
  get snapshot() // { phase:'idle'|'activity'|'rest', remainingMs, running, activityMinutes, restMinutes }
  setTimes({ activityMinutes, restMinutes }) // void
  start(now) // void  — begins activity if idle, resumes if paused
  pause(now) // void
  reset(now) // void  — back to idle, full activity remaining, stopped
  skipRest(now) // void — if in rest, jump to a fresh activity phase (used on manual close)
  tick(now) // { event: null | 'rest-start' | 'rest-end' }
}
```

`window.api` (preload.js) — consumed by renderer.js and reminder.js:
```js
window.api = {
  start(), pause(), reset(),
  setTimes({ activityMinutes, restMinutes }),
  getState(),          // Promise<snapshot>  (ipcRenderer.invoke)
  onTick(cb),          // cb(snapshot)       (ipcRenderer.on 'timer:tick')
  closeReminder(),     // void               (manual close from reminder window)
}
```

Tick snapshot broadcast by main.js on every change and every 1s tick:
```js
{ phase, remainingMs, running, activityMinutes, restMinutes }
```

Reminder window is loaded with a query string `?gif=<fileURL>` so `reminder.js` can set the `<img>` src. No IPC needed for the GIF.

---

### Task 1: Scaffold project, package.json, install Electron, git init

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Initialize git repo**

Run:
```bash
cd "E:\5_tempFile\ticktockneck"
git init
```
Expected: `Initialized empty Git repository…`

- [ ] **Step 2: Create `.gitignore`**

Create `E:\5_tempFile\ticktockneck\.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 3: Create `package.json`**

Create `E:\5_tempFile\ticktockneck\package.json`:
```json
{
  "name": "ticktockneck",
  "version": "1.0.0",
  "description": "Neck-activity reminder (pomodoro-style)",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test"
  },
  "devDependencies": {
    "electron": "^31.0.0"
  }
}
```

- [ ] **Step 4: Install Electron**

Run:
```bash
npm install
```
Expected: installs `electron` into `node_modules\` (downloads the Electron binary; may take a minute). Ends with `added N packages`.

- [ ] **Step 5: Verify Electron is runnable**

Run:
```bash
npx electron --version
```
Expected: prints a version like `v31.x.x`.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: scaffold project with electron"
```
(Do not commit `node_modules\` — `.gitignore` excludes it.)

---

### Task 2: Timer state machine (TDD)

**Files:**
- Create: `lib\timer.js`
- Test: `test\timer.test.js`

**Interfaces:**
- Produces: `TimerState` class with the exact signature in the File Structure section above. main.js (Task 4) constructs it and calls `start/pause/reset/skipRest/tick` with `Date.now()`; reads `.snapshot`.

- [ ] **Step 1: Write the failing tests**

Create `E:\5_tempFile\ticktockneck\test\timer.test.js`:
```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test
```
Expected: FAIL — `Cannot find module '../lib/timer.js'`.

- [ ] **Step 3: Write the implementation**

Create `E:\5_tempFile\ticktockneck\lib\timer.js`:
```js
const MIN = 60 * 1000;

class TimerState {
  constructor({ activityMinutes, restMinutes }) {
    this.activityMinutes = activityMinutes;
    this.restMinutes = restMinutes;
    this.phase = 'idle';            // 'idle' | 'activity' | 'rest'
    this.running = false;
    this.remainingMs = this.activityMinutes * MIN;
    this.endAt = null;              // epoch ms when current run ends; null when paused/idle
  }

  get snapshot() {
    return {
      phase: this.phase,
      remainingMs: this.remainingMs,
      running: this.running,
      activityMinutes: this.activityMinutes,
      restMinutes: this.restMinutes,
    };
  }

  setTimes({ activityMinutes, restMinutes }) {
    this.activityMinutes = activityMinutes;
    this.restMinutes = restMinutes;
    if (this.phase === 'idle') {
      this.remainingMs = this.activityMinutes * MIN;
    }
  }

  start(now) {
    if (this.running) return;
    if (this.phase === 'idle') {
      this.phase = 'activity';
      this.remainingMs = this.activityMinutes * MIN;
    }
    this.running = true;
    this.endAt = now + this.remainingMs;
  }

  pause(now) {
    if (!this.running) return;
    this.remainingMs = Math.max(0, this.endAt - now);
    this.running = false;
    this.endAt = null;
  }

  reset(now) {
    this.phase = 'idle';
    this.running = false;
    this.remainingMs = this.activityMinutes * MIN;
    this.endAt = null;
  }

  skipRest(now) {
    if (this.phase !== 'rest') return;
    this.phase = 'activity';
    this.remainingMs = this.activityMinutes * MIN;
    this.running = true;
    this.endAt = now + this.remainingMs;
  }

  tick(now) {
    if (!this.running) return { event: null };
    this.remainingMs = Math.max(0, this.endAt - now);
    if (this.remainingMs > 0) return { event: null };
    // phase elapsed -> transition
    if (this.phase === 'activity') {
      this.phase = 'rest';
      this.remainingMs = this.restMinutes * MIN;
      this.endAt = now + this.remainingMs;
      return { event: 'rest-start' };
    }
    // phase === 'rest'
    this.phase = 'activity';
    this.remainingMs = this.activityMinutes * MIN;
    this.endAt = now + this.remainingMs;
    return { event: 'rest-end' };
  }
}

module.exports = { TimerState };
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm test
```
Expected: PASS — `tests N pass (N)`.

- [ ] **Step 5: Commit**

```bash
git add lib/timer.js test/timer.test.js
git commit -m "feat: add timer state machine with tests"
```

---

### Task 3: Runtime icon generator

**Files:**
- Create: `lib\icon.js`

**Interfaces:**
- Produces: `createIconBuffer()` → `Buffer` (a valid 16×16 RGBA PNG). main.js (Task 4) wraps it with `nativeImage.createFromBuffer(createIconBuffer())` for the tray and window icon.

- [ ] **Step 1: Write the generator**

Create `E:\5_tempFile\ticktockneck\lib\icon.js`:
```js
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// 16x16 RGBA solid teal icon. No external asset file needed.
function createIconBuffer() {
  const W = 16, H = 16;
  const R = 0x14, G = 0xB8, B = 0xA6, A = 0xFF;
  const row = Buffer.alloc(1 + W * 4);
  row[0] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const o = 1 + x * 4;
    row[o] = R; row[o + 1] = G; row[o + 2] = B; row[o + 3] = A;
  }
  const raw = Buffer.concat(Array.from({ length: H }, () => row));
  const idat = zlib.deflateSync(raw);

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { createIconBuffer };
```

- [ ] **Step 2: Verify the buffer is a valid PNG**

Run:
```bash
node -e "const {createIconBuffer}=require('./lib/icon.js'); const b=createIconBuffer(); console.log(b.length, b.slice(1,4).toString('ascii'));"
```
Expected: prints a byte count (around 90) followed by `PNG`. This confirms the signature and that the module loads.

- [ ] **Step 3: Commit**

```bash
git add lib/icon.js
git commit -m "feat: generate tray/window icon at runtime"
```

---

### Task 4: Main process — lifecycle, windows, tray, timer wiring, IPC

**Files:**
- Create: `main.js`
- Create: `preload.js`

**Interfaces:**
- Consumes: `TimerState` from `lib\timer.js` (Task 2), `createIconBuffer` from `lib\icon.js` (Task 3).
- Produces: the running Electron app; exposes `window.api` (preload) and the tick snapshot contract that `renderer.js` (Task 5) and `reminder.js` (Task 6) consume.

- [ ] **Step 1: Write `preload.js`**

Create `E:\5_tempFile\ticktockneck\preload.js`:
```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.send('timer:start'),
  pause: () => ipcRenderer.send('timer:pause'),
  reset: () => ipcRenderer.send('timer:reset'),
  setTimes: (t) => ipcRenderer.send('timer:setTimes', t),
  getState: () => ipcRenderer.invoke('timer:getState'),
  onTick: (cb) => ipcRenderer.on('timer:tick', (_e, snapshot) => cb(snapshot)),
  closeReminder: () => ipcRenderer.send('reminder:close'),
});
```

- [ ] **Step 2: Write `main.js`**

Create `E:\5_tempFile\ticktockneck\main.js`:
```js
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { TimerState } = require('./lib/timer.js');
const { createIconBuffer } = require('./lib/icon.js');

const DEFAULTS = { activityMinutes: 30, restMinutes: 1 };

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
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

let tray = null;
let mainWindow = null;
let reminderWindow = null;
let quitting = false;
let intervalId = null;

const timer = new TimerState(loadConfig());

function gifUrl() {
  const dir = path.join(__dirname, 'gif');
  const file = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith('.gif'));
  if (!file) return '';
  return url.pathToFileURL(path.join(dir, file)).href;
}

function broadcast() {
  const snap = timer.snapshot;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer:tick', snap);
  }
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.webContents.send('timer:tick', snap);
  }
}

function createReminderWindow() {
  if (reminderWindow && !reminderWindow.isDestroyed()) return;
  const gif = gifUrl();
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;
  const W = 360, H = 300;
  reminderWindow = new BrowserWindow({
    x: width - W - 20,
    y: 20,
    width: W,
    height: H,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  reminderWindow.loadFile('reminder.html', { query: { gif } });
  reminderWindow.once('ready-to-show', () => reminderWindow.show());
  reminderWindow.on('closed', () => { reminderWindow = null; });
}

function closeReminderWindow() {
  if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close();
  reminderWindow = null;
}

function createMainWindow() {
  const icon = nativeImage.createFromBuffer(createIconBuffer());
  mainWindow = new BrowserWindow({
    width: 360,
    height: 320,
    resizable: false,
    icon,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('minimize', (e) => { e.preventDefault(); mainWindow.hide(); });
  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

function tick() {
  const { event } = timer.tick(Date.now());
  if (event === 'rest-start') createReminderWindow();
  if (event === 'rest-end') closeReminderWindow();
  broadcast();
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromBuffer(createIconBuffer());
  tray = new Tray(icon);
  tray.setToolTip('脖子活动提醒');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

  createMainWindow();

  intervalId = setInterval(tick, 1000);

  ipcMain.on('timer:start', () => { timer.start(Date.now()); broadcast(); });
  ipcMain.on('timer:pause', () => { timer.pause(Date.now()); broadcast(); });
  ipcMain.on('timer:reset', () => {
    timer.reset(Date.now());
    closeReminderWindow();
    broadcast();
  });
  ipcMain.on('timer:setTimes', (_e, t) => {
    const activityMinutes = Math.max(1, Math.floor(Number(t.activityMinutes) || DEFAULTS.activityMinutes));
    const restMinutes = Math.max(1, Math.floor(Number(t.restMinutes) || DEFAULTS.restMinutes));
    timer.setTimes({ activityMinutes, restMinutes });
    saveConfig({ activityMinutes, restMinutes });
    broadcast();
  });
  ipcMain.handle('timer:getState', () => timer.snapshot);
  ipcMain.on('reminder:close', () => {
    timer.skipRest(Date.now());
    closeReminderWindow();
    broadcast();
  });
});

app.on('window-all-closed', (e) => { e.preventDefault(); }); // keep running in tray

app.on('before-quit', () => {
  if (intervalId) clearInterval(intervalId);
});
```

- [ ] **Step 3: Verify the app launches (UI not built yet — expect a blank/error window, that's fine)**

Run:
```bash
npm start
```
Expected: Electron starts; a control window appears (empty/white because `index.html` does not exist yet — that is OK). A teal tray icon appears in the system tray. Close the Electron window from the tray menu (right-click tray → 退出) to stop it. If a hard crash occurs in the main process, fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "feat: main process with windows, tray, timer wiring, IPC"
```

---

### Task 5: Control window UI

**Files:**
- Create: `index.html`
- Create: `renderer.js`
- Create: `styles.css`

**Interfaces:**
- Consumes: `window.api` (preload, Task 4) and the tick snapshot `{ phase, remainingMs, running, activityMinutes, restMinutes }`.

- [ ] **Step 1: Write `styles.css`**

Create `E:\5_tempFile\ticktockneck\styles.css`:
```css
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
  background: #1f2937;
  color: #e5e7eb;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
}
h1 { font-size: 16px; margin: 0; text-align: center; }
.row { display: flex; align-items: center; gap: 8px; }
.row label { flex: 0 0 96px; font-size: 13px; }
.row input { width: 70px; padding: 4px 6px; font-size: 13px; background: #374151; color: #e5e7eb; border: 1px solid #4b5563; border-radius: 4px; }
.timer { text-align: center; }
.timer .phase { font-size: 13px; color: #9ca3af; }
.timer .clock { font-size: 40px; font-weight: 600; letter-spacing: 2px; }
.controls { display: flex; gap: 8px; justify-content: center; }
.controls button {
  flex: 1; padding: 8px 0; font-size: 13px; cursor: pointer;
  background: #14b8a6; color: #fff; border: none; border-radius: 6px;
}
.controls button.secondary { background: #4b5563; }
.hint { font-size: 11px; color: #6b7280; text-align: center; }
```

- [ ] **Step 2: Write `index.html`**

Create `E:\5_tempFile\ticktockneck\index.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: file:;">
  <link rel="stylesheet" href="styles.css">
  <title>脖子活动提醒</title>
</head>
<body>
  <h1>脖子活动提醒</h1>
  <div class="row">
    <label>活动时间(分)</label>
    <input id="activityInput" type="number" min="1" step="1" value="30">
  </div>
  <div class="row">
    <label>休息时间(分)</label>
    <input id="restInput" type="number" min="1" step="1" value="1">
  </div>
  <div class="timer">
    <div class="phase" id="phase">已停止</div>
    <div class="clock" id="clock">30:00</div>
  </div>
  <div class="controls">
    <button id="startBtn">开始/继续</button>
    <button id="pauseBtn" class="secondary">暂停</button>
    <button id="resetBtn" class="secondary">重置</button>
  </div>
  <div class="hint">最小化将隐藏到托盘</div>
  <script src="renderer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `renderer.js`**

Create `E:\5_tempFile\ticktockneck\renderer.js`:
```js
const phaseEl = document.getElementById('phase');
const clockEl = document.getElementById('clock');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const activityInput = document.getElementById('activityInput');
const restInput = document.getElementById('restInput');

const PHASE_LABEL = { idle: '已停止', activity: '活动中', rest: '休息中' };

function fmt(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function render(snap) {
  if (!snap) return;
  phaseEl.textContent = PHASE_LABEL[snap.phase] || snap.phase;
  clockEl.textContent = fmt(snap.remainingMs);
  activityInput.value = snap.activityMinutes;
  restInput.value = snap.restMinutes;
}

window.api.onTick(render);
window.api.getState().then(render);

startBtn.addEventListener('click', () => window.api.start());
pauseBtn.addEventListener('click', () => window.api.pause());
resetBtn.addEventListener('click', () => window.api.reset());
activityInput.addEventListener('change', () =>
  window.api.setTimes({ activityMinutes: Number(activityInput.value), restMinutes: Number(restInput.value) }));
restInput.addEventListener('change', () =>
  window.api.setTimes({ activityMinutes: Number(activityInput.value), restMinutes: Number(restInput.value) }));
```

- [ ] **Step 4: Verify the control window works**

Run:
```bash
npm start
```
Expected manual checks:
- Window shows "脖子活动提醒", two number inputs (30 / 1), clock "30:00", phase "已停止".
- Click 开始/继续 → phase becomes "活动中", clock starts counting down each second.
- Click 暂停 → clock freezes; click 开始/继续 → resumes.
- Click 重置 → phase "已停止", clock back to full activity time.
- Change an input and tab away → value persists; on reset the new full duration is used.
- Click minimize → window hides; teal tray icon remains; click tray → window returns.
- Right-click tray → 显示窗口 / 退出; 退出 closes the app.

Stop the app via tray → 退出.

- [ ] **Step 5: Commit**

```bash
git add index.html renderer.js styles.css
git commit -m "feat: control window with settings and timer display"
```

---

### Task 6: Reminder popup

**Files:**
- Create: `reminder.html`
- Create: `reminder.js`

**Interfaces:**
- Consumes: `?gif=<fileURL>` query param (set by main.js when loading the window), `window.api.onTick` and `window.api.closeReminder`.

- [ ] **Step 1: Write `reminder.html`**

Create `E:\5_tempFile\ticktockneck\reminder.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: file:;">
  <link rel="stylesheet" href="styles.css">
  <title>该活动脖子啦</title>
  <style>
    body { gap: 10px; padding: 14px; }
    .title { font-size: 16px; font-weight: 600; text-align: center; }
    .gif { text-align: center; }
    .gif img { max-width: 100%; max-height: 180px; border-radius: 8px; }
    .countdown { text-align: center; font-size: 14px; color: #9ca3af; }
    .close { width: 100%; }
  </style>
</head>
<body>
  <div class="title">该活动脖子啦！</div>
  <div class="gif"><img id="gif" src="" alt="活动脖子"></div>
  <div class="countdown">休息剩余 <span id="clock">00:00</span></div>
  <button id="closeBtn" class="close">知道了</button>
  <script src="reminder.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `reminder.js`**

Create `E:\5_tempFile\ticktockneck\reminder.js`:
```js
const gif = new URLSearchParams(location.search).get('gif');
if (gif) document.getElementById('gif').src = gif;

const clockEl = document.getElementById('clock');

function fmt(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

window.api.onTick((snap) => {
  if (snap && snap.phase === 'rest') clockEl.textContent = fmt(snap.remainingMs);
});

document.getElementById('closeBtn').addEventListener('click', () => window.api.closeReminder());
```

- [ ] **Step 3: Verify the end-to-end reminder loop**

Run:
```bash
npm start
```
Expected manual checks (use short durations to test quickly):
- Set 活动时间 to 1 and 休息时间 to 1 (minutes).
- Click 开始/继续.
- Wait ~1 minute (or temporarily lower durations in the inputs) → a frameless popup appears in the top-right corner showing "该活动脖子啦！", the GIF animating, and "休息剩余 00:xx" counting down.
- Leave it alone → when rest reaches 0 the popup auto-closes and a new activity phase begins (control window clock resets to full activity time, phase "活动中").
- Trigger it again and click 知道了 → popup closes immediately and activity phase starts.
- The popup is always-on-top and has no taskbar entry.

Stop via tray → 退出.

- [ ] **Step 4: Commit**

```bash
git add reminder.html reminder.js
git commit -m "feat: top-right reminder popup with gif and auto-dismiss"
```

---

### Task 7: End-to-end polish pass

**Files:**
- Possibly tweak: `main.js`, `index.html`, `renderer.js`, `reminder.html`.

- [ ] **Step 1: Confirm the full feature checklist**

Run `npm start` and verify each requirement:
- [ ] Adjustable activity time and rest time (inputs persist across restarts via `config.json`).
- [ ] On activity time elapsing, a top-right popup appears reminding to move the neck and plays the GIF from `gif\`.
- [ ] Popup auto-dismisses if ignored (when rest time elapses).
- [ ] Pause mid-cycle freezes the countdown; resume continues.
- [ ] Reset returns to idle with full activity time (and closes any open popup).
- [ ] Minimize hides to tray; tray icon click restores; tray menu has 显示窗口 / 退出.

- [ ] **Step 2: Fix any rough edges found**

If something is off, edit the relevant file(s) and re-run `npm start`. Common adjustments: popup size/position (`main.js` `W`/`H`/offset), default durations (`main.js` `DEFAULTS`), copy text.

- [ ] **Step 3: Confirm persistence across restart**

Close the app (tray → 退出), run `npm start` again, and confirm the last-set activity/rest minutes are restored.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "polish: end-to-end fixes"
```
(Skip this commit if nothing changed.)

---

### Task 8 (optional): Package a portable Windows .exe

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `electron-builder` config and script**

Edit `E:\5_tempFile\ticktockneck\package.json` to add the `build` block and a `dist` script (keep existing fields):
```json
{
  "name": "ticktockneck",
  "version": "1.0.0",
  "description": "Neck-activity reminder (pomodoro-style)",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test",
    "dist": "electron-builder --win portable"
  },
  "build": {
    "appId": "com.ticktockneck.app",
    "files": ["main.js", "preload.js", "index.html", "renderer.js", "reminder.html", "reminder.js", "styles.css", "lib/**/*", "gif/**/*"]
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-builder": "^24.13.3"
  }
}
```

- [ ] **Step 2: Install the new dev dependency**

Run:
```bash
npm install
```
Expected: installs `electron-builder`.

- [ ] **Step 3: Build the portable exe**

Run:
```bash
npm run dist
```
Expected: produces `dist\ticktockneck 1.0.0.exe` (a single portable executable). Run it to confirm the app works the same as `npm start`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add electron-builder packaging"
```

---

## Self-Review

**1. Spec coverage:**
- "定期提醒我活动脖子" → activity countdown + reminder popup (Tasks 2, 4, 6). ✓
- "可以调整活动时间和休息时间" → number inputs + `setTimes` (Tasks 4, 5). ✓
- "到点了会从右上角给我弹出一个窗口" → top-right `BrowserWindow` positioning (Task 4). ✓
- "提醒我活动脖子以及播放 gif 中的动图" → reminder.html + dynamic GIF resolution (Tasks 4, 6). ✓
- "窗口一会儿不管就能消失" → rest timer end auto-closes popup (Task 2 `tick` rest-end + Task 4 `closeReminderWindow`). ✓
- "支持中间暂停以及重置" → pause/reset commands (Tasks 2, 4, 5). ✓
- "支持托盘最小化" → `Tray`, hide-on-minimize, tray menu (Task 4). ✓
- "实现尽可能简单" → zero non-Electron deps, ~8 source files, pure tested core. ✓

**2. Placeholder scan:** No TBD/TODO/"add error handling" steps. All code steps contain complete code.

**3. Type consistency:**
- `TimerState` methods (`start/pause/reset/skipRest/tick/setTimes`/`snapshot`) match between Task 2 and Task 4.
- Snapshot fields (`phase, remainingMs, running, activityMinutes, restMinutes`) match between Task 2, the IPC in Task 4, and the renderers in Tasks 5 & 6.
- `window.api` methods match between `preload.js` (Task 4) and `renderer.js` (Task 5) / `reminder.js` (Task 6).
- `closeReminder` matches between preload, main IPC handler, and reminder.js.
