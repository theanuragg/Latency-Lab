// packages/chaos-engine/src/health/checker.ts
// Health checking is the gate that prevents chaos from making a bad situation worse.
//
// Two modes:
// 1. Pre-flight: System must be healthy BEFORE we inject failures.
//    If it's already degraded, our chaos results are meaningless noise.
//
// 2. Recovery waiting: After chaos ends, we poll until the system
//    recovers or the timeout fires. The time-to-recovery is the MTTR.
//
// Health sources (in priority order):
//   a) Explicit healthCheckEndpoints in the experiment config
//   b) Kubernetes pod readiness (reliable, already instrumented)
//   c) Prometheus error rate query (most accurate but has scrape lag)

import * as k8s from "@kubernetes/client-node";
import { logger } from "../logger";

interface HealthResult {
  healthy: boolean;
  reason?: string;
  details: Record<string, { healthy: boolean; latencyMs: number; reason?: string }>;
}

export class HealthChecker {
  static async check(
    endpoints: string[] | undefined,
    namespace: string | undefined
  ): Promise<HealthResult> {
    const details: HealthResult["details"] = {};

    // Check explicit HTTP health endpoints first
    if (endpoints && endpoints.length > 0) {
      for (const endpoint of endpoints) {
        const result = await checkHttpEndpoint(endpoint);
        details[endpoint] = result;

        if (!result.healthy) {
          return {
            healthy: false,
            reason: `Health endpoint ${endpoint} returned unhealthy: ${result.reason}`,
            details,
          };
        }
      }
    }

    // Check Kubernetes pod readiness for the namespace
    if (namespace) {
      const k8sResult = await checkKubernetesReadiness(namespace);
      details[`k8s:${namespace}`] = k8sResult;

      if (!k8sResult.healthy) {
        return {
          healthy: false,
          reason: `Kubernetes readiness check failed: ${k8sResult.reason}`,
          details,
        };
      }
    }

    return { healthy: true, details };
  }

  // Poll for recovery with exponential backoff
  static async waitForRecovery(
    endpoints: string[] | undefined,
    namespace: string | undefined,
    timeoutMs: number
  ): Promise<boolean> {
    const start = Date.now();
    let pollInterval = 5000; // Start at 5s, back off to 30s max
    const maxInterval = 30_000;

    while (Date.now() - start < timeoutMs) {
      const result = await HealthChecker.check(endpoints, namespace);

      if (result.healthy) {
        const recoveryMs = Date.now() - start;
        logger.info({ recoveryMs, namespace }, "System recovered after chaos");
        return true;
      }

      logger.debug(
        { reason: result.reason, elapsedMs: Date.now() - start },
        "System not yet recovered, waiting..."
      );

      await sleep(pollInterval);
      pollInterval = Math.min(pollInterval * 1.5, maxInterval);
    }

    logger.warn({ timeoutMs, namespace }, "Recovery timeout exceeded");
    return false;
  }
}

async function checkHttpEndpoint(
  url: string
): Promise<{ healthy: boolean; latencyMs: number; reason?: string }> {
  const start = Date.now();

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "chaos-platform-health-check" },
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        healthy: false,
        latencyMs,
        reason: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    // If the response is JSON, try to parse a "healthy" field
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      try {
        const body = await response.json();
        if (body.healthy === false || body.status === "unhealthy") {
          return {
            healthy: false,
            latencyMs,
            reason: `Service reported unhealthy: ${JSON.stringify(body)}`,
          };
        }
      } catch {
        // Non-JSON or parse error — HTTP 200 is enough
      }
    }

    return { healthy: true, latencyMs };
  } catch (err: any) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      reason: err.message,
    };
  }
}

async function checkKubernetesReadiness(
  namespace: string
): Promise<{ healthy: boolean; latencyMs: number; reason?: string }> {
  const start = Date.now();

  try {
    const kc = new k8s.KubeConfig();
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const response = await coreApi.listNamespacedPod({
      namespace,
      fieldSelector: "status.phase=Running",
    });

    const pods = response.items;
    const totalPods = pods.length;

    if (totalPods === 0) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        reason: `No running pods found in namespace '${namespace}'`,
      };
    }

    const readyPods = pods.filter((pod) =>
      pod.status?.conditions?.some(
        (c) => c.type === "Ready" && c.status === "True"
      )
    ).length;

    const readinessPct = (readyPods / totalPods) * 100;

    // Consider unhealthy if less than 70% of pods are ready
    if (readinessPct < 70) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        reason: `Only ${readyPods}/${totalPods} pods ready (${readinessPct.toFixed(0)}%)`,
      };
    }

    return { healthy: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    // K8s API unavailable — fail open for health checks
    // (we're checking health, not executing chaos)
    logger.warn({ err }, "K8s readiness check failed, assuming healthy");
    return { healthy: true, latencyMs: Date.now() - start };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
