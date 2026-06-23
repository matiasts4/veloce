"use client";

import { useEffect, useRef } from "react";
import { useStableListener } from "@/hooks/use-stable-listener";

type Status = "idle" | "listening" | "processing" | "transcribing";

interface MiniVUBarsProps {
  status: Status;
}

interface VUMeterPayload {
  rms: number;
}

export function MiniVUBars({ status }: MiniVUBarsProps) {
  const barsRef = useRef<(HTMLDivElement | null)[]>([]);
  const statusRef = useRef(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const getColorClass = () => {
    switch (status) {
      case "listening":
        return "bg-primary shadow-[0_0_8px_rgba(var(--primary),0.3)]";
      case "transcribing":
        return "bg-cyan-400/80 shadow-[0_0_8px_rgba(34,211,238,0.3)]";
      case "processing":
        return "bg-amber-500/80 shadow-[0_0_8px_rgba(245,158,11,0.3)]";
      default:
        return "bg-muted-foreground/30";
    }
  };

  useStableListener<VUMeterPayload>("vu-update", (payload) => {
    if (statusRef.current !== "listening") return;

    const { rms } = payload;
    let normalized = Math.log10(rms + 1) / 4.2;
    normalized = (normalized - 0.3) / 0.7;

    if (normalized > 1) normalized = 1;
    if (normalized < 0) normalized = 0;

    // Using minimum 30% height when listening but quiet
    const minScale = 0.3;

    barsRef.current.forEach((bar, index) => {
      if (!bar) return;
      const distFromCenter = Math.abs(index - 2.5);
      // Middle bars get full height, outer bars get less
      const multiplier = 1 - (distFromCenter * 0.15);

      // Subtle noise
      const noise = (Math.random() * 0.1) - 0.05;

      let val = normalized * multiplier + (normalized > 0.05 ? noise : 0);
      val = Math.max(minScale, Math.min(1, val));

      bar.style.transform = `scaleY(${val})`;
    });
  }, []);

  // Handle non-listening animations (pulse for transcribing/processing, flat for idle)
  useEffect(() => {
    if (status !== "listening") {
      let animationFrameId: number;

      const animate = () => {
        const time = Date.now() / 150; // speed of pulse
        barsRef.current.forEach((bar, index) => {
          if (!bar) return;

          if (status === "transcribing" || status === "processing") {
            // Wave pulse effect
            const offset = index * 0.5;
            const val = 0.5 + Math.sin(time + offset) * 0.2;
            bar.style.transform = `scaleY(${val})`;
          } else {
            // Flat for idle
            bar.style.transform = "scaleY(0.4)";
          }
        });

        if (status === "transcribing" || status === "processing") {
          animationFrameId = requestAnimationFrame(animate);
        }
      };

      animate();

      return () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
      };
    }
  }, [status]);

  const colorClass = getColorClass();

  return (
    <div className="flex items-center gap-[1.8px] pointer-events-none h-4" data-tauri-drag-region>
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          ref={(el) => { barsRef.current[index] = el; }}
          className={`w-[2.5px] rounded-full transition-transform duration-75 ${colorClass}`}
          style={{ transform: "scaleY(0.4)", height: "100%" }}
          data-tauri-drag-region
        />
      ))}
    </div>
  );
}
