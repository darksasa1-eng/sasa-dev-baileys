import { describe, expect, it, vi } from 'vitest';
import { TokenBucketRateLimiter } from '../src/Socket/rate-limiter';
import { RequestQueue } from '../src/Socket/request-queue';
import { RetryManager } from '../src/Socket/retry-manager';
import { ConnectionRecoveryManager } from '../src/Socket/recovery-manager';
import { ConnectionHealthMonitor } from '../src/Socket/health-monitor';
import { TypedEventEmitter } from '../src/Defaults/events';
import { AsyncEventQueue } from '../src/Defaults/queue';
import { Mutex, KeyedMutex } from '../src/Defaults/mutex';
import { StreamError, BackpressureError, TimedOutError, RateLimitError } from '../src/Defaults/errors';
import { DisconnectReason } from '../src/Defaults/disconnect-reason';
import { delay } from '../src/Utils/generics';

describe('rate limiter', () => {
  it('allows burst up to capacity then throttles', async () => {
    const rl = new TokenBucketRateLimiter({ ratePerSecond: 100, burst: 2 });
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
    const t0 = Date.now();
    await rl.acquire();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5);
    rl.dispose();
  });

  it('rejects when wait exceeds budget', async () => {
    const rl = new TokenBucketRateLimiter({ ratePerSecond: 2, burst: 1 });
    rl.tryAcquire(); // consume the burst
    await expect(rl.acquire(1, 10)).rejects.toBeInstanceOf(RateLimitError);
    rl.dispose();
  });

  it('schedules multiple waiters without starving', async () => {
    const rl = new TokenBucketRateLimiter({ ratePerSecond: 40, burst: 1 });
    rl.tryAcquire();
    const results = await Promise.all([rl.acquire(1, 1000), rl.acquire(1, 1000), rl.acquire(1, 1000)]);
    expect(results).toHaveLength(3);
    rl.dispose();
  });
});

describe('request queue', () => {
  it('respects concurrency', async () => {
    const queue = new RequestQueue({ concurrency: 2, taskTimeoutMs: 1000 });
    let running = 0;
    let peak = 0;
    const task = () =>
      new Promise<void>((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        setTimeout(() => {
          running -= 1;
          resolve();
        }, 15);
      });
    await Promise.all([queue.enqueue(task), queue.enqueue(task), queue.enqueue(task), queue.enqueue(task)]);
    expect(peak).toBe(2);
    expect(queue.stats.executed).toBe(4);
    queue.dispose();
  });

  it('rejects with backpressure beyond maxPending', async () => {
    const queue = new RequestQueue({ concurrency: 1, maxPending: 1, taskTimeoutMs: 500 });
    const slow = () => new Promise((r) => setTimeout(r, 60));
    const p1 = queue.enqueue(slow);
    const p2 = queue.enqueue(slow);
    await expect(queue.enqueue(slow)).rejects.toBeInstanceOf(BackpressureError);
    await Promise.all([p1, p2]);
    queue.dispose();
  });

  it('times out a stuck task with TimedOutError', async () => {
    const queue = new RequestQueue({ concurrency: 1, taskTimeoutMs: 20 });
    await expect(queue.enqueue(() => new Promise(() => {}))).rejects.toBeInstanceOf(TimedOutError);
    queue.dispose();
  });

  it('runs higher priority first', async () => {
    const queue = new RequestQueue({ concurrency: 1, taskTimeoutMs: 500 });
    const order: number[] = [];
    const mk = (n: number) => () =>
      new Promise<void>((resolve) => {
        order.push(n);
        resolve();
      });
    const blocker = queue.enqueue(() => delay(30));
    await delay(2);
    void queue.enqueue(mk(1), { priority: 0 });
    void queue.enqueue(mk(3), { priority: 10 });
    void queue.enqueue(mk(2), { priority: 5 });
    await blocker;
    await delay(30);
    expect(order.slice(0, 3)).toEqual([3, 2, 1]);
    queue.dispose();
  });
});

