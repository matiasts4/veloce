"use client";

import { Settings, Minus, X } from "lucide-react";
import { BrandMark } from "@/components/veloce/brand-mark";

interface TitleBarProps {
  onOpenSettings: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
  onDragMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
}

export function TitleBar({ onOpenSettings, onMinimize, onClose, onDragMouseDown }: TitleBarProps) {
  return (
    <header className="flex items-center justify-between px-4 py-3" onMouseDown={onDragMouseDown}>
      <button
        onClick={onOpenSettings}
        className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        aria-label="Open settings"
      >
        <Settings className="h-4 w-4" />
      </button>

      <div
        data-tauri-drag-region
        className="flex h-8 flex-1 cursor-grab select-none items-center justify-center gap-2 text-center"
        aria-label="Drag area"
      >
        <BrandMark className="h-5 w-5" />
        <span className="font-mono text-xs font-medium tracking-widest uppercase text-muted-foreground">
          Veloce
        </span>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={onMinimize}
          className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
