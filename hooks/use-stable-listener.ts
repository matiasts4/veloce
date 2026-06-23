"use client";

import { useEffect, useRef } from "react";

export function useStableListener<T>(
  eventName: string,
  handler: (payload: T) => void,
  deps: unknown[] = []
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const unlistenRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    let cancelled = false;

    import("@tauri-apps/api/event").then(({ listen }) => {
      if (cancelled) return;
      listen<T>(eventName, (event) => {
        if (activeRef.current) {
          handlerRef.current(event.payload);
        }
      }).then((unlisten) => {
        if (cancelled) {
          unlisten();
        } else {
          unlistenRef.current = unlisten;
        }
      }).catch((error) => {
        console.error(`[useStableListener] Failed to listen ${eventName}:`, error);
      });
    });

    return () => {
      cancelled = true;
      activeRef.current = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, deps);
}
