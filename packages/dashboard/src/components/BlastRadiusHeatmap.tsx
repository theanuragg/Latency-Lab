// packages/dashboard/src/components/BlastRadiusHeatmap.tsx
"use client";
import type { Experiment } from "@chaos/shared-types";

interface Props { experiments: Experiment[]; }

export function BlastRadiusHeatmap({ experiments }: Props) {
  // Aggregate: how many times each target was hit
  const hitCounts: Record<string, { count: number; types: Set<string> }> = {};

  for (const exp of experiments) {
    for (const t of exp.selectedTargets) {
      const key = `${t.namespace ? t.namespace + "/" : ""}${t.name}`;
      if (!hitCounts[key]) hitCounts[key] = { count: 0, types: new Set() };
      hitCounts[key].count++;
      hitCounts[key].types.add(exp.config.type);
    }
  }

  const sorted = Object.entries(hitCounts)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20);

  const maxCount = sorted[0]?.[1].count ?? 1;

  if (sorted.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-600 text-sm">
        No experiment targets yet
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {sorted.map(([target, data]) => {
        const intensity = data.count / maxCount;
        const hue = intensity > 0.7 ? "bg-red-500" : intensity > 0.4 ? "bg-orange-500" : "bg-yellow-500";

        return (
          <div key={target} className="flex items-center gap-3">
            <div className="w-40 shrink-0">
              <span className="text-xs text-gray-400 font-mono truncate block">{target}</span>
            </div>
            <div className="flex-1 bg-gray-800 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all ${hue}`}
                style={{ width: `${intensity * 100}%`, opacity: 0.7 + intensity * 0.3 }}
              />
            </div>
            <span className="text-xs text-gray-500 w-12 text-right shrink-0">
              {data.count}× hit
            </span>
            <div className="flex gap-1 shrink-0">
              {[...data.types].slice(0, 2).map((type) => (
                <span key={type} className="text-xs bg-gray-700 text-gray-400 rounded px-1">
                  {type.split("-")[0]}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
