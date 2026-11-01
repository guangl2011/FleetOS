/**
 * Injectable clock. Real adapters inject () => new Date().toISOString();
 * simulators inject a ManualClock so scenarios are deterministic (repo
 * convention: no unseeded wall-clock in tests).
 */
export interface Clock {
  now(): string;
}

/** Fixed-epoch clock that advances only when told to. */
export class ManualClock implements Clock {
  private iso: string;

  constructor(iso: string = "2026-01-01T00:00:00Z") {
    // Normalize to millisecond-precision ISO so every emitted ts has one format.
    this.iso = new Date(iso).toISOString();
  }

  now(): string {
    return this.iso;
  }

  advanceSeconds(seconds: number): void {
    this.iso = new Date(Date.parse(this.iso) + seconds * 1000).toISOString();
  }
}
