/**
 * Connection + performance metrics.
 *
 * Zero-dependency, aggregation-in-memory model: counters, gauges, and
 * fixed-window latency histograms. Designed for both introspection
 * (`snapshot()`) and periodic exporting.
 */

export interface LatencyWindow {
  count: number;
  min: number;
  max: number;
  sum: number;
  /** last N samples (ring buffer) */
  recent: number[];
}

export interface MetricsSnapshot {
  uptimeMs: number;
  startedAt: number;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  latencies: Record<string, LatencyWindow>;
  /** derived connection statistics */
  connection: ConnectionStatistics;
}

export interface ConnectionStatistics {
  connectAttempts: number;
  connectSuccesses: number;
  reconnects: number;
  disconnects: number;
  streamErrors: number;
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
  averageLatencyMs: number;
  lastLatencyMs: number;
}

const LATENCY_RING = 128;

export class ConnectionMetrics {
  #counters = new Map<string, number>();
  #gauges = new Map<string, number>();
  #latencies = new Map<string, LatencyWindow & { ringIdx: number; samples: number[] }>();
  readonly startedAt = Date.now();

  increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  decrement(name: string, by = 1): void {
    this.increment(name, -by);
  }

  counter(name: string): number {
    return this.#counters.get(name) ?? 0;
  }

  gauge(name: string, value: number): void {
    this.#gauges.set(name, value);
  }

  /** Record a latency/duration sample (ms) */
  timing(name: string, ms: number): void {
    let win = this.#latencies.get(name);
    if (!win) {
      win = { count: 0, min: Infinity, max: -Infinity, sum: 0, samples: [], ringIdx: 0, recent: [] };
      this.#latencies.set(name, win);
    }
    win.count += 1;
    win.sum += ms;
    win.min = Math.min(win.min, ms);
    win.max = Math.max(win.max, ms);
    if (win.samples.length < LATENCY_RING) win.samples.push(ms);
    else {
      win.samples[win.ringIdx % LATENCY_RING] = ms;
      win.ringIdx += 1;
    }
  }

  /** Time an async operation, recording success + error duration */
  async timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.timing(name, performance.now() - t0);
    }
  }

  latency(name: string): LatencyWindow | undefined {
    const win = this.#latencies.get(name);
    return win ? { count: win.count, min: win.min, max: win.max, sum: win.sum, recent: [...win.samples] } : undefined;
  }

  snapshot(): MetricsSnapshot {
    const latencyStats = this.#latencies.get('socket:roundtrip');
    const avgLatency = latencyStats && latencyStats.count > 0 ? Math.round(latencyStats.sum / latencyStats.count) : 0;
    const lastSample =
      latencyStats && latencyStats.samples.length > 0
        ? (latencyStats.samples[(latencyStats.samples.length - 1) % LATENCY_RING] ?? 0)
        : 0;
    return {
      uptimeMs: Date.now() - this.startedAt,
      startedAt: this.startedAt,
      counters: Object.fromEntries(this.#counters),
      gauges: Object.fromEntries(this.#gauges),
      latencies: Object.fromEntries(
        [...this.#latencies.entries()].map(([k, v]) => [k, { count: v.count, min: v.min, max: v.max, sum: v.sum, recent: [...v.samples] }]),
      ),
      connection: {
        connectAttempts: this.counter('connection:attempts'),
        connectSuccesses: this.counter('connection:success'),
        reconnects: this.counter('connection:reconnects'),
        disconnects: this.counter('connection:disconnects'),
        streamErrors: this.counter('connection:streamErrors'),
        messagesReceived: this.counter('messages:received'),
        messagesSent: this.counter('messages:sent'),
        bytesReceived: this.counter('bytes:received'),
        bytesSent: this.counter('bytes:sent'),
        averageLatencyMs: avgLatency,
        lastLatencyMs: lastSample,
      },
    };
  }

  reset(): void {
    this.#counters.clear();
    this.#gauges.clear();
    this.#latencies.clear();
  }
}
