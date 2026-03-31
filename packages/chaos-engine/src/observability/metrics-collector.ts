// packages/chaos-engine/src/observability/metrics-collector.ts
// The metrics collector is what makes chaos experiments USEFUL.
// Without before/after comparison, you have no evidence of resilience.
//
// We query Prometheus to capture system state at three points:
//   1. Before chaos: establish baseline
//   2. During chaos: monitor thresholds
//   3. After chaos: compute MTTR and chaos score
//
// Chaos Score: A 0-100 score that measures how well the system handled the chaos.
//   100 = perfect: no errors, no latency spike, instant recovery
//   0 = terrible: total outage, no recovery
//
// This score accumulates over time to give a "resilience trend" —
// is the system getting more or less resilient over time?

interface MetricsSnapshot {
  timestamp: Date;
  errorRate: number; // 0-1
  p50LatencyMs: number;
  p99LatencyMs: number;
  requestRate: number;
  podRestarts: number;
  healthyPods: number;
  totalPods: number;
}

interface PrometheusResult {
  status: "success" | "error";
  data: {
    resultType: "vector" | "matrix";
    result: Array<{
      metric: Record<string, string>;
      value: [number, string]; // [timestamp, value]
    }>;
  };
}

export class MetricsCollector {
  static async captureSnapshot(
    namespace: string | undefined,
    experimentId: string
  ): Promise<MetricsSnapshot> {
    const prometheusUrl = process.env.PROMETHEUS_URL ?? "http://prometheus:9090";
    const ns = namespace ?? "default";

    // All queries run in parallel to reduce capture time
    const [errorRate, p50, p99, requestRate, podRestarts, podReady, podTotal] =
      await Promise.allSettled([
        queryPrometheus(
          prometheusUrl,
          // HTTP error rate per namespace
          `sum(rate(http_requests_total{namespace="${ns}",status=~"5.."}[2m])) / sum(rate(http_requests_total{namespace="${ns}"}[2m]))`
        ),
        queryPrometheus(
          prometheusUrl,
          `histogram_quantile(0.5, sum(rate(http_request_duration_seconds_bucket{namespace="${ns}"}[2m])) by (le)) * 1000`
        ),
        queryPrometheus(
          prometheusUrl,
          `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{namespace="${ns}"}[2m])) by (le)) * 1000`
        ),
        queryPrometheus(
          prometheusUrl,
          `sum(rate(http_requests_total{namespace="${ns}"}[2m]))`
        ),
        queryPrometheus(
          prometheusUrl,
          `sum(kube_pod_container_status_restarts_total{namespace="${ns}"})`
        ),
        queryPrometheus(
          prometheusUrl,
          `sum(kube_pod_status_ready{namespace="${ns}",condition="true"})`
        ),
        queryPrometheus(
          prometheusUrl,
          `sum(kube_pod_status_ready{namespace="${ns}"})`
        ),
      ]);

    return {
      timestamp: new Date(),
      errorRate: resolveMetric(errorRate, 0),
      p50LatencyMs: resolveMetric(p50, 0),
      p99LatencyMs: resolveMetric(p99, 0),
      requestRate: resolveMetric(requestRate, 0),
      podRestarts: resolveMetric(podRestarts, 0),
      healthyPods: resolveMetric(podReady, 0),
      totalPods: resolveMetric(podTotal, 0),
    };
  }

  static computeMetrics(
    before: MetricsSnapshot,
    after: MetricsSnapshot,
    experimentId: string
  ) {
    const mttrSeconds = computeMTTR(before, after);
    const chaosScore = computeChaosScore(before, after);

    return {
      errorRateBefore: before.errorRate,
      errorRateAfter: after.errorRate,
      p50LatencyMsBefore: before.p50LatencyMs,
      p99LatencyMsBefore: before.p99LatencyMs,
      p50LatencyMsDuring: after.p50LatencyMs, // simplified: using 'after' as proxy for 'during'
      p99LatencyMsDuring: after.p99LatencyMs,
      mttrSeconds,
      chaosScore,
      sloViolations: detectSLOViolations(before, after),
    };
  }
}

