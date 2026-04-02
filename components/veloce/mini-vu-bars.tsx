"use client";

import { useEffect, useRef } from "react";

type Status = "idle" | "listening" | "processing" | "transcribing";

interface MiniVUBarsProps {
  status: Status;
}

interface VUMeterPayload {
  rms: number;
}

export function MiniVUBars({ status }: MiniVUBarsProps) {
  const barsRef = useRef<(HTMLDivElement | null)[]>([]);

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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isSubscribed = true;

    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri() || !isSubscribed) return;

      import("@tauri-apps/api/event").then(({ listen }) => {
        if (!isSubscribed) return;
        listen<VUMeterPayload>("vu-update", (event) => {
          if (status !== "listening") return;
          
          const { rms } = event.payload;
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
        }).then((u) => {
          unlisten = u;
        });
      });
    });

    return () => {
      isSubscribed = false;
      if (unlisten) unlisten();
    };
  }, [status]);

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

      if (status === "transcribing" || status === "processing") {
        animate();
      } else {
        animate(); // run once to set idle state
      }

      return () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
      };
    }
  }, [status]);

  const colorClass = getColorClass();

  return (
    <div className="flex items-center gap-[1.8px] pointer-events-none h-4" data-tauri-drag-region>
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className={`w-[2.5px] h-full rounded-full transition-colors duration-500 origin-center ${colorClass} ${status === 'listening' ? 'transition-transform duration-[50ms] ease-out' : ''}`}
          style={{ transform: "scaleY(0.4)" }}
        />
      ))}
    </div>
  );
}
