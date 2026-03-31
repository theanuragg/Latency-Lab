// packages/dashboard/src/components/ExperimentCard.tsx
"use client";
import type { Experiment } from "@chaos/shared-types";

const STATUS_STYLES: Record<string, string> = {
  running:      "bg-green-500/10 text-green-400 border-green-500/20",
  completed:    "bg-blue-500/10 text-blue-400 border-blue-500/20",
  failed:       "bg-red-500/10 text-red-400 border-red-500/20",
  "rolled-back":"bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  killed:       "bg-red-600/10 text-red-500 border-red-600/20",
  pending:      "bg-gray-500/10 text-gray-400 border-gray-500/20",
  paused:       "bg-orange-500/10 text-orange-400 border-orange-500/20",
};

const TYPE_ICONS: Record<string, string> = {
  "pod-kill":           "⬡",
  "network-latency":    "≋",
  "network-loss":       "✕",
  "network-partition":  "⊘",
  "rpc-latency":        "⏱",
  "rpc-timeout":        "⌛",
  "rpc-corrupt":        "✗",
  "cpu-stress":         "▲",
  "memory-exhaust":     "▣",
  "disk-throttle":      "◈",
  "node-drain":         "⬢",
  "dependency-kill":    "⊗",
};

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-400";
  if (score >= 60) return "text-yellow-400";
  return "text-red-400";
}

interface Props {
  experiment: Experiment;
  isActive: boolean;
  onClick: () => void;
  compact?: boolean;
}

export function ExperimentCard({ experiment, isActive, onClick, compact = false }: Props) {
  const statusStyle = STATUS_STYLES[experiment.status] ?? STATUS_STYLES.pending;
  const icon = TYPE_ICONS[experiment.config.type] ?? "?";
  const score = experiment.metrics?.chaosScore;
  const duration =
    experiment.startedAt && experiment.completedAt
      ? `${Math.round((new Date(experiment.completedAt).getTime() - new Date(experiment.startedAt).getTime()) / 1000)}s`
      : experiment.startedAt ? "running..." : null;

  if (compact) {
    return (
      <div
        onClick={onClick}
        className="flex items-center justify-between rounded-lg border border-gray-800 px-4 py-2 cursor-pointer hover:border-gray-600 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-gray-500 font-mono text-sm w-4 shrink-0">{icon}</span>
          <span className="text-sm text-gray-200 truncate">{experiment.config.name}</span>
          <span className="text-xs text-gray-500 shrink-0">{experiment.config.type}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-4">
          {score !== undefined && (
            <span className={`text-xs font-medium ${scoreColor(score)}`}>{score}/100</span>
          )}
          {duration && <span className="text-xs text-gray-500">{duration}</span>}
          <span className={`text-xs px-2 py-0.5 rounded border ${statusStyle}`}>
            {experiment.status}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      className={`rounded-lg border cursor-pointer transition-all p-4 ${
        isActive
          ? "border-green-500/30 bg-green-500/5 hover:bg-green-500/10"
          : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-gray-400 font-mono">{icon}</span>
            <span className="text-sm font-medium text-white truncate">
              {experiment.config.name}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {experiment.config.type}
            {experiment.config.target.namespace && ` · ${experiment.config.target.namespace}`}
          </div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded border shrink-0 ${statusStyle}`}>
          {experiment.status}
        </span>
      </div>

      {/* Targets */}
      {experiment.selectedTargets.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {experiment.selectedTargets.slice(0, 3).map((t, i) => (
            <span key={i} className="text-xs bg-gray-700/50 text-gray-400 rounded px-1.5 py-0.5 font-mono">
              {t.name}
            </span>
          ))}
          {experiment.selectedTargets.length > 3 && (
            <span className="text-xs text-gray-500">+{experiment.selectedTargets.length - 3} more</span>
          )}
        </div>
      )}

      {/* Metrics row */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        {score !== undefined && (
          <span>
            Score: <span className={`font-medium ${scoreColor(score)}`}>{score}/100</span>
          </span>
        )}
        {experiment.metrics?.mttrSeconds !== undefined && (
          <span>MTTR: {experiment.metrics.mttrSeconds.toFixed(0)}s</span>
        )}
        {duration && <span>{duration}</span>}
        <span className="ml-auto">
          {new Date(experiment.createdAt).toLocaleDateString()}
        </span>
      </div>

      {/* Live pulse for running experiments */}
      {isActive && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-green-500/10">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-green-400">
            {experiment.events[experiment.events.length - 1]?.message ?? "Running..."}
          </span>
        </div>
      )}
    </div>
  );
}
