// packages/control-plane/src/engine/kubernetes.ts
// Kubernetes API client wrapper used by the policy engine for pre-flight checks.
// The chaos engine runners have their own clients for execution.

import * as k8s from "@kubernetes/client-node";
import { logger } from "../observability/logger";

class KubernetesClient {
  private coreApi: k8s.CoreV1Api;
  private policyApi: k8s.PolicyV1Api;
  private appsApi: k8s.AppsV1Api;

  constructor() {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
      logger.info("Kubernetes: loaded in-cluster config");
    } catch {
      try {
        kc.loadFromDefault();
        logger.info("Kubernetes: loaded kubeconfig from default");
      } catch (err) {
        logger.warn({ err }, "Kubernetes: no config found — K8s features disabled");
      }
    }

    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.policyApi = kc.makeApiClient(k8s.PolicyV1Api);
    this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
  }

  async listPods(
    namespace?: string,
    labelSelector?: Record<string, string>
  ): Promise<any[]> {
    const labelStr = labelSelector
      ? Object.entries(labelSelector).map(([k, v]) => `${k}=${v}`).join(",")
      : undefined;

    const response = await this.coreApi.listNamespacedPod({
      namespace: namespace ?? "default",
      labelSelector: labelStr,
      fieldSelector: "status.phase=Running",
    });

    return response.items;
  }

  async listPodDisruptionBudgets(namespace?: string): Promise<any[]> {
    const response = await this.policyApi.listNamespacedPodDisruptionBudget({
      namespace: namespace ?? "default",
    });
    return response.items;
  }

  async getDeployment(name: string, namespace: string): Promise<any> {
    return this.appsApi.readNamespacedDeployment({ name, namespace });
  }

  async listNodes(): Promise<any[]> {
    const response = await this.coreApi.listNode();
    return response.items;
  }
}

export const kubernetesClient = new KubernetesClient();
