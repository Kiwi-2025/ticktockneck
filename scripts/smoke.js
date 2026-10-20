// 端到端冒烟测试：加载真实的 main.js，驱动真实窗口验证关键行为。
// 需要 Electron 运行时（不能用 node --test 跑）：npm run smoke
require('../main.js');
const { app, BrowserWindow, Menu } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
}

setTimeout(() => { console.log('HARD TIMEOUT'); app.exit(2); }, 150000);

app.whenReady().then(async () => {
  await sleep(3000);

  // ---- #4 default application menu removed
  check('#4 app menu removed', Menu.getApplicationMenu() === null, String(Menu.getApplicationMenu()));

  const win = BrowserWindow.getAllWindows()[0];
  check('main window visible after startup', win.isVisible());

  const js = (code) => win.webContents.executeJavaScript(code);
  const clock = () => js(`document.getElementById('clock').textContent`);
  const inputVal = () => js(`document.getElementById('activityInput').value`);

  // ---- #5 window actually rendered (not a blank frame)
  const heading = await js(`document.querySelector('h1').textContent`);
  check('#5 window content rendered', heading.includes('脖子'), heading);

  // ---- start the timer via the real button
  await js(`document.getElementById('startBtn').click()`);
  await sleep(1200);
  const c1 = await clock();
  await sleep(2200);
  const c2 = await clock();
  check('countdown animates every second while visible', c1 !== c2, `${c1} -> ${c2}`);

  // ---- #11 focused input is not clobbered by the 1s tick
  await js(`document.getElementById('activityInput').focus()`);
  await js(`document.getElementById('activityInput').value = '5'`);
  await sleep(2500); // > 2 ticks
  const v = await inputVal();
  check('#11 focused input keeps user edit', v === '5', `value=${v}`);
  await js(`document.getElementById('activityInput').blur()`);

  // ---- #10/#9 hidden window stops receiving ticks, but re-showing is fresh
  const before = await clock();
  win.hide();
  await sleep(6000);
  win.show();
  await sleep(400); // let the 'show' handler broadcast
  const after = await clock();
  const sec = (t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };
  const drift = sec(before) - sec(after);
  check('#10 clock is fresh after re-show (not frozen)', drift >= 5 && drift <= 8, `${before} -> ${after} (drift ${drift}s)`);

  // ---- #8 paused timer stops the poll loop, resume restarts it
  await js(`document.getElementById('pauseBtn').click()`);
  await sleep(1500);
  const p1 = await clock();
  await sleep(2500);
  const p2 = await clock();
  check('#8 paused clock is frozen', p1 === p2, `${p1} -> ${p2}`);
  await js(`document.getElementById('startBtn').click()`);
  await sleep(1500);
  const r1 = await clock();
  await sleep(2200);
  const r2 = await clock();
  check('resume restarts the countdown', r1 !== r2, `${r1} -> ${r2}`);

  // ---- rest phase: reminder window appears, counts down, and can be skipped
  await js(`
    document.getElementById('activityInput').value = '1';
    document.getElementById('activityInput').dispatchEvent(new Event('change'));
    document.getElementById('restInput').value = '2';
    document.getElementById('restInput').dispatchEvent(new Event('change'));
    document.getElementById('resetBtn').click();
    document.getElementById('startBtn').click();
  `);
  check('activity set to 1 minute', true, 'waiting for the rest phase...');
  await sleep(68000);
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

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  app.exit(failures === 0 ? 0 : 1);
});
