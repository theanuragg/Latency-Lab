// packages/chaos-engine/src/runners/node-drain.ts
// Node drain simulates an AZ (availability zone) failure or node maintenance.
// Unlike pod-kill which removes individual pods, node drain:
//   1. Taints the node to prevent new pod scheduling
//   2. Cordons the node (marks it unschedulable)
//   3. Evicts all non-DaemonSet pods with respect for PDBs
//
// This is the most impactful experiment type. Use with conservative blast radius.
// Cleanup: uncordons the node and removes the taint.

import * as k8s from "@kubernetes/client-node";
import type { ExperimentConfig, SelectedTarget } from "@chaos/shared-types";
import { logger } from "../logger";

export class NodeDrainRunner {
  private k8sApi: k8s.CoreV1Api;

  constructor() {
    const kc = new k8s.KubeConfig();
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  async selectTargets(config: ExperimentConfig): Promise<SelectedTarget[]> {
    const response = await this.k8sApi.listNode();
    const nodes = response.items.filter(
      (n) =>
        // Never target control-plane nodes
        !n.metadata?.labels?.["node-role.kubernetes.io/control-plane"] &&
        !n.metadata?.labels?.["node-role.kubernetes.io/master"] &&
        n.spec?.unschedulable !== true // skip already-cordoned nodes
    );

    if (config.target.nodeName) {
      const specific = nodes.find((n) => n.metadata?.name === config.target.nodeName);
      return specific
        ? [{ kind: "node", name: specific.metadata!.name!, metadata: specific.metadata?.labels }]
        : [];
    }

    // Filter by zone if requested
    const maxTargets =
      config.blastRadius.unit === "count"
        ? config.blastRadius.value
        : Math.max(1, Math.floor((config.blastRadius.value / 100) * nodes.length));

    return nodes
      .sort(() => Math.random() - 0.5)
      .slice(0, maxTargets)
      .map((n) => ({
        kind: "node" as const,
        name: n.metadata!.name!,
        metadata: n.metadata?.labels,
      }));
  }

  async execute(
    config: ExperimentConfig,
    targets: SelectedTarget[],
    callbacks: any
  ): Promise<void> {
    for (const target of targets) {
      if (await callbacks.shouldAbort()) break;

      try {
        // Step 1: Add chaos taint — prevents new pods from scheduling here
        await this.k8sApi.patchNode({
          name: target.name,
          body: {
            spec: {
              taints: [
                {
                  key: "chaos.io/node-failure",
                  value: "true",
                  effect: "NoSchedule",
                },
              ],
              unschedulable: true, // cordon
            },
          },
        } as any);

        await callbacks.onAction(target, "Node cordoned + tainted");

        // Step 2: Evict pods from this node (respects PDBs)
        await this.evictPodsFromNode(target.name, callbacks);

        logger.info({ node: target.name }, "Node drain completed");
      } catch (err: any) {
        logger.error({ err, node: target.name }, "Node drain failed");
        await callbacks.onAction(target, `FAILED: ${err.message}`);
      }
    }
  }

  async cleanup(_config: ExperimentConfig, targets: SelectedTarget[]): Promise<void> {
    for (const target of targets) {
      try {
        // Remove taint and uncordon
        const node = await this.k8sApi.readNode({ name: target.name });
        const taints = (node.spec?.taints ?? []).filter(
          (t: any) => t.key !== "chaos.io/node-failure"
        );

        await this.k8sApi.patchNode({
          name: target.name,
          body: {
            spec: {
              taints,
              unschedulable: false,
            },
          },
        } as any);

        logger.info({ node: target.name }, "Node uncordoned, taint removed");
      } catch (err) {
        logger.error({ err, node: target.name }, "Node cleanup failed — MANUAL UNCORDON REQUIRED");
      }
    }
  }

  private async evictPodsFromNode(
    nodeName: string,
    callbacks: any
  ): Promise<void> {
    const response = await this.k8sApi.listPodForAllNamespaces({
      fieldSelector: `spec.nodeName=${nodeName},status.phase=Running`,
    });

    const pods = response.items.filter(
      (pod) =>
        // Never evict DaemonSet pods — they must run on every node
        !pod.metadata?.ownerReferences?.some((ref) => ref.kind === "DaemonSet") &&
        // Never evict static pods (kube-apiserver etc.)
        !pod.metadata?.annotations?.["kubernetes.io/config.source"]
    );

    logger.info({ nodeName, podCount: pods.length }, "Evicting pods from node");

    for (const pod of pods) {
      try {
        await this.k8sApi.createNamespacedPodEviction({
          name: pod.metadata!.name!,
          namespace: pod.metadata!.namespace!,
          body: {
            apiVersion: "policy/v1",
            kind: "Eviction",
            metadata: {
              name: pod.metadata!.name!,
              namespace: pod.metadata!.namespace!,
            },
            deleteOptions: { gracePeriodSeconds: 30 },
          },
        } as any);
      } catch (err: any) {
        // 429 = disruption budget prevents eviction — respect it
        if (err.statusCode === 429) {
          logger.warn(
            { pod: pod.metadata!.name, namespace: pod.metadata!.namespace },
            "PDB prevents eviction — skipping"
          );
        }
        // 404 = already gone — fine
      }
    }
  }
}
