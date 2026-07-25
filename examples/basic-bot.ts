import { BaileysClient } from '@sasadev/baileys';

async function main() {
  const client = new BaileysClient({
    wsUrl: 'wss://web.whatsapp.com/ws/md', // correct endpoint for MD
    autoReconnect: true,
  });

  client.on('connection.update', (update) => {
    console.log('Connection:', update.status);
    if (update.qr) {
      console.log('Scan QR:', update.qr);
    }
  });

  client.on('message.new', async (msg) => {
    console.log('New message from', msg.from, ':', (msg as any).body);
    if (msg.messageType === 'text') {
      const text = (msg as any).body;
      if (text === 'ping') {
        await client.sendMessage(msg.from, 'pong');
      }
    }
  });

  await client.connect();
}

main().catch(console.error);
