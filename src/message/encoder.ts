import { BaileysClient } from '../client';

export class Encoder {
  constructor(private client: BaileysClient) {}
  encode(message: any): Uint8Array {
    // Placeholder – real implementation would serialize to protobuf
    return Buffer.from(JSON.stringify(message));
  }
}
