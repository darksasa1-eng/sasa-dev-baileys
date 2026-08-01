import { TypedEventEmitter } from '../Defaults/events';

export interface MemorySample {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes?: number;
  timestamp: number;
}

export interface MemoryMonitorEvents {
  sample: MemorySample;
  /** Emitted when heapUsed crosses above the threshold */
  thresholdExceeded: { sample: MemorySample; thresholdBytes: number };
  /** Emitted when heapUsed returns below the threshold (after crossing) */
  recovered: { sample: MemorySample; thresholdBytes: number };
}

export interface MemoryMonitorOptions {
  sampleIntervalMs?: number;
  /** Alert threshold for heapUsed (default 512 MiB) */
  thresholdBytes?: number;
  /** Keep last N samples (default 60) */
  historySize?: number;
}

/**
 * Memory Monitor — samples process memory on an interval, keeps a bounded
 * history, and emits threshold-crossing events so hosts can react
 * (e.g. prune caches, trigger GC via --expose-gc, restart workers).
 */
export class MemoryMonitor extends TypedEventEmitter<MemoryMonitorEvents> {
  readonly #opts: Required<MemoryMonitorOptions>;
  #timer: NodeJS.Timeout | undefined;
  #history: MemorySample[] = [];
  #overThreshold = false;

  constructor(options: MemoryMonitorOptions = {}) {
    super();
    this.#opts = {
      sampleIntervalMs: options.sampleIntervalMs ?? 30_000,
      thresholdBytes: options.thresholdBytes ?? 512 * 1024 * 1024,
      historySize: options.historySize ?? 60,
    };
  }

  start(): void {
    if (this.#timer) return;
    this.#sample();
    this.#timer = setInterval(() => this.#sample(), this.#opts.sampleIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #sample(): void {
    const mem = process.memoryUsage();
    const sample: MemorySample = {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
      timestamp: Date.now(),
    };
    this.#history.push(sample);
    if (this.#history.length > this.#opts.historySize) this.#history.shift();
    this.emit('sample', sample);

    const over = sample.heapUsedBytes > this.#opts.thresholdBytes;
    if (over && !this.#overThreshold) {
      this.#overThreshold = true;
      this.emit('thresholdExceeded', { sample, thresholdBytes: this.#opts.thresholdBytes });
    } else if (!over && this.#overThreshold) {
      this.#overThreshold = false;
      this.emit('recovered', { sample, thresholdBytes: this.#opts.thresholdBytes });
    }
  }

  /** Current sample without waiting for the tick */
  sample(): MemorySample {
    const mem = process.memoryUsage();
    return {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
      timestamp: Date.now(),
    };
  }

  get history(): readonly MemorySample[] {
    return this.#history;
  }

  override dispose(): void {
    this.stop();
    this.#history = [];
    this.removeAllListeners();
  }
}
