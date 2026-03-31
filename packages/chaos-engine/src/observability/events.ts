// packages/chaos-engine/src/observability/events.ts
// Publishes structured ChaosEvent objects to NATS.
// Consumers: Prometheus metrics collector, Loki log shipper, audit service.
// Every meaningful state change in the chaos engine produces an event.

import { connect, StringCodec, type NatsConnection } from "nats";
import type { ChaosEvent } from "@chaos/shared-types";
import { logger } from "../logger";

const sc = StringCodec();

class ChaosEventEmitter {
  private nc: NatsConnection | null = null;

  async connect(): Promise<void> {
    try {
      this.nc = await connect({
        servers: process.env.NATS_URL ?? "nats://localhost:4222",
        reconnect: true,
        maxReconnectAttempts: -1,
      });
      logger.info("ChaosEventEmitter connected to NATS");
    } catch (err) {
      logger.warn({ err }, "ChaosEventEmitter: NATS unavailable, events will be dropped");
    }
  }

  async emit(event: ChaosEvent): Promise<void> {
    // Always log locally regardless of NATS state
    logger.info(
      {
        experimentId: event.experimentId,
        type: event.type,
        phase: event.phase,
        target: event.target?.name,
      },
      `chaos.event: ${event.phase}`
    );

    if (!this.nc) return;

    try {
      // Subject format: chaos.events.<type>.<phase>
      // Allows consumers to subscribe to subsets e.g. chaos.events.pod-kill.*
      const subject = `chaos.events.${event.type}.${event.phase}`;
      this.nc.publish(subject, sc.encode(JSON.stringify(event)));

      // Also publish to the catch-all topic for audit logging
      this.nc.publish("chaos.events.all", sc.encode(JSON.stringify(event)));
    } catch (err) {
      logger.warn({ err }, "Failed to emit chaos event to NATS");
    }
  }
}

export const chaosEventEmitter = new ChaosEventEmitter();
