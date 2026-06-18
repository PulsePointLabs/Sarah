export class EventQueue {
  constructor({ maxPending = 50000 } = {}) {
    this.maxPending = maxPending;
    this.pending = [];
    this.totalQueued = 0;
    this.droppedStored = 0;
    this.lastWarning = null;
  }

  enqueue(event) {
    if (this.pending.length >= this.maxPending) {
      this.droppedStored += 1;
      this.lastWarning = `Telemetry storage queue exceeded ${this.maxPending}; raw event was rejected.`;
      return false;
    }
    this.pending.push(event);
    this.totalQueued += 1;
    return true;
  }

  drain(limit = 1000) {
    if (!this.pending.length) return [];
    return this.pending.splice(0, Math.max(1, limit));
  }

  get length() {
    return this.pending.length;
  }

  status() {
    return {
      pending: this.pending.length,
      maxPending: this.maxPending,
      totalQueued: this.totalQueued,
      droppedStored: this.droppedStored,
      lastWarning: this.lastWarning,
    };
  }
}
