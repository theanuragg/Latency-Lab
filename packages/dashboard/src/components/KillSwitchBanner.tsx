// packages/dashboard/src/components/KillSwitchBanner.tsx
"use client";

export function KillSwitchBanner({ onDisengage }: { onDisengage: () => void }) {
  return (
    <div className="bg-red-900/80 border-b border-red-700 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
        <span className="text-sm font-medium text-red-200">
          GLOBAL KILL SWITCH ENGAGED — All chaos experiments are halted
        </span>
      </div>
      <button
        onClick={onDisengage}
        className="text-xs bg-red-700 hover:bg-red-600 text-red-100 rounded px-3 py-1 transition-colors"
      >
        Disengage
      </button>
    </div>
  );
}
