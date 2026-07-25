import { BaileysClient } from '../client';
import { Middleware, NextFunction } from '../types/plugin';
import { WAMessage } from '../types/messages';

export class PluginManager {
  private client: BaileysClient;
  private middlewares: Middleware[] = [];

  constructor(client: BaileysClient) {
    this.client = client;
  }

  use(fn: Middleware) {
    this.middlewares.push(fn);
  }

  async runMiddleware(msg: WAMessage, done: NextFunction) {
    const ctx = { client: this.client, message: msg };
    const stack = [...this.middlewares];

    const next: NextFunction = async (err?: Error) => {
      if (err) return done(err);
      const fn = stack.shift();
      if (fn) {
        try {
          await fn(ctx, next);
        } catch (e) {
          done(e as Error);
        }
      } else {
        done();
      }
    };
    await next();
  }
}
