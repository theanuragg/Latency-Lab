// packages/dashboard/src/components/NewExperimentModal.tsx
"use client";
import { useState } from "react";

const TEMPLATES: Record<string, string> = {
  "pod-kill": `experiment:
  name: "my-pod-kill"
  type: "pod-kill"
  target:
    namespace: "production"
    labelSelector:
      app: "my-service"
  action:
    type: "pod-kill"
    mode: "random"
    gracePeriodSeconds: 30
  blastRadius:
    unit: "percentage"
    value: 20
  duration: "5m"
  safety:
    requireHealthyBefore: true
    requireHealthyAfter: true
    maxErrorRatePct: 5
    autoRollback: true`,

  "rpc-latency": `experiment:
  name: "rpc-latency-chaos"
  type: "rpc-latency"
  target:
    rpcEndpoints:
      - "http://solana-rpc.internal:8899"
  action:
    type: "rpc-latency"
    latencyMs: 500
    jitterMs: 200
    errorRate: 0.3
  blastRadius:
    unit: "percentage"
    value: 50
  duration: "5m"
  safety:
    requireHealthyBefore: true
    maxErrorRatePct: 10
    autoRollback: true`,

  "network-latency": `experiment:
  name: "network-latency"
  type: "network-latency"
  target:
    namespace: "production"
    labelSelector:
      app: "my-service"
  action:
    type: "network-latency"
    latencyMs: 200
    jitterMs: 50
    direction: "egress"
  blastRadius:
    unit: "percentage"
    value: 25
  duration: "5m"
  safety:
    requireHealthyBefore: true
    maxLatencyMs: 1000
    autoRollback: true`,
};

interface Props {
  onClose: () => void;
  onCreated: () => void;
  apiUrl: string;
}

export function NewExperimentModal({ onClose, onCreated, apiUrl }: Props) {
  const [yaml, setYaml] = useState(TEMPLATES["pod-kill"]);
  const [selectedTemplate, setSelectedTemplate] = useState("pod-kill");
  const [dryRun, setDryRun] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleTemplateChange = (tpl: string) => {
    setSelectedTemplate(tpl);
    setYaml(TEMPLATES[tpl]);
    setResult(null);
    setError(null);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Parse YAML on server side — send raw YAML as text
      const endpoint = dryRun ? `${apiUrl}/api/v1/dry-run` : `${apiUrl}/api/v1/experiment`;

      // Convert YAML to JSON for the API (in production use a proper YAML parser)
      const response = await fetch("/api/parse-yaml", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml }),
      });

      if (!response.ok) {
        const err = await response.json();
        setError(err.error ?? "Parse error");
        return;
      }

      const { config } = await response.json();

      const apiResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("chaos_token") ?? ""}`,
        },
        body: JSON.stringify(config),
      });

      const data = await apiResponse.json();

      if (!apiResponse.ok) {
        setError(JSON.stringify(data, null, 2));
        return;
      }

      setResult(data);
      if (!dryRun) {
        setTimeout(() => { onCreated(); }, 1500);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <h2 className="text-lg font-medium text-white">New Experiment</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>

        {/* Template picker */}
        <div className="flex gap-2 p-4 border-b border-gray-800">
          {Object.keys(TEMPLATES).map((tpl) => (
            <button
              key={tpl}
              onClick={() => handleTemplateChange(tpl)}
              className={`text-xs rounded px-3 py-1.5 transition-colors ${
                selectedTemplate === tpl
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
            >
              {tpl}
            </button>
          ))}
        </div>

        {/* YAML editor */}
        <div className="flex-1 overflow-hidden p-4">
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            className="w-full h-64 bg-gray-950 text-gray-200 font-mono text-xs rounded-lg border border-gray-700 p-3 resize-none focus:outline-none focus:border-indigo-500"
            spellCheck={false}
          />
        </div>

        {/* Result */}
        {result && (
          <div className={`mx-4 mb-4 p-3 rounded-lg text-xs font-mono ${
            result.policyViolations?.some((v: any) => v.severity === "block")
              ? "bg-red-900/30 text-red-300 border border-red-800"
              : "bg-green-900/30 text-green-300 border border-green-800"
          }`}>
            <pre className="overflow-auto max-h-32">{JSON.stringify(result, null, 2)}</pre>
          </div>
        )}

        {error && (
          <div className="mx-4 mb-4 p-3 rounded-lg bg-red-900/30 text-red-300 border border-red-800 text-xs font-mono">
            <pre className="overflow-auto max-h-24">{error}</pre>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-gray-800">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="rounded"
            />
            Dry run (simulate only)
          </label>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {loading ? "Running..." : dryRun ? "Simulate" : "Create Experiment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
