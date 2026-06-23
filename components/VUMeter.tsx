"use client";

import { useRef } from "react";
import { useStableListener } from "@/hooks/use-stable-listener";

interface VUMeterPayload {
  rms: number;
}

export function VUMeter({ className, barClassName }: { className?: string, barClassName?: string }) {
  const meterRef = useRef<HTMLDivElement>(null);

  useStableListener<VUMeterPayload>("vu-update", (payload) => {
    if (meterRef.current) {
      const { rms } = payload;

      let normalized = Math.log10(rms + 1) / 4.2;
      normalized = (normalized - 0.3) / 0.7;

      if (normalized > 1) normalized = 1;
      if (normalized < 0) normalized = 0;

      meterRef.current.style.transform = `scaleX(${normalized})`;
    }
  }, []);

  return (
    <div className={className || "w-full max-w-[120px] h-1.5 bg-neutral-800 rounded-full overflow-hidden border border-neutral-700/50"}>
      <div
        ref={meterRef}
        className={barClassName || "h-full bg-emerald-500 origin-left transition-transform duration-[50ms] ease-out"}
        style={{ transform: "scaleX(0)" }}
      />
    </div>
  );
}
