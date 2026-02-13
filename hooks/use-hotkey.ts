"use client";

import { useEffect, useCallback, useRef } from "react";

export interface HotkeyCombo {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Converts a keyboard event or combo into a human-readable label */
export function formatCombo(combo: HotkeyCombo | null): string {
  if (!combo) return "Not set";
  const parts: string[] = [];
  if (combo.ctrlKey) parts.push("Ctrl");
  if (combo.altKey) parts.push("Alt");
  if (combo.shiftKey) parts.push("Shift");
  if (combo.metaKey) parts.push("Meta");
  const keyLabel =
    combo.key === " "
      ? "Space"
      : combo.key.length === 1
        ? combo.key.toUpperCase()
        : combo.key;
  parts.push(keyLabel);
  return parts.join(" + ");
}

/** Splits a combo into individual key labels for rendering individual keycaps */
export function splitComboKeys(combo: HotkeyCombo | null): string[] {
  if (!combo) return ["--"];
  const parts: string[] = [];
  if (combo.ctrlKey) parts.push("Ctrl");
  if (combo.altKey) parts.push("Alt");
  if (combo.shiftKey) parts.push("Shift");
  if (combo.metaKey) parts.push("Meta");
  const keyLabel =
    combo.key === " "
      ? "Space"
      : combo.key.length === 1
        ? combo.key.toUpperCase()
        : combo.key;
  parts.push(keyLabel);
  return parts;
}

/** Checks whether a keyboard event matches a given combo */
export function matchesCombo(e: KeyboardEvent, combo: HotkeyCombo | null): boolean {
  if (!combo) return false;
  return (
    e.key.toLowerCase() === combo.key.toLowerCase() &&
    e.ctrlKey === combo.ctrlKey &&
    e.shiftKey === combo.shiftKey &&
    e.altKey === combo.altKey &&
    e.metaKey === combo.metaKey
  );
}

/** Creates a combo object from a keyboard event */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): HotkeyCombo | null {
  // Ignore lone modifier keys
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  return {
    key: e.key,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
  };
}

/**
 * Registers a global hotkey listener. When the combo matches, `callback` fires.
 * Pass `enabled = false` to pause the listener (e.g. while recording a new combo).
 */
export function useHotkey(
  combo: HotkeyCombo | null,
  callback: () => void,
  enabled = true
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const handler = useCallback(
    (e: KeyboardEvent) => {
      if (matchesCombo(e, combo)) {
        e.preventDefault();
        e.stopPropagation();
        callbackRef.current();
      }
    },
    [combo]
  );

  useEffect(() => {
    if (!enabled || !combo) return;
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [handler, enabled, combo]);
}