// ─── Chaos Score algorithm ─────────────────────────────────────────────────────
//
// The score is a weighted average of several resilience indicators.
// Weights reflect production priority (error rate is most important).
//
// Component scores:
//   Error rate score (40%): How much did errors spike?
//   Latency score (30%): How much did p99 latency spike?
//   Recovery score (20%): How fast did the system recover?
//   Pod availability score (10%): How many pods stayed healthy?

function computeChaosScore(before: MetricsSnapshot, after: MetricsSnapshot): number {
  // Error rate score (0-100): higher = less error rate increase
  const errorIncrease = Math.max(0, after.errorRate - before.errorRate);
  const errorScore = Math.max(0, 100 - errorIncrease * 1000); // 10% error increase = score 0

  // Latency score (0-100): higher = less p99 latency spike
  const latencyRatio =
    before.p99LatencyMs > 0
      ? after.p99LatencyMs / before.p99LatencyMs
      : 1;
  const latencyScore = Math.max(0, 100 - (latencyRatio - 1) * 50); // 2x latency = score 50

  // Recovery score (0-100): higher = faster recovery
  const mttr = computeMTTR(before, after);
  const recoveryScore = Math.max(0, 100 - (mttr / 30)); // 50 min recovery = score 0

  // Pod availability score (0-100)
  const podAvailabilityBefore =
    before.totalPods > 0 ? before.healthyPods / before.totalPods : 1;
  const podAvailabilityAfter =
    after.totalPods > 0 ? after.healthyPods / after.totalPods : 1;
  const podScore = Math.max(0, 100 * podAvailabilityAfter);

  // Weighted average
  const score =
    errorScore * 0.4 +
    latencyScore * 0.3 +
    recoveryScore * 0.2 +
    podScore * 0.1;

  return Math.round(Math.max(0, Math.min(100, score)));
}

function computeMTTR(before: MetricsSnapshot, after: MetricsSnapshot): number {
  // MTTR in seconds — time from chaos end to recovery
  // Heuristic: system has recovered when error rate is back to within 10% of baseline
  const threshold = before.errorRate * 1.1 + 0.01;

  if (after.errorRate <= threshold) {
    // Already recovered — MTTR is the time between snapshots
    return (after.timestamp.getTime() - before.timestamp.getTime()) / 1000;
  }

  // System not recovered yet — return time so far as lower bound
  return (after.timestamp.getTime() - before.timestamp.getTime()) / 1000;
}

function detectSLOViolations(before: MetricsSnapshot, after: MetricsSnapshot) {
  const violations = [];

  // Example SLOs — in production, these come from config
  const slos = [
    { name: "error-rate-<1%", threshold: 0.01, actual: after.errorRate, unit: "rate" },
    { name: "p99-latency-<500ms", threshold: 500, actual: after.p99LatencyMs, unit: "ms" },
    { name: "pod-availability->99%", threshold: 0.99, actual: after.healthyPods / (after.totalPods || 1), unit: "ratio" },
  ];

  for (const slo of slos) {
    if (slo.unit === "rate" && slo.actual > slo.threshold) {
      violations.push({
        sloName: slo.name,
        threshold: slo.threshold,
        actual: slo.actual,
        durationSeconds: 0, // would need time-series data for accurate duration
      });
    } else if (slo.unit === "ms" && slo.actual > slo.threshold) {
      violations.push({ sloName: slo.name, threshold: slo.threshold, actual: slo.actual, durationSeconds: 0 });
    } else if (slo.unit === "ratio" && slo.actual < slo.threshold) {
      violations.push({ sloName: slo.name, threshold: slo.threshold, actual: slo.actual, durationSeconds: 0 });
    }
  }

  return violations;
}

// ─── Prometheus client ─────────────────────────────────────────────────────────

async function queryPrometheus(baseUrl: string, query: string): Promise<number | null> {
  const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;

  const data: PrometheusResult = await response.json();
  if (data.status !== "success" || data.data.result.length === 0) return null;

  return parseFloat(data.data.result[0].value[1]);
}

function resolveMetric(
  result: PromiseSettledResult<number | null>,
  defaultValue: number
): number {
  if (result.status === "rejected" || result.value === null) return defaultValue;
  return isNaN(result.value) ? defaultValue : result.value;
}
