// packages/dashboard/src/app/page.tsx
// The dashboard is the operational view of the chaos platform.
// Design principle: show the information that matters RIGHT NOW first.
// A running experiment's blast radius and system health are more important
// than historical data when someone is watching chaos unfold in production.

"use client";

import { useState, useEffect, useCallback } from "react";
import type { Experiment } from "@chaos/shared-types";
import { ExperimentCard } from "@/components/ExperimentCard";
import { KillSwitchBanner } from "@/components/KillSwitchBanner";
import { ResilienceScoreChart } from "@/components/ResilienceScoreChart";
import { SystemTopologyGraph } from "@/components/SystemTopologyGraph";
import { BlastRadiusHeatmap } from "@/components/BlastRadiusHeatmap";
import { ExperimentTimeline } from "@/components/ExperimentTimeline";
import { NewExperimentModal } from "@/components/NewExperimentModal";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const POLL_INTERVAL_MS = 5000; // 5s polling for live updates

export default function Dashboard() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [killSwitchEngaged, setKillSwitchEngaged] = useState(false);
  const [activeExperiments, setActiveExperiments] = useState<Experiment[]>([]);
  const [selectedExperiment, setSelectedExperiment] = useState<Experiment | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [experimentsRes, healthRes] = await Promise.all([
        fetch(`${API_URL}/api/v1/experiments?limit=50`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        }),
        fetch(`${API_URL}/api/v1/health`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        }),
      ]);

      const { experiments } = await experimentsRes.json();
      const health = await healthRes.json();

      setExperiments(experiments);
      setKillSwitchEngaged(health.globalKillSwitchEngaged);
      setActiveExperiments(
        experiments.filter((e: Experiment) => e.status === "running")
      );
    } catch (err) {
      console.error("Dashboard fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleKillSwitch = async (engage: boolean) => {
    const reason = engage
      ? prompt("Reason for engaging kill switch:")
      : "Manually disengaged from dashboard";

    if (engage && !reason) return;

    await fetch(`${API_URL}/api/v1/kill-switch`, {
      method: engage ? "POST" : "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
      },
      body: engage
        ? JSON.stringify({ scope: "global", reason })
        : undefined,
    });

    await fetchData();
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950">
        <div className="text-gray-400">Loading chaos platform...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Kill switch banner — always visible at top when engaged */}
      {killSwitchEngaged && (
        <KillSwitchBanner onDisengage={() => handleKillSwitch(false)} />
      )}

      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-medium text-white">Chaos Platform</h1>
            <p className="text-sm text-gray-400">
              {activeExperiments.length} active ·{" "}
              {experiments.filter((e) => e.status === "completed").length} completed
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => handleKillSwitch(!killSwitchEngaged)}
              className={`rounded px-4 py-2 text-sm font-medium transition-colors ${
                killSwitchEngaged
                  ? "bg-green-700 text-green-100 hover:bg-green-600"
                  : "bg-red-700 text-red-100 hover:bg-red-600"
              }`}
            >
              {killSwitchEngaged ? "Disengage Kill Switch" : "Kill Switch"}
            </button>
            <button
              onClick={() => setShowNewModal(true)}
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              New Experiment
            </button>
          </div>
        </div>
      </header>

      {/* Active experiments — prominently shown at top */}
      {activeExperiments.length > 0 && (
        <section className="border-b border-gray-800 bg-gray-900 px-6 py-4">
          <h2 className="mb-3 text-sm font-medium text-gray-400 uppercase tracking-wider">
            Live Experiments
          </h2>
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {activeExperiments.map((exp) => (
              <ExperimentCard
                key={exp.id}
                experiment={exp}
                isActive={true}
                onClick={() => setSelectedExperiment(exp)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-12 gap-6 p-6">
        {/* Left column: topology + heatmap */}
        <div className="col-span-7 space-y-6">
          <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="mb-4 text-sm font-medium text-gray-400">System Topology</h2>
            <SystemTopologyGraph
              experiments={activeExperiments}
              selectedExperiment={selectedExperiment}
            />
          </section>

          <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="mb-4 text-sm font-medium text-gray-400">Blast Radius Heatmap</h2>
            <BlastRadiusHeatmap experiments={experiments} />
          </section>
        </div>

        {/* Right column: score chart + timeline */}
        <div className="col-span-5 space-y-6">
          <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="mb-4 text-sm font-medium text-gray-400">Resilience Score</h2>
            <ResilienceScoreChart experiments={experiments} />
          </section>

          <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="mb-4 text-sm font-medium text-gray-400">Experiment Timeline</h2>
            <ExperimentTimeline
              experiments={experiments}
              onSelect={setSelectedExperiment}
            />
          </section>
        </div>

        {/* Bottom: experiment list */}
        <section className="col-span-12 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h2 className="mb-4 text-sm font-medium text-gray-400">All Experiments</h2>
          <div className="space-y-2">
            {experiments.map((exp) => (
              <ExperimentCard
                key={exp.id}
                experiment={exp}
                isActive={false}
                onClick={() => setSelectedExperiment(exp)}
                compact
              />
            ))}
          </div>
        </section>
      </div>

      {/* Experiment detail drawer */}
      {selectedExperiment && (
        <ExperimentDetailDrawer
          experiment={selectedExperiment}
          onClose={() => setSelectedExperiment(null)}
          onRefresh={fetchData}
          apiUrl={API_URL}
        />
      )}

      {/* New experiment modal */}
      {showNewModal && (
        <NewExperimentModal
          onClose={() => setShowNewModal(false)}
          onCreated={() => { setShowNewModal(false); fetchData(); }}
          apiUrl={API_URL}
        />
      )}
    </div>
  );
}

// ─── Experiment detail drawer ─────────────────────────────────────────────────

function ExperimentDetailDrawer({
  experiment,
  onClose,
  onRefresh,
  apiUrl,
}: {
  experiment: Experiment;
  onClose: () => void;
  onRefresh: () => void;
  apiUrl: string;
}) {
  const handleKill = async () => {
    const reason = prompt("Reason for killing this experiment:");
    if (!reason) return;

    await fetch(`${apiUrl}/api/v1/experiment/${experiment.id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
      },
      body: JSON.stringify({ reason }),
    });

    onRefresh();
    onClose();
  };

  const handleReplay = async () => {
    await fetch(`${apiUrl}/api/v1/experiment/${experiment.id}/replay`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    onRefresh();
  };

  const statusColors: Record<string, string> = {
    running: "text-green-400",
    completed: "text-blue-400",
    failed: "text-red-400",
    "rolled-back": "text-yellow-400",
    killed: "text-red-500",
    pending: "text-gray-400",
  };

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] border-l border-gray-800 bg-gray-900 shadow-2xl z-50 overflow-y-auto">
      <div className="p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-lg font-medium text-white">{experiment.config.name}</h2>
            <p className={`text-sm mt-1 ${statusColors[experiment.status] ?? "text-gray-400"}`}>
              {experiment.status} · {experiment.config.type}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">×</button>
        </div>

        {/* Metrics */}
        {experiment.metrics && (
          <div className="grid grid-cols-2 gap-3 mb-6">
            <MetricCard
              label="Chaos Score"
              value={`${experiment.metrics.chaosScore ?? 0}/100`}
              color={scoreColor(experiment.metrics.chaosScore ?? 0)}
            />
            <MetricCard
              label="MTTR"
              value={`${experiment.metrics.mttrSeconds?.toFixed(0) ?? "—"}s`}
            />
            <MetricCard
              label="Error Rate"
              value={`${((experiment.metrics.errorRateBefore ?? 0) * 100).toFixed(1)}% → ${((experiment.metrics.errorRateAfter ?? 0) * 100).toFixed(1)}%`}
            />
            <MetricCard
              label="p99 Latency"
              value={`${experiment.metrics.p99LatencyMsBefore ?? "—"}ms → ${experiment.metrics.p99LatencyMsDuring ?? "—"}ms`}
            />
          </div>
        )}

        {/* Targets */}
        {experiment.selectedTargets.length > 0 && (
          <div className="mb-6">
            <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Targeted</h3>
            <div className="space-y-1">
              {experiment.selectedTargets.map((t, i) => (
                <div key={i} className="text-sm text-gray-300 font-mono">
                  {t.kind}/{t.namespace && `${t.namespace}/`}{t.name}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Event log */}
        <div className="mb-6">
          <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Events</h3>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {experiment.events.slice().reverse().map((event, i) => (
              <div key={i} className="flex gap-2 text-xs">
                <span className="text-gray-600 shrink-0">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
                <span className={
                  event.level === "error" ? "text-red-400" :
                  event.level === "warn" ? "text-yellow-400" :
                  "text-gray-300"
                }>
                  [{event.phase}] {event.message}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          {experiment.status === "running" && (
            <button
              onClick={handleKill}
              className="flex-1 rounded bg-red-700 px-4 py-2 text-sm text-red-100 hover:bg-red-600"
            >
              Kill Experiment
            </button>
          )}
          {experiment.status === "completed" && (
            <button
              onClick={handleReplay}
              className="flex-1 rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500"
            >
              Replay
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded bg-gray-800 p-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-sm font-medium ${color ?? "text-white"}`}>{value}</p>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-400";
  if (score >= 60) return "text-yellow-400";
  return "text-red-400";
}

function getToken(): string {
  return localStorage.getItem("chaos_token") ?? "";
}
