// packages/dashboard/src/components/ResilienceScoreChart.tsx
"use client";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import type { Experiment } from "@chaos/shared-types";
import { format } from "date-fns";

interface Props { experiments: Experiment[]; }

export function ResilienceScoreChart({ experiments }: Props) {
  const data = experiments
    .filter((e) => e.status === "completed" && e.metrics?.chaosScore !== undefined)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(-20)
    .map((e) => ({
      name: format(new Date(e.createdAt), "MMM d HH:mm"),
      score: e.metrics!.chaosScore,
      type: e.config.type,
      experiment: e.config.name,
    }));

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-600 text-sm">
        No completed experiments yet
      </div>
    );
  }

  const avg = Math.round(data.reduce((s, d) => s + (d.score ?? 0), 0) / data.length);

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-4">
        <span className={`text-3xl font-light ${avg >= 80 ? "text-green-400" : avg >= 60 ? "text-yellow-400" : "text-red-400"}`}>
          {avg}
        </span>
        <span className="text-sm text-gray-500">avg score · last {data.length} experiments</span>
      </div>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} />
          <YAxis domain={[0, 100]} tick={{ fill: "#6b7280", fontSize: 10 }} tickLine={false} />
          <Tooltip
            contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 8 }}
            labelStyle={{ color: "#9ca3af" }}
            itemStyle={{ color: "#e5e7eb" }}
            formatter={(value: any, _name: any, props: any) => [
              `${value}/100`,
              props.payload.experiment,
            ]}
          />
          <ReferenceLine y={80} stroke="#22c55e" strokeDasharray="3 3" strokeOpacity={0.4} />
          <ReferenceLine y={60} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.4} />
          <Line
            type="monotone"
            dataKey="score"
            stroke="#6366f1"
            strokeWidth={2}
            dot={{ fill: "#6366f1", r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
