import { BaileysClient, CommandFramework } from '@sasadev/baileys';

const client = new BaileysClient();
const cmd = new CommandFramework(client, '!');

cmd.register('ping', async (ctx) => {
  await ctx.client.sendMessage(ctx.message.from, '🏓 Pong!');
});

cmd.register('echo', async (ctx) => {
  const echoText = ctx.args.join(' ') || 'Nothing to echo.';
  await ctx.client.sendMessage(ctx.message.from, echoText);
});

client.on('connection.update', (upd) => {
  if (upd.qr) console.log('Scan QR:', upd.qr);
});

client.connect();
