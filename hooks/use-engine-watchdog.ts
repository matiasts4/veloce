"use client";

import { useEffect, useRef } from "react";

type Status = "idle" | "listening" | "processing" | "transcribing";

export function useEngineWatchdog(
  status: Status,
  onStall: () => void,
  timeoutMs: number = 10000
) {
  const lastActivityRef = useRef<number>(Date.now());

  useEffect(() => {
    if (status === "listening" || status === "transcribing") {
      lastActivityRef.current = Date.now();
    }
  }, [status]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (status !== "listening" && status !== "transcribing") return;
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed > timeoutMs) {
        console.warn("[useEngineWatchdog] Engine appears stalled; resetting UI state");
        onStall();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [status, onStall, timeoutMs]);

  return {
    bump: () => {
      lastActivityRef.current = Date.now();
    },
  };
}
