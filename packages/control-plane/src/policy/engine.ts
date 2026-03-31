// packages/control-plane/src/policy/engine.ts
// The policy engine is the gatekeeper between "user wants chaos" and "chaos runs".
// It encodes all the safety rules as composable, testable validators.
//
// Design principle: Policy violations are structured, not strings.
// Callers can distinguish "blocked" (hard stop) from "warned" (proceed with caution).
// This lets the CLI surface actionable error messages, not "permission denied".

import type {
  ExperimentConfig,
  PolicyViolation,
  DryRunReport,
  SelectedTarget,
  TargetSelector,
} from "@chaos/shared-types";
import { config } from "../server";
import { kubernetesClient } from "../engine/kubernetes";
import { logger } from "../observability/logger";

export interface PolicyResult {
  allowed: boolean;
  violations: PolicyViolation[];
  warnings: string[];
}

// Every policy rule is a function from ExperimentConfig to violations.
// Adding a new rule = adding one function + one line in VALIDATORS.
type PolicyValidator = (
  exp: ExperimentConfig,
  context: PolicyContext
) => Promise<PolicyViolation[]>;

interface PolicyContext {
  requestingUser: string;
  userRoles: string[];
}

// ─── Individual policy validators ─────────────────────────────────────────────

const blockedNamespacesValidator: PolicyValidator = async (exp) => {
  const violations: PolicyViolation[] = [];
  const ns = exp.target.namespace;

  if (!ns) return violations; // No namespace = cluster-wide, validated separately

  const allBlocked = [
    ...config.blockedNamespaces,
    ...(exp.safety.blockedNamespaces ?? []),
  ];

  if (allBlocked.includes(ns)) {
    violations.push({
      rule: "BLOCKED_NAMESPACE",
      reason: `Namespace '${ns}' is in the blocked list. System namespaces must never be targeted.`,
      severity: "block",
    });
  }

  return violations;
};

const blastRadiusValidator: PolicyValidator = async (exp) => {
  const violations: PolicyViolation[] = [];

  if (exp.blastRadius.unit === "percentage") {
    if (exp.blastRadius.value > config.maxBlastRadiusPct) {
      violations.push({
        rule: "BLAST_RADIUS_EXCEEDED",
        reason: `Requested blast radius ${exp.blastRadius.value}% exceeds global maximum of ${config.maxBlastRadiusPct}%. This protects against accidental full-cluster chaos.`,
        severity: "block",
      });
    }
  }

  return violations;
};

const podDisruptionBudgetValidator: PolicyValidator = async (exp) => {
  // For pod-kill experiments, we must check PodDisruptionBudgets.
  // Killing pods that would violate a PDB is dangerous and disrespects
  // the application's own declared minimum availability.
  if (exp.type !== "pod-kill") return [];

  const violations: PolicyViolation[] = [];

  try {
    const pdbs = await kubernetesClient.listPodDisruptionBudgets(
      exp.target.namespace
    );

    for (const pdb of pdbs) {
      if (pdb.status.disruptionsAllowed === 0) {
        violations.push({
          rule: "PDB_VIOLATED",
          reason: `PodDisruptionBudget '${pdb.metadata.name}' in namespace '${pdb.metadata.namespace}' currently allows 0 disruptions. Proceeding would violate the application's availability guarantees.`,
          severity: "block",
        });
      }
    }
  } catch (err) {
    // If we can't check PDBs, fail safe — don't proceed
    violations.push({
      rule: "PDB_CHECK_FAILED",
      reason: `Could not verify PodDisruptionBudgets: ${err}. Failing safe.`,
      severity: "block",
    });
  }

  return violations;
};

const durationValidator: PolicyValidator = async (exp) => {
  const violations: PolicyViolation[] = [];
  const durationMs = parseDuration(exp.duration);

  if (durationMs > 4 * 60 * 60 * 1000) {
    // 4 hours
    violations.push({
      rule: "DURATION_TOO_LONG",
      reason: "Experiments longer than 4 hours require manual approval. This prevents experiments from running indefinitely due to misconfiguration.",
      severity: "block",
    });
  }

  if (durationMs < 10_000) {
    violations.push({
      rule: "DURATION_TOO_SHORT",
      reason: "Experiments shorter than 10 seconds don't give monitoring enough time to detect degradation. Consider at least 30s.",
      severity: "warn",
    });
  }

  return violations;
};

const safetyConfigValidator: PolicyValidator = async (exp) => {
  const violations: PolicyViolation[] = [];

  if (!exp.safety.requireHealthyBefore) {
    violations.push({
      rule: "NO_PRE_HEALTH_CHECK",
      reason: "Skipping pre-flight health check means you'll inject failures into an already-degraded system. This makes it impossible to tell what your chaos caused vs what was pre-existing.",
      severity: "warn",
    });
  }

  if (!exp.safety.autoRollback) {
    violations.push({
      rule: "NO_AUTO_ROLLBACK",
      reason: "Auto-rollback is disabled. If this experiment causes cascading failures, manual intervention will be required.",
      severity: "warn",
    });
  }

  return violations;
};

