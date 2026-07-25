import { WAMessage, TextMessage } from './messages';  // 👈 Import TextMessage
import { BaileysClient } from '../client';

export type NextFunction = (err?: Error) => void;

export interface MiddlewareContext {
  client: BaileysClient;
  message: WAMessage;
}

export type Middleware = (ctx: MiddlewareContext, next: NextFunction) => Promise<void> | void;

export interface CommandContext {
  client: BaileysClient;
  message: TextMessage;          // 👈 දැන් නිවැරදි
  args: string[];
  commandName: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void> | void;
