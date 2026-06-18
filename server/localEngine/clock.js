export class MonotonicClock {
  constructor({ wallTimeMs = Date.now(), hrtimeNs = process.hrtime.bigint() } = {}) {
    this.wallOriginMs = Number(wallTimeMs);
    this.hrOriginNs = BigInt(hrtimeNs);
    this.lastMonotonicMs = 0;
  }

  now() {
    const elapsedMs = Number(process.hrtime.bigint() - this.hrOriginNs) / 1_000_000;
    const monotonicMs = Math.max(this.lastMonotonicMs, elapsedMs);
    this.lastMonotonicMs = monotonicMs;
    const wallTimeMs = Math.round(this.wallOriginMs + monotonicMs);
    return {
      wallTimeMs,
      monotonicMs,
      receivedAt: new Date(wallTimeMs).toISOString(),
    };
  }
}
