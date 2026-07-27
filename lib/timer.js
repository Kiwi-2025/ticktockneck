const MIN = 60 * 1000;

class TimerState {
  constructor({ activityMinutes, restMinutes }) {
    this.activityMinutes = activityMinutes;
    this.restMinutes = restMinutes;
    this.phase = 'idle';            // 'idle' | 'activity' | 'rest'
    this.running = false;
    this.remainingMs = this.activityMinutes * MIN;
    this.endAt = null;              // epoch ms when current run ends; null when paused/idle
  }

  get snapshot() {
    return {
      phase: this.phase,
      remainingMs: this.remainingMs,
      running: this.running,
      activityMinutes: this.activityMinutes,
      restMinutes: this.restMinutes,
    };
  }

  setTimes({ activityMinutes, restMinutes }) {
    this.activityMinutes = activityMinutes;
    this.restMinutes = restMinutes;
    if (this.phase === 'idle') {
      this.remainingMs = this.activityMinutes * MIN;
    }
  }

  start(now) {
    if (this.running) return;
    if (this.phase === 'idle') {
      this.phase = 'activity';
      this.remainingMs = this.activityMinutes * MIN;
    }
    this.running = true;
    this.endAt = now + this.remainingMs;
  }

  pause(now) {
    if (!this.running) return;
    this.remainingMs = Math.max(0, this.endAt - now);
    this.running = false;
    this.endAt = null;
  }

  reset(now) {
    this.phase = 'idle';
    this.running = false;
    this.remainingMs = this.activityMinutes * MIN;
    this.endAt = null;
  }

  skipRest(now) {
    if (this.phase !== 'rest') return;
    this.phase = 'activity';
    this.remainingMs = this.activityMinutes * MIN;
    this.running = true;
    this.endAt = now + this.remainingMs;
  }

  tick(now) {
    if (!this.running) return { event: null };
    this.remainingMs = Math.max(0, this.endAt - now);
    if (this.remainingMs > 0) return { event: null };
    // phase elapsed -> transition
    if (this.phase === 'activity') {
      this.phase = 'rest';
      this.remainingMs = this.restMinutes * MIN;
      this.endAt = now + this.remainingMs;
      return { event: 'rest-start' };
    }
    // phase === 'rest'
    this.phase = 'activity';
    this.remainingMs = this.activityMinutes * MIN;
    this.endAt = now + this.remainingMs;
    return { event: 'rest-end' };
  }
}

module.exports = { TimerState };
