const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { TimerState } = require('./lib/timer.js');
const { createIconBuffer } = require('./lib/icon.js');
const { nextTickDelay } = require('./lib/tick-schedule.js');

const DEFAULTS = { activityMinutes: 30, restMinutes: 2 };
const LOGO_PATH = path.join(__dirname, 'logo.jpg');

// logo.jpg is a large picture: the clock artwork sits in the middle and a
// light-grey watermark band runs along the bottom edge. This scans for the
// dark clock strokes only (the watermark is lighter than the threshold), so
// the tray / window icon can be cropped to a tight square around the clock.
function clockBounds(bitmap, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4; // BGRA
      const lum = (bitmap[o] + bitmap[o + 1] + bitmap[o + 2]) / 3;
      if (lum >= 100) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

// Builds an icon of the requested pixel size from logo.jpg. Returns null when
// the logo file is missing or unreadable, so callers can fall back.
// The bytes are read with fs (asar-aware) and decoded from a buffer, so this
// also works when logo.jpg is packed inside app.asar.
function createLogoIcon(size) {
  let logo;
  try {
    logo = nativeImage.createFromBuffer(fs.readFileSync(LOGO_PATH));
  } catch {
    return null;
  }
  if (logo.isEmpty()) return null;
  const { width, height } = logo.getSize();
  const bounds = clockBounds(logo.toBitmap(), width, height);
  if (!bounds) return null;

  const clockW = bounds.maxX - bounds.minX + 1;
  const clockH = bounds.maxY - bounds.minY + 1;
  const side = Math.min(Math.round(Math.max(clockW, clockH) * 1.08), Math.min(width, height));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const x = Math.round(Math.min(Math.max(cx - side / 2, 0), width - side));
  const y = Math.round(Math.min(Math.max(cy - side / 2, 0), height - side));

  return logo.crop({ x, y, width: side, height: side })
    .resize({ width: size, height: size, quality: 'best' });
}

// App / tray icon: the logo when available, otherwise the generated teal square.
function createIcon(size) {
  return createLogoIcon(size) || nativeImage.createFromBuffer(createIconBuffer());
}

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
const config = loadConfig();
const timer = new TimerState(config);

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
  mainWindow = new BrowserWindow({
    width: 360,
    height: 360,
    resizable: false,
    icon: createIcon(256),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('minimize', (e) => { e.preventDefault(); mainWindow.hide(); scheduleTick(); });
  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); scheduleTick(); }
  });
}

// Brings the main window to the front, lazily creating it if it was never
// created or has been destroyed. Used by the tray click / context menu handlers.
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
  // Windows tray icons are small; 32px keeps the clock strokes readable on
  // high-DPI displays while Windows downscales for the classic 16px tray.
  tray = new Tray(createIcon(32));
  tray.setToolTip('脖子活动提醒');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showMainWindow());

  // 迁移老版本残留的自启条目：旧版注册时带了 args: ['--hidden']，会导致开机后主窗口不显示。
  // 先按旧参数精确移除该条目，再按用户当前意愿干净地重新注册（无 args）。
  const launchItems = app.getLoginItemSettings().launchItems || [];
  const hasStaleHidden = launchItems.some((it) => (it.args || []).includes('--hidden'));
  if (hasStaleHidden) {
    app.setLoginItemSettings({ openAtLogin: false, args: ['--hidden'] });
    if (config.autoStart) app.setLoginItemSettings({ openAtLogin: true });
  }

  createMainWindow();

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
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    saveConfig({ autoStart: Boolean(enabled) });
    broadcast();
  });
});

app.on('window-all-closed', (e) => { e.preventDefault(); }); // keep running in tray

app.on('before-quit', () => {
  if (tickTimeoutId) clearTimeout(tickTimeoutId);
});
