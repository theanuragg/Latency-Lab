// packages/dashboard/src/components/ExperimentTimeline.tsx
"use client";
import type { Experiment } from "@chaos/shared-types";
import { format, formatDistanceToNow } from "date-fns";

interface Props {
  experiments: Experiment[];
  onSelect: (exp: Experiment) => void;
}

const STATUS_DOT: Record<string, string> = {
  running:       "bg-green-500 animate-pulse",
  completed:     "bg-blue-500",
  failed:        "bg-red-500",
  "rolled-back": "bg-yellow-500",
  killed:        "bg-red-600",
  pending:       "bg-gray-500",
};

export function ExperimentTimeline({ experiments, onSelect }: Props) {
  const recent = [...experiments]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 15);

  if (recent.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
        No experiments yet
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-700" />

      <div className="space-y-3">
        {recent.map((exp) => (
          <div
            key={exp.id}
            onClick={() => onSelect(exp)}
            className="flex gap-3 cursor-pointer group"
          >
            {/* Status dot */}
            <div className={`w-3.5 h-3.5 rounded-full shrink-0 mt-0.5 border-2 border-gray-950 z-10 ${STATUS_DOT[exp.status] ?? STATUS_DOT.pending}`} />

            {/* Content */}
            <div className="flex-1 min-w-0 pb-3 border-b border-gray-800/50 last:border-0 group-hover:border-gray-700 transition-colors">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-gray-200 truncate group-hover:text-white transition-colors">
                  {exp.config.name}
                </span>
                <span className="text-xs text-gray-600 shrink-0">
                  {formatDistanceToNow(new Date(exp.createdAt), { addSuffix: true })}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-gray-500">{exp.config.type}</span>
                {exp.config.target.namespace && (
                  <span className="text-xs text-gray-600">· {exp.config.target.namespace}</span>
                )}
                {exp.metrics?.chaosScore !== undefined && (
                  <span className={`text-xs ml-auto ${
                    exp.metrics.chaosScore >= 80 ? "text-green-500" :
                    exp.metrics.chaosScore >= 60 ? "text-yellow-500" : "text-red-500"
                  }`}>
                    {exp.metrics.chaosScore}/100
                  </span>
                )}
              </div>
              {exp.rollbackReason && (
                <p className="text-xs text-red-400 mt-0.5 truncate">{exp.rollbackReason}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
