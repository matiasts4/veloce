"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { X } from "lucide-react";

type Status = "idle" | "listening" | "processing" | "transcribing";

// ── Mini VU bars (inline, sin dependencia del componente principal) ──────────
function PillVUBars({ status }: { status: Status }) {
  const barsRef = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isSubscribed = true;

    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri() || !isSubscribed) return;
      import("@tauri-apps/api/event").then(({ listen }) => {
        if (!isSubscribed) return;
        listen<{ rms: number }>("vu-update", (event) => {
          if (status !== "listening") return;
          const { rms } = event.payload;
          let normalized = Math.log10(rms + 1) / 4.2;
          normalized = (normalized - 0.3) / 0.7;
          normalized = Math.max(0, Math.min(1, normalized));
          const minScale = 0.3;
          barsRef.current.forEach((bar, i) => {
            if (!bar) return;
            const dist = Math.abs(i - 2.5);
            const mult = 1 - dist * 0.15;
            const noise = Math.random() * 0.1 - 0.05;
            const val = Math.max(minScale, Math.min(1, normalized * mult + (normalized > 0.05 ? noise : 0)));
            bar.style.transform = `scaleY(${val})`;
          });
        }).then((u) => { unlisten = u; });
      });
    });

    return () => {
      isSubscribed = false;
      if (unlisten) unlisten();
    };
  }, [status]);

  useEffect(() => {
    if (status === "listening") return;
    let raf: number;
    const animate = () => {
      const t = Date.now() / 150;
      barsRef.current.forEach((bar, i) => {
        if (!bar) return;
        if (status === "transcribing" || status === "processing") {
          bar.style.transform = `scaleY(${0.5 + Math.sin(t + i * 0.5) * 0.25})`;
        } else {
          bar.style.transform = "scaleY(0.35)";
        }
      });
      if (status === "transcribing" || status === "processing") raf = requestAnimationFrame(animate);
    };
    animate();
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [status]);

  const color =
    status === "listening" ? "bg-blue-400"
    : status === "transcribing" ? "bg-cyan-400"
    : status === "processing" ? "bg-amber-400"
    : "bg-white/30";

  return (
    <div className="flex items-center gap-[2px] h-3.5 pointer-events-none">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          ref={(el) => { barsRef.current[i] = el; }}
          className={`w-[2px] h-full rounded-full origin-center transition-colors duration-300 ${color}`}
          style={{ transform: "scaleY(0.35)" }}
        />
      ))}
    </div>
  );
}

// ── Pill page ─────────────────────────────────────────────────────────────────
export default function PillPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [isRecording, setIsRecording] = useState(false);

  // Restore main window & hide pill
  const handleRestore = useCallback(async () => {
    try {
      const { safeInvoke } = await import("@/lib/tauri-client");
      await safeInvoke("hide_pill");

      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      // Signal the main window to show itself
      const { emit } = await import("@tauri-apps/api/event");
      await emit("show-window");

      // Also try to show main directly
      const { getAll } = await import("@tauri-apps/api/window");
      const windows = await getAll();
      const mainWin = windows.find((w) => w.label === "main");
      if (mainWin) {
        await mainWin.show();
        await mainWin.unminimize();
        await mainWin.setFocus();
      }
    } catch (e) {
      console.error("restore failed", e);
    }
  }, []);

  // Listen to engine events (broadcast to ALL windows by Tauri)
  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;
    let unlistenRecording: (() => void) | undefined;

    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri()) return;
      import("@tauri-apps/api/event").then(async ({ listen }) => {
        unlistenStatus = await listen<string>("status-update", (e) => {
          if (e.payload === "recording") setStatus("listening");
          else if (e.payload === "transcribing_final") setStatus("transcribing");
          else if (e.payload === "loading_model") setStatus("processing");
          else if (e.payload === "stopped" || e.payload === "ready") setStatus("idle");
        });
        unlistenRecording = await listen<boolean>("recording-state", (e) => {
          setIsRecording(e.payload);
          if (e.payload) setStatus("listening");
        });
      });
    });

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenRecording) unlistenRecording();
    };
  }, []);

  const label =
    status === "listening" ? "grabando"
    : status === "transcribing" ? "procesando"
    : status === "processing" ? "cargando"
    : "veloce";

  const ringColor =
    status === "listening" ? "bg-blue-400"
    : status === "transcribing" ? "bg-cyan-400"
    : null;

  return (
    // Full window is 200×36, transparent bg, no overflow
    <div
      className="w-full h-full flex items-center justify-center"
      style={{ background: "transparent" }}
    >
      {/* The pill itself */}
      <div
        className={`
          group relative flex items-center gap-2 px-3 py-1 rounded-full cursor-pointer select-none
          border transition-all duration-300
          ${status === "listening"
            ? "border-blue-400/60 bg-[rgba(30,64,175,0.55)] shadow-[0_2px_16px_rgba(59,130,246,0.35)]"
            : status === "transcribing"
            ? "border-cyan-400/60 bg-[rgba(8,145,178,0.55)] shadow-[0_2px_16px_rgba(34,211,238,0.3)]"
            : status === "processing"
            ? "border-amber-400/60 bg-[rgba(120,53,15,0.55)] shadow-[0_2px_16px_rgba(245,158,11,0.3)]"
            : "border-white/10 bg-[rgba(15,15,20,0.72)] shadow-[0_2px_12px_rgba(0,0,0,0.5)]"
          }
          backdrop-blur-md
        `}
        data-tauri-drag-region
        onDoubleClick={handleRestore}
        title="Doble click para abrir Veloce"
      >
        {/* Drag region */}
        <div className="absolute inset-0 rounded-full" data-tauri-drag-region />

        {/* Animated ring when active */}
        {ringColor && (
          <span
            className={`absolute inset-0 rounded-full ${ringColor} opacity-15 animate-ping`}
            style={{ animationDuration: "2.5s" }}
          />
        )}

        {/* VU bars */}
        <div className="relative z-10">
          <PillVUBars status={status} />
        </div>

        {/* Label */}
        <span
          className={`
            relative z-10 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] pointer-events-none
            transition-colors duration-300
            ${status === "listening" ? "text-blue-200"
              : status === "transcribing" ? "text-cyan-200"
              : status === "processing" ? "text-amber-200"
              : "text-white/50"}
          `}
        >
          {label}
        </span>

        {/* Close / restore button on hover */}
        <button
          onClick={handleRestore}
          className="relative z-20 ml-0.5 flex h-3.5 w-3.5 scale-0 items-center justify-center rounded-full bg-white/10 text-white/50 opacity-0 transition-all duration-200 group-hover:scale-100 group-hover:opacity-100 hover:bg-red-500/70 hover:text-white"
          title="Abrir Veloce"
        >
          <X className="h-2 w-2 stroke-[3]" />
        </button>
      </div>
    </div>
  );
}
