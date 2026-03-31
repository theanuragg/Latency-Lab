// packages/control-plane/src/policy/engine.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PolicyEngine, parseDuration } from "./engine";
import type { ExperimentConfig } from "@chaos/shared-types";

// Mock the kubernetes client and config
vi.mock("../engine/kubernetes", () => ({
  kubernetesClient: {
    listPods: vi.fn().mockResolvedValue([
      { metadata: { name: "pod-1", namespace: "production", labels: { app: "api" }, ownerReferences: [{ kind: "ReplicaSet" }] }, status: { phase: "Running" } },
      { metadata: { name: "pod-2", namespace: "production", labels: { app: "api" }, ownerReferences: [{ kind: "ReplicaSet" }] }, status: { phase: "Running" } },
      { metadata: { name: "pod-3", namespace: "production", labels: { app: "api" }, ownerReferences: [{ kind: "ReplicaSet" }] }, status: { phase: "Running" } },
    ]),
    listPodDisruptionBudgets: vi.fn().mockResolvedValue([
      { metadata: { name: "api-pdb", namespace: "production" }, status: { disruptionsAllowed: 2 } },
    ]),
  },
}));

vi.mock("../server", () => ({
  config: {
    blockedNamespaces: ["kube-system", "kube-public", "kube-node-lease"],
    maxBlastRadiusPct: 30,
  },
}));

const baseConfig: ExperimentConfig = {
  name: "test-experiment",
  type: "pod-kill",
  target: {
    namespace: "production",
    labelSelector: { app: "api" },
  },
  action: { type: "pod-kill", mode: "random" },
  blastRadius: { unit: "percentage", value: 20 },
  duration: "5m",
  safety: {
    requireHealthyBefore: true,
    requireHealthyAfter: true,
    autoRollback: true,
  },
};

const baseContext = {
  requestingUser: "test-user",
  userRoles: ["chaos-operator"],
};

describe("PolicyEngine", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  describe("blockedNamespacesValidator", () => {
    it("blocks experiments targeting kube-system", async () => {
      const config = { ...baseConfig, target: { namespace: "kube-system" } };
      const result = await engine.evaluate(config, baseContext);
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "BLOCKED_NAMESPACE")).toBe(true);
    });

    it("allows experiments targeting production", async () => {
      const result = await engine.evaluate(baseConfig, baseContext);
      // May have warnings but should not be blocked by namespace
      expect(result.violations.filter((v) => v.rule === "BLOCKED_NAMESPACE" && v.severity === "block")).toHaveLength(0);
    });
  });

  describe("blastRadiusValidator", () => {
    it("blocks blast radius above global maximum", async () => {
      const config = { ...baseConfig, blastRadius: { unit: "percentage" as const, value: 50 } };
      const result = await engine.evaluate(config, baseContext);
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "BLAST_RADIUS_EXCEEDED")).toBe(true);
    });

    it("allows blast radius within limits", async () => {
      const config = { ...baseConfig, blastRadius: { unit: "percentage" as const, value: 25 } };
      const result = await engine.evaluate(config, baseContext);
      expect(result.violations.filter((v) => v.rule === "BLAST_RADIUS_EXCEEDED")).toHaveLength(0);
    });
  });

  describe("durationValidator", () => {
    it("warns on very short duration", async () => {
      const config = { ...baseConfig, duration: "5s" };
      const result = await engine.evaluate(config, baseContext);
      expect(result.warnings.some((w) => w.includes("10 seconds"))).toBe(true);
    });

    it("blocks duration longer than 4 hours", async () => {
      const config = { ...baseConfig, duration: "5h" };
      const result = await engine.evaluate(config, baseContext);
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.rule === "DURATION_TOO_LONG")).toBe(true);
    });

    it("accepts valid duration", async () => {
      const config = { ...baseConfig, duration: "10m" };
      const result = await engine.evaluate(config, baseContext);
      expect(result.violations.filter((v) => v.rule === "DURATION_TOO_LONG" || v.rule === "DURATION_TOO_SHORT")).toHaveLength(0);
    });
  });

  describe("safetyConfigValidator", () => {
    it("warns when requireHealthyBefore is false", async () => {
      const config = {
        ...baseConfig,
        safety: { ...baseConfig.safety, requireHealthyBefore: false },
      };
      const result = await engine.evaluate(config, baseContext);
      expect(result.warnings.some((w) => w.includes("pre-flight"))).toBe(true);
    });

    it("warns when autoRollback is false", async () => {
      const config = {
        ...baseConfig,
        safety: { ...baseConfig.safety, autoRollback: false },
      };
      const result = await engine.evaluate(config, baseContext);
      expect(result.warnings.some((w) => w.includes("Auto-rollback"))).toBe(true);
    });
  });

  describe("dry-run", () => {
    it("returns target list and blast radius", async () => {
      const report = await engine.dryRun(baseConfig, baseContext);
      expect(report.wouldTarget).toBeInstanceOf(Array);
      expect(report.policyViolations).toBeInstanceOf(Array);
      expect(typeof report.estimatedImpact).toBe("string");
    });
  });
});

describe("parseDuration", () => {
  it("parses seconds", () => expect(parseDuration("30s")).toBe(30_000));
  it("parses minutes", () => expect(parseDuration("5m")).toBe(300_000));
  it("parses hours", () => expect(parseDuration("2h")).toBe(7_200_000));
  it("throws on invalid format", () => expect(() => parseDuration("5d")).toThrow());
});
