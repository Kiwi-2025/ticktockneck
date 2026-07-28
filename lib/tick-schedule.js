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
