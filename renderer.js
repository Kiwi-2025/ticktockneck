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

// 正在被编辑的输入框不能被定时刷新覆盖——否则用户刚敲进去的字符会在
// change 事件触发前被冲掉，框里根本打不进字。值没变也不必写 DOM。
function setInputValue(el, value) {
  if (el === document.activeElement) return;
  const next = String(value);
  if (el.value !== next) el.value = next;
}

function render(snap) {
  if (!snap) return;
  phaseEl.textContent = PHASE_LABEL[snap.phase] || snap.phase;
  clockEl.textContent = fmt(snap.remainingMs);
  setInputValue(activityInput, snap.activityMinutes);
  setInputValue(restInput, snap.restMinutes);
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

const autoStartInput = document.getElementById('autoStartInput');
window.api.getAutostart().then((on) => { autoStartInput.checked = on; });
autoStartInput.addEventListener('change', () => window.api.setAutostart(autoStartInput.checked));
