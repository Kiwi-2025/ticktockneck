const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { execFileSync } = require('child_process');
const { TimerState } = require('./lib/timer.js');
const { createIconBuffer } = require('./lib/icon.js');
const { nextTickDelay } = require('./lib/tick-schedule.js');
const { loginItemArgs } = require('./lib/login-item.js');
const {
  resolveAutostartPath,
  parseRunKeyEntries,
  staleLoginItemNames,
} = require('./lib/autostart.js');

const DEFAULTS = { activityMinutes: 30, restMinutes: 2, autoStart: false, silentStart: false, portableExe: '' };
const LOGO_PATH = path.join(__dirname, 'logo.jpg');
// 便携版引导程序会设置这个环境变量：用户双击的那个便携 exe。它不是 %TEMP% 里
// 被解包出来的临时副本，正是登录项应该记住的路径。
const PORTABLE_EXE = process.env.PORTABLE_EXECUTABLE_FILE || '';
// 开机自启写在 HKCU 的这个 Run 键下（Electron 使用的就是它）。
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// 首帧迟迟画不出来（程序副本残缺、渲染进程崩溃等）时，等多久就认定这个窗口
// 没法用。宁可报错，也不要把一个空白窗口摆到用户面前。
const FIRST_PAINT_TIMEOUT_MS = 8000;
// 开机自启选择"仅驻留托盘"时，系统登录项会带上这个参数：启动后只建托盘，
// 不建主窗口。
const HIDDEN = process.argv.includes('--hidden');

// 窗口不需要原生菜单栏（托盘用的是独立的 Tray contextMenu）。不提前清掉的
// 话，Electron 会为每个 BrowserWindow 搭建一套默认菜单栏，既拖慢启动，
// 又在窗口顶部多出一条用不上的 File/Edit/View 菜单。必须在 app ready 前调用。
Menu.setApplicationMenu(null);

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
      silentStart: Boolean(cfg.silentStart),
      portableExe: typeof cfg.portableExe === 'string' ? cfg.portableExe : '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}
// 以内存里的 config 为基准做合并写：config 在启动时已经完整读过一次，
// 不必每次保存都再读一遍磁盘。保留同步写——文件只有一百来字节，
// 异步反而可能在退出瞬间丢掉最后一次修改。
function saveConfig(patch) {
  try {
    Object.assign(config, patch);
    fs.writeFileSync(configPath(), JSON.stringify(config));
  } catch {}
}

let tray = null;
let mainWindow = null;
let reminderWindow = null;
let quitting = false;
let tickTimeoutId = null;
// 主窗口当前是否可见。用 show/hide 事件维护，而不是每次问 isVisible()：
// show/hide 事件的时序更确定，scheduleTick 不会在窗口刚显示的瞬间读到
// 过期的可见性，从而把 1 秒的倒计时刷新退化成 60 秒一次。
let mainWindowVisible = false;
// 主窗口是否已经画出过首帧。没画出来之前绝不 show()（那只会露一个空白窗口）。
let mainWindowPainted = false;
let firstPaintTimeoutId = null;
let paintFailureReported = false;
const config = loadConfig();
const timer = new TimerState(config);

// 视频列表在运行期不会变，读一次就够了——省掉每次弹窗时的一次磁盘扫描。
let videoUrlCache = null;
function videoUrls() {
  if (videoUrlCache) return videoUrlCache;
  try {
    const dir = path.join(__dirname, 'gif');
    videoUrlCache = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.mp4'))
      .sort()
      .map(f => url.pathToFileURL(path.join(dir, f)).href);
  } catch {
    videoUrlCache = [];
  }
  return videoUrlCache;
}

// 登录项该指向哪个 exe：优先用户双击的便携 exe（PORTABLE_EXECUTABLE_FILE），
// 其次上次记住的路径，最后才是 process.execPath。临时目录里的副本一律排除 ——
// 便携版在 %TEMP% 下的解包目录退出即删，写进登录项就会让下次开机去启动一个
// 残缺副本（详见 lib/autostart.js）。
function autostartTarget() {
  return resolveAutostartPath({
    execPath: process.execPath,
    portableExeFile: PORTABLE_EXE,
    rememberedPath: config.portableExe,
    tmpDir: app.getPath('temp'),
  });
}