const productionWindowValidator: PolicyValidator = async (exp, context) => {
  const violations: PolicyViolation[] = [];
  const hour = new Date().getUTCHours();

  // Peak hours: 13:00-22:00 UTC (covers US business hours)
  if (hour >= 13 && hour <= 22) {
    if (!context.userRoles.includes("chaos-admin")) {
      violations.push({
        rule: "PRODUCTION_WINDOW",
        reason: "Experiments during peak hours (13:00-22:00 UTC) require the chaos-admin role. This is a governance guardrail, not a technical limitation.",
        severity: "block",
      });
    }
  }

  return violations;
};

// ─── Validator registry ────────────────────────────────────────────────────────

const VALIDATORS: PolicyValidator[] = [
  blockedNamespacesValidator,
  blastRadiusValidator,
  podDisruptionBudgetValidator,
  durationValidator,
  safetyConfigValidator,
  productionWindowValidator,
];

// ─── Policy engine ─────────────────────────────────────────────────────────────

export class PolicyEngine {
  async evaluate(
    exp: ExperimentConfig,
    context: PolicyContext
  ): Promise<PolicyResult> {
    const allViolations: PolicyViolation[] = [];

    // Run all validators in parallel — they're independent
    const results = await Promise.all(
      VALIDATORS.map((v) => v(exp, context).catch((err) => {
        // A crashing validator = fail safe
        logger.error({ err, validator: v.name }, "Policy validator threw");
        return [{
          rule: "VALIDATOR_ERROR",
          reason: `Policy validator '${v.name}' failed: ${err.message}`,
          severity: "block" as const,
        }];
      }))
    );

    for (const violations of results) {
      allViolations.push(...violations);
    }

    const hardBlocks = allViolations.filter((v) => v.severity === "block");
    const warnings = allViolations
      .filter((v) => v.severity === "warn")
      .map((v) => v.reason);

    return {
      allowed: hardBlocks.length === 0,
      violations: allViolations,
      warnings,
    };
  }

  // Dry-run: evaluate policy + compute would-be targets without executing
  async dryRun(
    exp: ExperimentConfig,
    context: PolicyContext
  ): Promise<DryRunReport> {
    const policyResult = await this.evaluate(exp, context);

    let wouldTarget: SelectedTarget[] = [];
    let estimatedImpact = "Unknown";

    if (policyResult.allowed) {
      try {
        wouldTarget = await this.computeTargets(exp);
        estimatedImpact = this.estimateImpact(exp, wouldTarget);
      } catch (err) {
        logger.warn({ err }, "Could not compute dry-run targets");
      }
    }

    return {
      wouldTarget,
      wouldBlastRadius: this.computeBlastRadius(exp, wouldTarget),
      estimatedImpact,
      policyViolations: policyResult.violations,
      warnings: policyResult.warnings,
    };
  }

  private async computeTargets(exp: ExperimentConfig): Promise<SelectedTarget[]> {
    switch (exp.type) {
      case "pod-kill":
      case "network-latency":
      case "network-loss":
      case "network-partition": {
        const pods = await kubernetesClient.listPods(
          exp.target.namespace,
          exp.target.labelSelector
        );

        const maxTargets = this.getMaxTargets(exp, pods.length);
        const shuffled = pods.sort(() => Math.random() - 0.5);

        return shuffled.slice(0, maxTargets).map((pod) => ({
          kind: "pod" as const,
          name: pod.metadata.name,
          namespace: pod.metadata.namespace,
          metadata: pod.metadata.labels,
        }));
      }

      case "rpc-timeout":
      case "rpc-corrupt":
      case "rpc-latency":
        return (exp.target.rpcEndpoints ?? []).map((ep) => ({
          kind: "rpc-endpoint" as const,
          name: ep,
        }));

      default:
        return [];
    }
  }

  private getMaxTargets(exp: ExperimentConfig, totalCount: number): number {
    if (exp.blastRadius.unit === "count") {
      return Math.min(exp.blastRadius.value, exp.blastRadius.maxCount ?? Infinity, totalCount);
    }
    const pctTargets = Math.floor((exp.blastRadius.value / 100) * totalCount);
    return Math.min(pctTargets, exp.blastRadius.maxCount ?? Infinity, totalCount);
  }

  private computeBlastRadius(exp: ExperimentConfig, targets: SelectedTarget[]): number {
    return targets.length; // actual count — more useful than % in reports
  }

  private estimateImpact(exp: ExperimentConfig, targets: SelectedTarget[]): string {
    const count = targets.length;
    const typeDescriptions: Record<string, string> = {
      "pod-kill": `${count} pod(s) will be terminated`,
      "network-latency": `${count} pod(s) will experience added network latency`,
      "rpc-latency": `${targets.map((t) => t.name).join(", ")} will inject latency on all RPC calls`,
      "cpu-stress": `${count} pod(s) will experience CPU saturation`,
    };
    return typeDescriptions[exp.type] ?? `${count} target(s) will be affected`;
  }
}

export const policyEngine = new PolicyEngine();

// ─── Duration parser ───────────────────────────────────────────────────────────

export function parseDuration(d: string): number {
  const units: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  const match = d.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error(`Invalid duration format: '${d}'. Use Go-style: '30s', '5m', '2h'`);
  return parseInt(match[1]) * units[match[2]];
}
