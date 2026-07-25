import { BaileysClient } from '../client';

export class Decoder {
  constructor(private client: BaileysClient) {}
  decode(raw: any): any {
    // Placeholder – real implementation would deserialize protobuf
    try {
      return JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      return {};
    }
  }
}
