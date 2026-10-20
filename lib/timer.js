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

  // snapshot.remainingMs 平时只在 tick() 里刷新，也就是两次 tick 之间读到的
  // 是上一次的值。窗口隐藏时 tick 是 60 秒一次，这时候把 snapshot 直接推给
  // 渲染进程，推过去的就是一个陈旧的倒计时。snapshotAt(now) 按当前时刻重算
  // 剩余时间，保证任何时刻广播出去的快照都是准的（不改变任何阶段切换逻辑）。
  snapshotAt(now) {
    const snap = this.snapshot;
    if (this.running && this.endAt != null) {
      snap.remainingMs = Math.max(0, this.endAt - now);
    }
    return snap;
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
