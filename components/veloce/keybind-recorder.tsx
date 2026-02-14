"use client";

import { useState, useRef, useEffect } from "react";
import { type HotkeyCombo, formatCombo, comboFromEvent } from "@/hooks/use-hotkey";
import { cn } from "@/lib/utils";

interface KeybindRecorderProps {
  value: HotkeyCombo | null;
  onChange: (combo: HotkeyCombo | null) => void;
  mode?: "any" | "single" | "combo";
  /** Fires when the user starts / stops recording so the parent can pause global hotkeys */
  onRecordingChange?: (recording: boolean) => void;
}

export function KeybindRecorder({
  value,
  onChange,
  mode = "any",
  onRecordingChange,
}: KeybindRecorderProps) {
  const [recording, setRecording] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Notify parent when recording state changes
  useEffect(() => {
    onRecordingChange?.(recording);
  }, [recording, onRecordingChange]);

  // Listen for keydown while recording
  useEffect(() => {
    if (!recording) return;

    const handleKeydown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const captured = comboFromEvent(e);
      if (captured) {
        const combo =
          mode === "single"
            ? {
                key: captured.key,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                metaKey: false,
              }
            : captured;

        onChange(combo);
        setRecording(false);
      }
    };

    // Click outside to cancel
    const handleClick = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setRecording(false);
      }
    };

    window.addEventListener("keydown", handleKeydown, true);
    window.addEventListener("mousedown", handleClick, true);
    return () => {
      window.removeEventListener("keydown", handleKeydown, true);
      window.removeEventListener("mousedown", handleClick, true);
    };
  }, [recording, onChange, mode]);

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => setRecording(true)}
      className={cn(
        "flex h-9 w-full items-center justify-center rounded-md border px-3 font-mono text-xs transition-colors",
        recording
          ? "animate-pulse border-primary bg-primary/10 text-primary"
          : "border-border bg-secondary text-foreground hover:border-primary/30"
      )}
    >
      {recording ? "Press keys..." : formatCombo(value)}
    </button>
  );
}