describe('retry manager', () => {
  it('succeeds after configured retries', async () => {
    const rm = new RetryManager({ maxAttempts: 3, baseMs: 1, jitter: 0 });
    let attempts = 0;
    const result = await rm.execute(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('nope');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(rm.history.length).toBe(2);
  });

  it('stops immediately on fatal disconnect code', async () => {
    const rm = new RetryManager({ maxAttempts: 5, baseMs: 1, jitter: 0 });
    let attempts = 0;
    await expect(
      rm.execute(async () => {
        attempts += 1;
        throw new StreamError(DisconnectReason.loggedOut);
      }),
    ).rejects.toBeInstanceOf(StreamError);
    expect(attempts).toBe(1);
  });
});

describe('recovery manager', () => {
  it('schedules then triggers, collapsing duplicates', () => {
    const rm = new ConnectionRecoveryManager({ maxAttempts: 3, baseMs: 5, jitter: 0 });
    const events: string[] = [];
    rm.on('scheduled', () => events.push('scheduled'));
    rm.on('trigger', () => events.push('trigger'));
    rm.handleDisconnect(new Error('x'));
    rm.handleDisconnect(new Error('x')); // duplicate collapses
    expect(events.filter((e) => e === 'scheduled')).toHaveLength(1);
    return new Promise<void>((resolve) => {
      rm.on('trigger', () => {
        rm.dispose();
        resolve();
      });
    });
  });

  it('emits exhausted on fatal code', () => {
    const rm = new ConnectionRecoveryManager({ maxAttempts: 2 });
    const spy = vi.fn();
    rm.on('exhausted', spy);
    expect(rm.handleDisconnect(new StreamError(DisconnectReason.loggedOut))).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    rm.dispose();
  });

  it('resets attempt budget after successful connect', () => {
    const rm = new ConnectionRecoveryManager({ maxAttempts: 2, baseMs: 5 });
    rm.handleDisconnect(new Error('1'));
    rm.reset();
    expect(rm.currentAttempt).toBe(0);
    expect(rm.isScheduled).toBe(false);
    rm.dispose();
  });
});

describe('health monitor', () => {
  it('transitions on connect/disconnect and records latency', () => {
    const hm = new ConnectionHealthMonitor({ tickMs: 10_000, degradeAfterMs: 1, downAfterMs: 2 });
    const transitions: string[] = [];
    hm.on('statusChange', ({ to }) => transitions.push(to));
    hm.noteConnected();
    expect(hm.status).toBe('healthy');
    hm.noteHeartbeatResult(true, 42);
    expect(hm.report().lastLatencyMs).toBe(42);
    hm.noteDisconnected();
    expect(hm.status).toBe('starting');
    expect(transitions).toEqual(['healthy', 'starting']);
    hm.dispose();
  });
});

describe('typed event emitter', () => {
  it('guards duplicate listeners', () => {
    type E = { ping: number };
    const em = new TypedEventEmitter<E>();
    let count = 0;
    const handler = () => count++;
    em.on('ping', handler);
    em.on('ping', handler); // duplicate ignored
    em.emit('ping', 1);
    expect(count).toBe(1);
  });

  it('waitFor resolves with filter + timeout', async () => {
    type E = { val: number };
    const em = new TypedEventEmitter<E>();
    setTimeout(() => em.emit('val', 5), 5);
    await expect(em.waitFor('val', { filter: (v) => v === 5, timeoutMs: 100 })).resolves.toBe(5);
    await expect(em.waitFor('val', { timeoutMs: 10 })).rejects.toThrow(/timed out/);
  });
});

describe('async event queue + mutex', () => {
  it('serializes jobs in FIFO order', async () => {
    const q = new AsyncEventQueue();
    const order: number[] = [];
    await Promise.all([
      q.enqueue(async () => {
        await delay(15);
        order.push(1);
      }),
      q.enqueue(async () => order.push(2)),
      q.enqueue(async () => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
    expect(q.pending).toBe(0);
  });

  it('a failing job does not kill the queue', async () => {
    const q = new AsyncEventQueue();
    await expect(q.enqueue(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(q.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects on backpressure cap', async () => {
    const q = new AsyncEventQueue({ maxPending: 2 });
    const slow = q.enqueue(() => delay(30));
    const slow2 = q.enqueue(() => delay(30));
    await expect(q.enqueue(() => delay(1))).rejects.toBeInstanceOf(BackpressureError);
    await slow;
    await slow2;
  });

  it('mutex is exclusive; keyed mutex isolates keys', async () => {
    const m = new Mutex();
    let active = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        m.exclusive(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(10);
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);

    const km = new KeyedMutex();
    const [a, b] = await Promise.all([
      km.exclusive('a', async () => {
        await delay(20);
        return 'a-done';
      }),
      km.exclusive('b', async () => 'b-done'),
    ]);
    expect([a, b]).toEqual(['a-done', 'b-done']);
    expect(km.trackedKeys).toBeLessThanOrEqual(2);
  });
});
