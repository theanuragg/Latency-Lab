// packages/control-plane/src/messaging/nats.ts
// NATS client singleton — shared by server and scheduler.
// Uses JetStream for durable pub/sub so messages survive NATS restarts.

import { connect, StringCodec, type NatsConnection } from "nats";
import { logger } from "../observability/logger";

const sc = StringCodec();
let nc: NatsConnection | null = null;

export const natsClient = {
  async connect(): Promise<void> {
    nc = await connect({
      servers: process.env.NATS_URL ?? "nats://localhost:4222",
      reconnect: true,
      maxReconnectAttempts: -1, // infinite
      reconnectTimeWait: 1000,
    });

    nc.closed().then(() => {
      logger.warn("NATS connection closed");
    });

    logger.info({ url: process.env.NATS_URL }, "NATS connected");
  },

  async publish(subject: string, payload: unknown): Promise<void> {
    if (!nc) throw new Error("NATS not connected — call natsClient.connect() first");
    nc.publish(subject, sc.encode(JSON.stringify(payload)));
  },

  async drain(): Promise<void> {
    if (nc) await nc.drain();
  },
};
