import { BaileysClient } from '../client';
import { CommandHandler, CommandContext } from '../types/plugin';
import { TextMessage } from '../types/messages';

export class CommandFramework {
  private client: BaileysClient;
  private commands: Map<string, CommandHandler> = new Map();
  private prefix: string;

  constructor(client: BaileysClient, prefix = '/') {
    this.client = client;
    this.prefix = prefix;

    // Register middleware to intercept text messages
    client.plugins.use(async (ctx, next) => {
      if (ctx.message.messageType === 'text') {
        const textMsg = ctx.message as TextMessage;
        if (textMsg.body.startsWith(this.prefix)) {
          const [commandName, ...args] = textMsg.body.slice(this.prefix.length).trim().split(/\s+/);
          const handler = this.commands.get(commandName.toLowerCase());
          if (handler) {
            const cmdCtx: CommandContext = {
              client: this.client,
              message: textMsg,
              args,
              commandName: commandName.toLowerCase(),
            };
            await handler(cmdCtx);
            return; // prevent further processing
          }
        }
      }
      await next();
    });
  }

  register(command: string, handler: CommandHandler) {
    this.commands.set(command.toLowerCase(), handler);
  }
}
