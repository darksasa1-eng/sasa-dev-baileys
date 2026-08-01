import { TypedEventEmitter } from '../Defaults/events';
import { computeBackoff } from '../Utils/generics';

export type HealthStatus = 'starting' | 'healthy' | 'degraded' | 'down';

export interface HealthReport {
  status: HealthStatus;
  /** ms since the WS transport opened */
  uptimeMs: number;
  /** ms since ANY inbound frame */
  lastInboundAgoMs: number | null;
  /** Consecutive heartbeat failures */
  consecutiveFailures: number;
  /** Round-trip latency of the last successful heartbeat */
  lastLatencyMs: number | null;
  /** Number of reconnects since client start */
  reconnectCount: number;
  timestamp: number;
}

export interface HealthMonitorEvents {
  /** emitted on every status transition */
  statusChange: { from: HealthStatus; to: HealthStatus; report: HealthReport };
  /** periodic report (every tick) */
  report: HealthReport;
}

export interface HealthMonitorOptions {
  /** How often to evaluate liveness */
  tickMs?: number;
  /** Inbound silence longer than this ⇒ degraded */
  degradeAfterMs?: number;
  /** Inbound silence longer than this ⇒ down */
  downAfterMs?: number;
}

/**
 * Connection Health Monitor — watches inbound traffic silence windows and
 * heartbeat latency, and emits status transitions (starting → healthy →
 * degraded → down). Purely observational: recovery policies subscribe and
 * act on the transitions.
 */
export class ConnectionHealthMonitor extends TypedEventEmitter<HealthMonitorEvents> {
  readonly #opts: Required<HealthMonitorOptions>;
  #timer: NodeJS.Timeout | undefined;
  #status: HealthStatus = 'starting';
  #openedAt: number | undefined;
  #lastInboundAt: number | undefined;
  #lastLatencyMs: number | undefined;
  #consecutiveFailures = 0;
  #reconnectCount = 0;

  constructor(options: HealthMonitorOptions = {}) {
    super();
    this.#opts = {
      tickMs: options.tickMs ?? 15_000,
      degradeAfterMs: options.degradeAfterMs ?? 120_000,
      downAfterMs: options.downAfterMs ?? 300_000,
    };
  }

  start(): void {
    if (this.#timer) return;
    this.#openedAt = Date.now();
    this.#timer = setInterval(() => this.#tick(), this.#opts.tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  noteConnected(): void {
    this.#openedAt = Date.now();
    this.#lastInboundAt = Date.now();
    this.#consecutiveFailures = 0;
    this.#setStatus('healthy');
  }

  noteDisconnected(): void {
    this.#openedAt = undefined;
    this.#setStatus('starting');
  }

  noteReconnect(): void {
    this.#reconnectCount += 1;
  }

  /** Every inbound frame resets the silence window */
  noteInbound(): void {
    this.#lastInboundAt = Date.now();
    if (this.#status === 'degraded') this.#setStatus('healthy');
  }

  noteHeartbeatResult(ok: boolean, latencyMs?: number): void {
    if (ok) {
      this.#consecutiveFailures = 0;
      this.#lastLatencyMs = latencyMs;
      this.#lastInboundAt = Date.now();
      if (this.#status !== 'healthy' && this.#openedAt !== undefined) this.#setStatus('healthy');
    } else {
      this.#consecutiveFailures += 1;
      if (this.#consecutiveFailures >= 2) this.#evaluate();
    }
  }

  #tick(): void {
    this.#evaluate();
    this.emit('report', this.report());
  }

  #evaluate(): void {
    if (this.#openedAt === undefined) {
      this.#setStatus('starting');
      return;
    }
    if (this.#consecutiveFailures >= 3) {
      this.#setStatus('down');
      return;
    }
    const silence = this.#lastInboundAt !== undefined ? Date.now() - this.#lastInboundAt : 0;
    if (silence > this.#opts.downAfterMs) this.#setStatus('down');
    else if (silence > this.#opts.degradeAfterMs) this.#setStatus('degraded');
    else this.#setStatus('healthy');
  }

  #setStatus(status: HealthStatus): void {
    if (status === this.#status) return;
    const from = this.#status;
    this.#status = status;
    this.emit('statusChange', { from, to: status, report: this.report() });
  }

  get status(): HealthStatus {
    return this.#status;
  }

  report(): HealthReport {
    const now = Date.now();
    return {
      status: this.#status,
      uptimeMs: this.#openedAt !== undefined ? now - this.#openedAt : 0,
      lastInboundAgoMs: this.#lastInboundAt !== undefined ? now - this.#lastInboundAt : null,
      consecutiveFailures: this.#consecutiveFailures,
      lastLatencyMs: this.#lastLatencyMs ?? null,
      reconnectCount: this.#reconnectCount,
      timestamp: now,
    };
  }

  override dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}

/** Suggested backoff for recovery based on consecutive failures */
export function suggestedRecoveryDelay(failures: number): number {
  return computeBackoff(Math.max(0, failures - 1), { baseMs: 2_000, maxMs: 120_000, jitter: 0.3 });
}
