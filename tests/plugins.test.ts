import { describe, expect, it, vi } from 'vitest';
import { MiddlewareEngine, type MiddlewareFn } from '../src/Plugins/middleware';
import { HookSystem } from '../src/Plugins/hooks';
import { WebSocketMiddleware } from '../src/Plugins/websocket-middleware';
import { MessageInterceptor } from '../src/Messaging/interceptors';
import type { BinaryNode } from '../src/WABinary/types';
import type { WAMessage } from '../src/Types/messages';

describe('middleware engine', () => {
  it('runs in onion order', async () => {
    const calls: string[] = [];
    const engine = new MiddlewareEngine<{ n: number }>();
    engine.use(async (ctx, next) => {
      calls.push('a>in');
      await next();
      calls.push('a>out');
    });
    engine.use(async (ctx, next) => {
      calls.push('b>in');
      await next();
      calls.push('b>out');
    });
    await engine.run({ n: 1 });
    expect(calls).toEqual(['a>in', 'b>in', 'b>out', 'a>out']);
  });

  it('calling next twice in one layer is guarded', async () => {
    const engine = new MiddlewareEngine();
    const downStream = vi.fn();
    engine.use(async (_ctx, next) => {
      await next();
      await next(); // no-op
    });
    engine.use(downStream);
    await engine.run({});
    expect(downStream).toHaveBeenCalledTimes(1);
  });

  it('short circuit: layer without next() ends the chain', async () => {
    const engine = new MiddlewareEngine<{ hit: boolean }>();
    const later = vi.fn();
    engine.use(async (ctx) => {
      ctx.state.hit = true; // no next()
    });
    engine.use(later as MiddlewareFn);
    await engine.run({ hit: false });
    expect(later).not.toHaveBeenCalled();
  });

  it('errors isolate per layer when onError provided', async () => {
    const onError = vi.fn();
    const engine = new MiddlewareEngine({ onError });
    engine.use(() => {
      throw new Error('boom');
    });
    engine.use((_ctx, _next) => {
      /* unreachable */
    });
    await engine.run({});
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('hook system', () => {
  it('runs taps and isolates errors', async () => {
    const hs = new HookSystem();
    const errors: unknown[] = [];
    hs.onError = (_hook, err) => errors.push(err);
    const hook = hs.define<{ n: number }>('test');
    hook.tap('p1', (ctx) => {
      ctx.n += 1;
    });
    hook.tap('p2', () => {
      throw new Error('tap fail');
    });
    const ctx = { n: 0 };
    await hook.run(ctx);
    expect(ctx.n).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('untapPlugin removes all taps of a plugin', async () => {
    const hs = new HookSystem();
    const hook = hs.define<{ n: number }>('x');
    hook.tap('plugin-a', (ctx) => {
      ctx.n += 1;
    });
    hook.tap('plugin-a', (ctx) => {
      ctx.n += 10;
    });
    hook.tap('plugin-b', (ctx) => {
      ctx.n += 100;
    });
    expect(hs.unregisterPlugin('plugin-a')).toBe(2);
    const ctx = { n: 0 };
    await hook.run(ctx);
    expect(ctx.n).toBe(100);
  });
});

describe('websocket middleware', () => {
  it('transforms outgoing nodes and supports veto', async () => {
    const mw = new WebSocketMiddleware();
    mw.useOutgoing((node) => ({ ...node, attrs: { ...node.attrs, seen: '1' } }));
    const out = await mw.applyOutgoing({ tag: 'x', attrs: {} });
    expect(out?.attrs.seen).toBe('1');
    mw.useOutgoing(() => null);
    expect(await mw.applyOutgoing({ tag: 'x', attrs: {} })).toBeNull();
  });

  it('incoming chain applies in order', async () => {
    const mw = new WebSocketMiddleware();
    const node: BinaryNode = { tag: 'message', attrs: {} };
    mw.useIncoming((n) => ({ ...n, attrs: { ...n.attrs, a: '1' } }));
    mw.useIncoming((n) => ({ ...n, attrs: { ...n.attrs, b: '2' } }));
    const result = await mw.applyIncoming(node);
    expect(result?.attrs).toEqual({ a: '1', b: '2' });
  });
});

describe('message interceptor', () => {
  const msg = (body: string): WAMessage => ({
    key: { remoteJid: 'x@s.whatsapp.net', id: body },
    message: { conversation: body },
  });

  it('transforms incoming ctx and can drop', async () => {
    const mi = new MessageInterceptor();
    mi.addIncoming((ctx) => ({ ...ctx, messages: ctx.messages.map((m) => ({ ...m, flagged: true })) }));
    const result = await mi.applyIncoming({ messages: [msg('hi')], upsertType: 'notify' });
    expect(result?.messages[0]).toMatchObject({ flagged: true });
    mi.addIncoming(() => null);
    expect(await mi.applyIncoming({ messages: [msg('hi')], upsertType: 'notify' })).toBeNull();
  });

  it('outgoing priority: higher runs earlier', async () => {
    const mi = new MessageInterceptor();
    const order: string[] = [];
    mi.addOutgoing((m) => {
      order.push('low');
      return m;
    }, 1);
    mi.addOutgoing((m) => {
      order.push('high');
      return m;
    }, 10);
    await mi.applyOutgoing(msg('x'));
    expect(order).toEqual(['high', 'low']);
  });

  it('interceptor errors are reported, pipeline continues', async () => {
    const mi = new MessageInterceptor();
    const errors: unknown[] = [];
    mi.onError = (e) => errors.push(e);
    mi.addOutgoing(() => {
      throw new Error('bad interceptor');
    });
    mi.addOutgoing((m) => m);
    const result = await mi.applyOutgoing(msg('ok'));
    expect(result).toBeTruthy();
    expect(errors).toHaveLength(1);
  });
});
