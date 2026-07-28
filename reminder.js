const videoEl = document.getElementById('video');
const clockEl = document.getElementById('clock');

const PAUSE_MS = 10000;
let idx = 0;
window.api.getVideos().then((videos) => {
  if (!videos || !videos.length) return;
  videoEl.src = videos[0];
  videoEl.play();
  videoEl.addEventListener('ended', () => {
    const justFinished = idx;
    idx = (idx + 1) % videos.length;
    const playNext = () => { videoEl.src = videos[idx]; videoEl.play(); };
    if (justFinished === 0) playNext();        // action 1 -> 2: no pause
    else setTimeout(playNext, PAUSE_MS);       // actions 2-5: 10s pause
  });
});

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

window.addEventListener('beforeunload', () => {
  try {
    videoEl.pause();
    videoEl.src = '';
    videoEl.load();
  } catch {}
});