// 清掉历史登录项里指向临时目录的条目。旧版本调用 setLoginItemSettings 时没给
// path，Electron 默认用 process.execPath —— 也就是便携版的临时解包副本。
//
// 为什么直接读注册表：Electron 的 getLoginItemSettings().launchItems 拿不到我们自己
// 那条（同名条目会被当成"自己"排除掉，实测恒为空），靠它做迁移等于没做。
function removeStaleLoginItems() {
  if (process.platform !== 'win32') return;
  try {
    const output = execFileSync('reg', ['query', RUN_KEY], { encoding: 'utf8', windowsHide: true });
    const names = staleLoginItemNames(parseRunKeyEntries(output), {
      tmpDir: app.getPath('temp'),
      // 只认 exe 名字和自己一样的条目：临时副本里的 exe 也叫 ticktockneck.exe。
      exeName: path.basename(process.execPath),
    });
    for (const name of names) {
      execFileSync('reg', ['delete', RUN_KEY, '/v', name, '/f'], { windowsHide: true });
      console.warn('autostart: removed stale login item pointing into temp:', name);
    }
  } catch {}
}

// 把当前的自启设置写进系统登录项。silentStart 决定是否带 --hidden
// （开机只驻留托盘、不弹主窗口）。
function applyLoginItem() {
  try {
    removeStaleLoginItems();
    if (!config.autoStart) {
      app.setLoginItemSettings({ openAtLogin: false });
      return;
    }
    const target = autostartTarget();
    if (!target) {
      // 连一个稳定路径都拿不到（正跑在临时副本里，也没记住过便携 exe 的路径）：
      // 宁可不注册，也不要写一个下次开机必然失效的路径。
      console.warn('autostart: no stable executable path, login item not registered');
      app.setLoginItemSettings({ openAtLogin: false });
      return;
    }
    app.setLoginItemSettings({ openAtLogin: true, path: target, args: loginItemArgs(config) });
  } catch {}
}

// 界面上的"开机自启"勾选框该显示什么状态。便携版跑在 %TEMP% 的副本里时，
// getLoginItemSettings() 默认只认当前 exe，会把"其实已经注册到便携 exe 的自启"
// 错报成关闭，所以按登录项真正指向的路径去查。
function autostartEnabled() {
  try {
    const target = autostartTarget();
    const settings = target
      ? app.getLoginItemSettings({ path: target, args: loginItemArgs(config) })
      : app.getLoginItemSettings();
    return Boolean(settings.openAtLogin);
  } catch {
    return false;
  }
}

function broadcast() {
  // 用 snapshotAt 按当前时刻重算剩余时间：两次 tick 之间 snapshot 里的
  // remainingMs 是旧值，窗口隐藏时 tick 是 60 秒一次，直接推就会推陈旧数据。
  const snap = timer.snapshotAt(Date.now());
  // 只推给可见的窗口：隐藏的主窗口收到 IPC 也会被唤醒，白做一次 DOM 更新。
  // 窗口重新显示时由 'show' 事件补发一次，状态不会丢。
  if (mainWindowVisible && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('timer:tick', snap);
  }
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.webContents.send('timer:tick', snap);
  }
}

function scheduleTick() {
  if (tickTimeoutId) { clearTimeout(tickTimeoutId); tickTimeoutId = null; }
  // 计时器没在跑的时候状态不会自行变化，挂定时器只是白白唤醒进程。
  // 状态真正变化的入口（开始/重置/改时长/跳过休息）都会重新调用 scheduleTick。
  if (!timer.running) return;
  const { phase, remainingMs } = timer.snapshotAt(Date.now());
  const delay = nextTickDelay(phase, remainingMs, mainWindowVisible);
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
  const win = new BrowserWindow({
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
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  });
  reminderWindow = win;
  win.loadFile(path.join(__dirname, 'reminder.html'));
  win.once('ready-to-show', () => win.show());
  // 弹窗一露面就把当前剩余时间推过去，避免倒计时从 00:00 空跑一秒。
  win.on('show', () => broadcast());
  win.on('closed', () => { if (reminderWindow === win) reminderWindow = null; });
}

