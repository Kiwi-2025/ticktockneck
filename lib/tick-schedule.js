// Delay (ms) until the next timer tick, based on current phase, remaining time,
// and whether the main window is visible.
// When visible, active phases tick every second so the displayed countdown animates.
// When hidden (tray), let the main process idle for up to a minute between checks.
function nextTickDelay(phase, remainingMs, visible = false) {
  if (phase === 'idle') return 60000; // nothing to animate
  if (visible) return 1000;            // window open: animate seconds
  if (phase === 'rest') return 1000;  // rest always counts down
  // activity, hidden:
  if (remainingMs <= 10 * 1000) return 1000;      // final 10s: smooth countdown
  if (remainingMs <= 60 * 1000) return 5000;       // approaching minute boundary
  return 60000;                                    // early in activity phase
}

module.exports = { nextTickDelay };
