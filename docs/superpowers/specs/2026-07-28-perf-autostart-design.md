# Performance Optimization & Auto-Start — Design

Date: 2026-07-28
Status: Approved

## Goal

Reduce runtime memory/CPU footprint of the Electron app and add a toggleable
"launch at login" feature that starts silently to the tray (minimal boot impact).

User decisions: **conservative optimization** (no GPU changes, keep video smooth)
and **toggleable silent autostart** (`--hidden`, configurable in the main window).

## Non-goals (conservative scope)

- Do not disable GPU / hardware acceleration (would hurt video playback).
- Do not change `lib/timer.js` phase-transition logic (keep existing tests green).
- Do not lower timer accuracy (stays minute-exact via `endAt`).
- No separate settings window — the autostart checkbox fits in the existing main window.

## Component 1 — Auto-start

### Launch flag

- Parse `process.argv` for `--hidden` at startup.
- When `--hidden` is present: skip `createMainWindow()`; create only the tray
  and start the timer loop. The window is opened later via the existing
  tray-click handler.
- Result: on boot the app appears as a tray icon only — no window, no reminder
  popup — so perceived boot impact is near zero.

### Toggle mechanism

- Use Electron's native `app.setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`.
  This writes the Windows `Run` registry key + startup-approved entry — no
  shortcut file to manage, cleanly toggleable.
- Read current state with `app.getLoginItemSettings().openAtLogin`.

### UI

- New checkbox "开机自启" in the main window, below the existing controls.
- On load, reflect the OS-level autostart state.
- Persist user intent in the existing `config.json` (`autoStart: bool`) so we
  can restore the checkbox even if the registry entry is cleared externally.

### IPC wiring

- `settings:getAutostart` (invoke) → returns current openAtLogin bool.
- `settings:setAutostart` (on) → sets openAtLogin + args, persists to config.
- `preload.js` exposes `getAutostart()` / `setAutostart(bool)`.

## Component 2 — Performance

### Timer throttle (main process)

- Replace the fixed 1s `setInterval(tick, 1000)` with a self-scheduling
  `setTimeout` whose delay is derived from the current phase and remaining time.
- New pure helper `nextTickDelay(phase, remainingMs)` in a small module
  `lib/tick-schedule.js`:
  - `rest` phase or `remainingMs <= 10_000`: delay = 1000ms (1s, for a smooth countdown).
  - `activity` phase with `remainingMs > 60_000`: delay = 60_000ms (wake once a minute).
  - `activity` phase with `10_000 < remainingMs <= 60_000`: delay = 5_000ms (tighten as the minute boundary approaches).
  - `idle` / not running: delay = 60_000ms (cheap keep-alive poll).
- This lets the main process idle between checks instead of waking every second.

### Reduced broadcast frequency

- `broadcast()` currently sends a full snapshot to both windows every second.
- Only send when the displayed `mm:ss` value would actually change. Track the
  last sent `mm:ss` string; skip the IPC if it's unchanged. During the long
  activity phase this cuts broadcasts from ~1/sec to ~1/min.

### Reminder video lifecycle

- On `<video>` in `reminder.html`: set `preload="metadata"` so the full mp4
  isn't buffered into memory until playback starts.
- In `reminder.js`, when the window is about to close (or on `beforeunload`):
  `videoEl.pause()`; `videoEl.src = ''`; `videoEl.load()`. This releases the
  media pipeline promptly instead of letting decode linger during teardown.
- `main.js` already calls `closeReminderWindow()` on rest-end/skip; the
  reminder window's `beforeunload` handles the teardown, so no main-process
  change is needed for the media-release part.

### V8 / startup

- Verify asar packaging is enabled in the electron-builder config (default is
  on). No code change expected — confirmation only.

## Testing

- Existing 11 timer tests stay green (no `timer.js` changes).
- New unit tests for `nextTickDelay(phase, remainingMs)` covering all branches:
  idle, activity > 60s, activity 10–60s, activity ≤ 10s, rest. Uses `node --test`
  like the existing suite.
- Auto-start is OS integration (registry); verified manually by toggling and
  confirming `--hidden` is parsed and the window is suppressed on launch.

## Files touched

| File | Change |
|------|--------|
| `main.js` | `--hidden` parse; autostart IPC + config; setTimeout-based tick; broadcast dedupe |
| `lib/tick-schedule.js` | NEW — `nextTickDelay` pure helper |
| `test/tick-schedule.test.js` | NEW — unit tests for the helper |
| `preload.js` | expose `getAutostart` / `setAutostart` |
| `index.html` | add "开机自启" checkbox |
| `renderer.js` | wire checkbox to API |
| `reminder.html` | `preload="metadata"` on video |
| `reminder.js` | media-release on teardown |
| `package.json` | confirm asar on (no change expected) |