function closeReminderWindow() {
  if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close();
  reminderWindow = null;
}

// 主窗口隐藏后直接销毁，而不是留着看不见的渲染进程常驻——实测一个隐藏的
// BrowserWindow 仍然占着约 62MB。计时状态在主进程里，窗口随时可以重建。
function destroyMainWindow() {
  const win = mainWindow;
  mainWindow = null;
  mainWindowVisible = false;
  clearFirstPaintWatchdog();
  if (win && !win.isDestroyed()) win.destroy(); // destroy 不会触发 'close'，只有 'closed'
  scheduleTick();
}

function clearFirstPaintWatchdog() {
  if (firstPaintTimeoutId) { clearTimeout(firstPaintTimeoutId); firstPaintTimeoutId = null; }
}

// 打包后 Chromium 的资源包和 exe 在同一个目录里。缺了它们，渲染进程一个像素
// 都画不出来，但主进程、托盘照常工作 —— 这正是"窗口打开了、里面什么都没有"的成因
// （开机自启跑到便携版被删了一半的临时副本时就是这样）。
function missingBrowserResources() {
  if (!app.isPackaged) return [];
  const dir = path.dirname(process.execPath);
  return ['resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak']
    .filter((file) => !fs.existsSync(path.join(dir, file)));
}

// 窗口等不到首帧：不要让它变成用户点得出来的空白窗口，直接说明原因。
// 只弹一次错误框，避免反复点托盘时刷屏。
function reportUnpaintableWindow(win) {
  const missing = missingBrowserResources();
  console.error('main window never painted; missing resources:', missing.join(', ') || '(none)');
  if (mainWindow === win) { mainWindow = null; mainWindowVisible = false; }
  if (win && !win.isDestroyed()) win.destroy();
  if (paintFailureReported) return;
  paintFailureReported = true;
  const hint = config.portableExe || PORTABLE_EXE;
  const lines = [
    '界面窗口没能显示内容，程序文件似乎不完整。',
    missing.length ? `缺少资源文件：${missing.join('、')}` : '',
    '',
    '常见原因：开机自启指向了便携版在临时目录里的解压副本，而该副本已被系统清理。',
    hint ? `请直接运行原始的便携版 exe：\n${hint}` : '请直接运行下载的便携版 exe。',
    '程序会自动把开机自启项修正为这个路径。',
  ].filter((line) => line !== '');
  try {
    dialog.showErrorBox('脖子活动提醒 — 无法显示界面', lines.join('\n'));
  } catch {}
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 360,
    height: 360,
    resizable: false,
    show: false,              // 等首帧画好再显示，避免白闪
    backgroundColor: '#1f2937', // 与 styles.css 的 body 底色一致
    icon: createIcon(256),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,      // 界面只有两个数字输入框，拼写检查纯属浪费
    },
  });
  mainWindow = win;
  mainWindowPainted = false;
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    mainWindowPainted = true;
    clearFirstPaintWatchdog();
    win.show();
    win.focus();
  });
  // 兜底：页面加载失败时 ready-to-show 不会触发，窗口会一直隐形。
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    console.error('main window failed to load:', code, desc);
    if (!win.isDestroyed()) win.show();
  });
  // 渲染进程崩溃同样会留下一个空白窗口，收掉它，下次点托盘重新创建。
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('main window renderer gone:', details && details.reason, details && details.exitCode);
    if (!details || details.reason === 'clean-exit' || details.reason === 'killed') return;
    if (mainWindow === win) setImmediate(destroyMainWindow);
  });
  // 看门狗：等够时间还没有首帧，就按"画不出来"处理，而不是留个空白窗口。
  clearFirstPaintWatchdog();
  firstPaintTimeoutId = setTimeout(() => {
    firstPaintTimeoutId = null;
    if (mainWindowPainted || win.isDestroyed()) return;
    reportUnpaintableWindow(win);
  }, FIRST_PAINT_TIMEOUT_MS);
  // 重新显示时补发一次快照：窗口隐藏期间不推 IPC，重新打开不能是旧值。
  win.on('show', () => {
    mainWindowVisible = true;
    broadcast();
    scheduleTick();
  });
  win.on('hide', () => {
    mainWindowVisible = false;
    scheduleTick();
  });
  win.on('minimize', (e) => { e.preventDefault(); destroyMainWindow(); });
  win.on('close', (e) => {
    // 放在下一个事件循环再销毁：close 事件还在处理中，destroy() 属于重入。
    if (!quitting) { e.preventDefault(); setImmediate(destroyMainWindow); }
  });
  win.on('closed', () => {
    clearFirstPaintWatchdog();
    if (mainWindow === win) { mainWindow = null; mainWindowVisible = false; mainWindowPainted = false; }
  });
}

