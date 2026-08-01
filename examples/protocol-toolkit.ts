/**
 * Protocol toolkit — an offline tour of the library's building blocks.
 *
 * Everything in this example runs without network access: the WABinary
 * codec, the advanced message serializer, the Signal double-ratchet
 * session layer, storage adapters, and the hook/middleware/interceptor
 * pipeline. Run it to smoke-test an install:
 *
 *   npx tsx examples/protocol-toolkit.ts
 */

import {
  // WABinary codec
  encodeBinaryNode,
  decodeBinaryNode,
  binaryNodeToString,
  type BinaryNode,
  // messaging
  MessageBuilder,
  serializeMessage,
  deserializeMessage,
  serializeMessageKey,
  deserializeMessageKey,
  // signal layer
  Signal,
  // storage
  MemoryStorageAdapter,
  JsonStorageAdapter,
  useAuthState,
  // infra
  HookSystem,
  MiddlewareEngine,
  MessageInterceptor,
  AsyncEventQueue,
  ConnectionMetrics,
} from '../src/index';

const section = (title: string): void => console.log(`\n=== ${title} ===`);

async function main(): Promise<void> {
  // ---------------------------------------------------------------- WABinary
  section('WABinary codec');
  const stanza: BinaryNode = {
    tag: 'iq',
    attrs: { to: 's.whatsapp.net', type: 'get', id: 'demo-0001' },
    content: [{ tag: 'query', attrs: { xmlns: 'md' }, content: 'hello protocol' }],
  };
  const wire = encodeBinaryNode(stanza);
  const back = decodeBinaryNode(wire);
  console.log(`encoded ${wire.byteLength} bytes → decoded:`, binaryNodeToString(back));

  // ------------------------------------------------------------ messaging
  section('Advanced Message Serializer & Builder');
  const builder = new MessageBuilder('41789996011@s.whatsapp.net');
  const message = builder.text('Hello from @sasadevofc/baileys', { mentions: ['41789996011@s.whatsapp.net'] });
  if (!message.message) throw new Error('builder produced empty message');
  const protoBytes = serializeMessage(message.message);
  const roundTripped = deserializeMessage(protoBytes);
  console.log('message proto round trip:', JSON.stringify(roundTripped));
  const keyBytes = serializeMessageKey(message.key);
  console.log('message key round trip:', JSON.stringify(deserializeMessageKey(keyBytes)));

  // ------------------------------------------------------- signal sessions
  section('Signal layer: X3DH + double ratchet');
  const aliceIdentity = Signal.generateKeyPair();
  const bobIdentity = Signal.generateKeyPair();
  const bobSignedPreKey = Signal.generateSignedPreKey(bobIdentity, 1);
  const regA = Signal.generateRegistrationId();
  const regB = Signal.generateRegistrationId();

  // Alice (initiator) builds a session for Bob's published bundle
  const { session: alice, baseKey } = Signal.libsignal.initSession({
    ourIdentityKey: aliceIdentity,
    registrationId: regA,
    theirIdentityKey: bobIdentity.publicKey,
    theirSignedPreKey: { keyId: 1, ...bobSignedPreKey.keyPair },
    theirRegistrationId: regB,
  });
  const first = Signal.libsignal.encryptWhisperMessage(alice, new TextEncoder().encode('ping'), {
    preKey: { baseKey, signedPreKeyId: 1, registrationId: regA },
  });
  console.log(`first message type: ${first.type} (${first.serialized.byteLength} bytes)`);

  // Bob (responder) processes the pre-key message — sessions now match
  const preKeyBody = Signal.libsignal.decodePreKeySignalMessage(first.serialized.subarray(1));
  const bob = Signal.libsignal.processPreKeyBundle({
    ourIdentityKey: bobIdentity,
    ourSignedPreKey: bobSignedPreKey,
    registrationId: regB,
    theirIdentityKey: preKeyBody.identityKey,
    theirEphemeralKey: preKeyBody.baseKey,
    theirRegistrationId: preKeyBody.registrationId,
  });
  const plaintext = Signal.libsignal.decryptWhisperMessage(bob, preKeyBody.message);
  console.log('bob decrypted:', new TextDecoder().decode(plaintext));

  const reply = Signal.libsignal.encryptWhisperMessage(bob, new TextEncoder().encode('pong'));
  console.log(
    'alice decrypted:',
    new TextDecoder().decode(Signal.libsignal.decryptWhisperMessage(alice, reply.serialized)),
  );

  // ---------------------------------------------------------------- storage
  section('Storage adapters');
  const memory = new MemoryStorageAdapter();
  const { state, saveCreds } = await useAuthState(memory, { namespace: 'demo:' });
  state.creds.accountSyncCounter += 1;
  await saveCreds();
  const reloaded = await useAuthState(memory, { namespace: 'demo:' });
  console.log('creds survived adapter round trip; sync counter =', reloaded.state.creds.accountSyncCounter);

  const json = new JsonStorageAdapter('.example-auth.json');
  await json.set('note', { hello: 'world' });
  console.log('json adapter read-back:', JSON.stringify(await json.get('note')));
  await json.close(); // flushes + releases the file

  // ------------------------------------------------- plugin pipeline pieces
  section('Hooks / middleware / interceptors');
  const hooks = new HookSystem();
  hooks.get('demo').tap('audit', (ctx) => {
    console.log('  hook observed:', JSON.stringify(ctx));
  });
  await hooks.get('demo').run({ event: 'ping' });

  interface PipeState {
    value: number;
    log: string[];
  }
  const pipeline = new MiddlewareEngine<PipeState>();
  pipeline.use(async ({ state }, next) => {
    state.log.push('before');
    await next();
    state.log.push('after');
  }, 'tracer');
  pipeline.use(async ({ state }, next) => {
    state.value *= 10;
    await next();
  }, 'multiplier');
  const pipeState: PipeState = { value: 2, log: [] };
  await pipeline.run(pipeState);
  console.log('  middleware result:', JSON.stringify(pipeState));

  const interceptors = new MessageInterceptor();
  interceptors.addOutgoing((msg) => {
    if (msg.message?.conversation) msg.message.conversation = `${msg.message.conversation} [signed]`;
    return msg;
  });
  const stamped = await interceptors.applyOutgoing(builder.text('tamper-evident trail'));
  console.log('  interceptor output:', JSON.stringify(stamped?.message));

  // ------------------------------------------------------------- infra bits
  section('Async event queue & metrics');
  const queue = new AsyncEventQueue({ maxPending: 1_000 });
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => queue.enqueue(() => void order.push(n))));
  console.log('  queue executed in order:', order.join(' → '));

  const metrics = new ConnectionMetrics();
  metrics.increment('messages:sent');
  metrics.timing('example', 12);
  console.log('  metrics snapshot:', JSON.stringify(metrics.snapshot().counters));
}

main().catch((err) => {
  console.error('toolkit example failed:', err);
  process.exit(1);
});
