// 端到端冒烟测试：加载真实的 main.js，驱动真实窗口验证关键行为。
// 需要 Electron 运行时（不能用 node --test 跑）：
//   npm run smoke                  常规路径
//   npm run smoke -- --hidden      开机自启"仅驻留托盘"路径
//
// 尽量不打扰：窗口用真实路径开关、不反复弹窗；休息阶段靠把计时器快进
// 触发，不真的等一分钟。
require('../main.js');
const { showMainWindow, timer } = require('../main.js');
const { app, BrowserWindow, Menu } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
}
const sec = (t) => { const [m, s] = String(t).split(':').map(Number); return m * 60 + s; };
const finish = () => {
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  app.exit(failures === 0 ? 0 : 1);
};

setTimeout(() => { console.log('HARD TIMEOUT'); app.exit(2); }, 120000);

app.whenReady().then(async () => {
  await sleep(3000);

  // ---- 默认菜单已移除
  check('app menu removed', Menu.getApplicationMenu() === null, String(Menu.getApplicationMenu()));

  // ---- 静默启动路径：开机只驻留托盘，不建主窗口
  if (process.argv.includes('--hidden')) {
    check('no main window created on silent start', BrowserWindow.getAllWindows().length === 0,
      `windows=${BrowserWindow.getAllWindows().length}`);
    check('tray exists (app still running)', app.getAppMetrics().length > 0);
    showMainWindow(); // 托盘点击走的就是这条路径
    await sleep(2000);
    const wins = BrowserWindow.getAllWindows();
    check('tray click creates and shows the window', wins.length === 1 && wins[0].isVisible(),
      `windows=${wins.length}`);
    if (wins.length) {
      const heading = await wins[0].webContents.executeJavaScript(`document.querySelector('h1').textContent`);
      check('window content rendered', String(heading).includes('脖子'), String(heading));
    }
    return finish();
  }

  let win = BrowserWindow.getAllWindows()[0];
  check('main window visible after startup', win && win.isVisible());
  if (!win) { app.exit(1); return; }

  const js = (code) => win.webContents.executeJavaScript(code);
  const clock = () => js(`document.getElementById('clock').textContent`);

  // ---- 窗口内容已渲染
  const heading = await js(`document.querySelector('h1').textContent`);
  check('window content rendered', heading.includes('脖子'), heading);

  // ---- 启动计时器（走真实按钮）
  await js(`document.getElementById('startBtn').click()`);
  await sleep(1200);
  const c1 = await clock();
  await sleep(2200);
  const c2 = await clock();
  check('countdown animates every second while visible', c1 !== c2, `${c1} -> ${c2}`);

  // ---- 正在编辑的输入框不被定时刷新覆盖
  await js(`document.getElementById('activityInput').focus()`);
  await js(`document.getElementById('activityInput').value = '5'`);
  await sleep(2500); // > 2 ticks
  const v = await js(`document.getElementById('activityInput').value`);
  check('focused input keeps user edit', v === '5', `value=${v}`);
  await js(`document.getElementById('activityInput').blur()`);

  // ---- 关闭主窗口：应被销毁（而不是留一个看不见的渲染进程），托盘仍在
  const before = await clock();
  win.close();
  await sleep(800);
  check('main window destroyed on close', BrowserWindow.getAllWindows().length === 0,
    `windows=${BrowserWindow.getAllWindows().length}`);
  check('app still alive after window close', app.getAppMetrics().length > 0);

  // ---- 重新打开：窗口懒创建，倒计时必须是新鲜的
  const t0 = Date.now();
  showMainWindow();
  await sleep(2000);
  win = BrowserWindow.getAllWindows()[0];
  check('window recreated on demand', !!win && win.isVisible());
  const after = await clock();
  // 倒计时是 ceil 取整显示的，比较时留 1.5 秒的量化误差
  const elapsed = (Date.now() - t0) / 1000;
  const drift = sec(before) - sec(after);
  check('clock is fresh after reopen (not frozen)',
    drift >= elapsed - 2 && drift <= elapsed + 1,
    `${before} -> ${after} (drift ${drift}s, elapsed ${elapsed.toFixed(1)}s)`);

  // ---- 暂停后时钟冻结，恢复后继续走
  await js(`document.getElementById('pauseBtn').click()`);
  await sleep(1500);
  const p1 = await clock();
  await sleep(2500);
  const p2 = await clock();
  check('paused clock is frozen', p1 === p2, `${p1} -> ${p2}`);
  await js(`document.getElementById('startBtn').click()`);
  await sleep(1500);
  const r1 = await clock();
  await sleep(2200);
  const r2 = await clock();
  check('resume restarts the countdown', r1 !== r2, `${r1} -> ${r2}`);

  // ---- 快进到休息阶段：把 endAt 拨到过去，交给真实的 tick 逻辑判定
  timer.endAt = Date.now() - 1;
  await sleep(3000);
  const wins = BrowserWindow.getAllWindows();
  check('reminder window opened at rest-start', wins.length === 2, `windows=${wins.length}`);
  const rem = wins.find((w) => w !== win);
  if (rem) {
    const remClock = await rem.webContents.executeJavaScript(`document.getElementById('clock').textContent`);
    check('reminder countdown is fresh (not 00:00)', remClock !== '00:00' && sec(remClock) > 60, remClock);
    await sleep(2200);
    const remClock2 = await rem.webContents.executeJavaScript(`document.getElementById('clock').textContent`);
    check('reminder countdown animates', remClock !== remClock2, `${remClock} -> ${remClock2}`);
    await rem.webContents.executeJavaScript(`document.getElementById('closeBtn').click()`);
    await sleep(1200);
    check('reminder closed by 知道了', BrowserWindow.getAllWindows().length === 1, `windows=${BrowserWindow.getAllWindows().length}`);
  }
  const phase = await js(`document.getElementById('phase').textContent`);
  check('phase back to activity after skip', phase.includes('活动中'), phase);

  finish();
});