// Brings the main window to the front, lazily creating it if it was never
// created or has been destroyed. Used by the tray click / context menu handlers.
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(); // 新建的窗口由 'ready-to-show' 负责显示
    return;
  }
  // 首帧还没画出来就 show()，用户看到的只会是一片空白——这正是"开机自启后
  // 点托盘，窗口打开了但里面什么都没有"的症状。等 ready-to-show 自己显示；
  // 一直等不到则由看门狗报错。
  if (!mainWindowPainted) return;
  mainWindow.show();
  mainWindow.focus();
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

  // 记住便携 exe 的真实路径：以后再从临时副本里启动（例如旧登录项拉起的残骸），
  // 也能把登录项修回这个路径。
  if (PORTABLE_EXE && PORTABLE_EXE !== config.portableExe) saveConfig({ portableExe: PORTABLE_EXE });

  // 登录项自愈：把指向临时副本的坏条目删掉，按当前设置重新注册到稳定路径。
  // 开发运行（npm start）不该改系统登录项，所以只在打包版里做。
  if (app.isPackaged) applyLoginItem();

  // 开机自启选了"仅驻留托盘"：只建托盘，不建主窗口，点托盘图标时再懒创建。
  if (!HIDDEN) createMainWindow();

  scheduleTick();

  // 睡眠期间挂起的定时器醒来后不一定准时触发，这里立刻补一次 tick，
  // 让计时状态和当前时刻对齐。
  powerMonitor.on('resume', () => {
    const { event } = timer.tick(Date.now());
    if (event === 'rest-start') createReminderWindow();
    if (event === 'rest-end') closeReminderWindow();
    broadcast();
    scheduleTick();
  });

  ipcMain.on('timer:start', () => { timer.start(Date.now()); broadcast(); scheduleTick(); });
  // 暂停后计时器不再运行，scheduleTick 会把挂起的定时器收掉，不再空转唤醒。
  ipcMain.on('timer:pause', () => { timer.pause(Date.now()); broadcast(); scheduleTick(); });
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
  ipcMain.handle('timer:getState', () => timer.snapshotAt(Date.now()));
  ipcMain.handle('reminder:videos', () => videoUrls());
  ipcMain.on('reminder:close', () => {
    timer.skipRest(Date.now());
    closeReminderWindow();
    broadcast();
    scheduleTick();
  });
  ipcMain.handle('settings:getAutostart', () => autostartEnabled());
  ipcMain.on('settings:setAutostart', (_e, enabled) => {
    config.autoStart = Boolean(enabled);
    saveConfig({ autoStart: config.autoStart });
    applyLoginItem();
  });
  ipcMain.handle('settings:getSilentStart', () => Boolean(config.silentStart));
  ipcMain.on('settings:setSilentStart', (_e, enabled) => {
    config.silentStart = Boolean(enabled);
    saveConfig({ silentStart: config.silentStart });
    applyLoginItem();
  });
});

// 测试钩子：仅供 scripts/smoke.js 驱动内部状态，Electron 运行时不会使用。
module.exports = {
  showMainWindow,
  destroyMainWindow,
  timer,
  isMainWindowPainted: () => mainWindowPainted,
};

app.on('window-all-closed', (e) => { e.preventDefault(); }); // keep running in tray

app.on('before-quit', () => {
  if (tickTimeoutId) clearTimeout(tickTimeoutId);
  clearFirstPaintWatchdog();
});
