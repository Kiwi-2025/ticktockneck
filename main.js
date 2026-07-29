const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { TimerState } = require('./lib/timer.js');
const { createIconBuffer } = require('./lib/icon.js');
const { nextTickDelay } = require('./lib/tick-schedule.js');

const DEFAULTS = { activityMinutes: 30, restMinutes: 2 };

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      activityMinutes: Number(cfg.activityMinutes) || DEFAULTS.activityMinutes,
      restMinutes: Math.max(DEFAULTS.restMinutes, Math.floor(Number(cfg.restMinutes) || DEFAULTS.restMinutes)),
      autoStart: Boolean(cfg.autoStart),
    };
  } catch {
    return { ...DEFAULTS, autoStart: false };
  }
}
function saveConfig(patch) {
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
    Object.assign(cfg, patch);
    fs.writeFileSync(configPath(), JSON.stringify(cfg));
  } catch {}
}

let tray = null;
let mainWindow = null;
let reminderWindow = null;
let quitting = false;
let tickTimeoutId = null;
const HIDDEN = process.argv.includes('--hidden');

const timer = new TimerState(loadConfig());

function videoUrls() {
  const dir = path.join(__dirname, 'gif');
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.mp4'))
    .sort()
    .map(f => url.pathToFileURL(path.join(dir, f)).href);
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

function scheduleTick() {
  if (tickTimeoutId) clearTimeout(tickTimeoutId); // cancel any pending tick to avoid double-scheduling
  const { phase, remainingMs } = timer.snapshot;
  const visible = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const delay = nextTickDelay(phase, remainingMs, visible);
  tickTimeoutId = setTimeout(tick, delay);
}

function tick() {
  const { event } = timer.tick(Date.now());
  if (event === 'rest-start') createReminderWindow();
  if (event === 'rest-end') closeReminderWindow();
  broadcast();
  scheduleTick();
}

function createReminderWindow() {
  if (reminderWindow && !reminderWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;
  const W = 300, H = 280;
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
  reminderWindow.loadFile('reminder.html');
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
    height: 360,
    resizable: false,
    icon,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('minimize', (e) => { e.preventDefault(); mainWindow.hide(); scheduleTick(); });
  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); scheduleTick(); }
  });
}

// Brings the main window to the front, creating it on demand. Needed because
// --hidden startup (e.g. autostart) skips createMainWindow(), leaving it null.
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
  scheduleTick();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromBuffer(createIconBuffer());
  tray = new Tray(icon);
  tray.setToolTip('脖子活动提醒');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showMainWindow());

  if (!HIDDEN) createMainWindow();

  scheduleTick();

  ipcMain.on('timer:start', () => { timer.start(Date.now()); broadcast(); scheduleTick(); });
  ipcMain.on('timer:pause', () => { timer.pause(Date.now()); broadcast(); });
  ipcMain.on('timer:reset', () => {
    timer.reset(Date.now());
    closeReminderWindow();
    broadcast();
    scheduleTick();
  });
  ipcMain.on('timer:setTimes', (_e, t) => {
    const activityMinutes = Math.max(1, Math.floor(Number(t.activityMinutes) || DEFAULTS.activityMinutes));
    const restMinutes = Math.max(DEFAULTS.restMinutes, Math.floor(Number(t.restMinutes) || DEFAULTS.restMinutes));
    timer.setTimes({ activityMinutes, restMinutes });
    saveConfig({ activityMinutes, restMinutes });
    broadcast();
    scheduleTick();
  });
  ipcMain.handle('timer:getState', () => timer.snapshot);
  ipcMain.handle('reminder:videos', () => videoUrls());
  ipcMain.on('reminder:close', () => {
    timer.skipRest(Date.now());
    closeReminderWindow();
    broadcast();
    scheduleTick();
  });
  ipcMain.handle('settings:getAutostart', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.on('settings:setAutostart', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
    saveConfig({ autoStart: Boolean(enabled) });
    broadcast();
  });
});

app.on('window-all-closed', (e) => { e.preventDefault(); }); // keep running in tray

app.on('before-quit', () => {
  if (tickTimeoutId) clearTimeout(tickTimeoutId);
});
