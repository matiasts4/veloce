"use client";

import { useEffect, useState } from "react";
import { Settings, Minus, X, Library, HardDrive, Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import { BrandMark } from "@/components/veloce/brand-mark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface TitleBarProps {
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  onOpenModels?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
  onDragMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
}

export function TitleBar({ onOpenSettings, onOpenLibrary, onOpenModels, onMinimize, onClose, onDragMouseDown }: TitleBarProps) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const themes = [
    { id: "system", label: "Auto", color: "bg-slate-400" },
    { id: "light", label: "Light", color: "bg-[#f5f5f5] border border-slate-200" },
    { id: "dark", label: "Midnight", color: "bg-[#020817] border border-slate-800" },
    { id: "dracula", label: "Dracula", color: "bg-[#282a36] border border-purple-500/30" },
    { id: "forest", label: "Forest", color: "bg-[#052e16] border border-emerald-500/30" },
    { id: "veloce", label: "Veloce Web", color: "bg-[#0d041c] border border-violet-500/50" },
  ];

  return (
    <header className="relative flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-1 z-10">
        <button
          onClick={onOpenSettings}
          className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label={t("settings.title")}
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          onClick={onOpenLibrary}
          className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label={t("library.title")}
        >
          <Library className="h-4 w-4" />
        </button>
        {onOpenModels && (
          <button
            onClick={onOpenModels}
            className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={t("models.title", "Models")}
          >
            <HardDrive className="h-4 w-4" />
          </button>
        )}
        {mounted && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary data-[state=open]:text-foreground"
                aria-label="Change Theme"
              >
                <Palette className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-36">
              {themes.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  onSelect={(e) => {
                    e.preventDefault();
                    setTheme(t.id);
                  }}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <div className={`h-3 w-3 rounded-full ${t.color}`} />
                  <span className={`text-xs ${theme === t.id ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                    {t.label}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div
        data-tauri-drag-region
        className="absolute inset-0 flex cursor-grab select-none items-center justify-center gap-2 pointer-events-auto z-0"
        aria-label="Drag area"
      >
        <BrandMark className="h-5 w-5 pointer-events-none" />
        <span className="font-mono text-xs font-medium tracking-widest uppercase text-muted-foreground pointer-events-none">
          Veloce
        </span>
      </div>

      <div className="flex items-center gap-1 z-10">
        <button
          onClick={onMinimize}
          className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground relative z-10"
          aria-label={t("main.minimize_to_mini_widget")}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive hover:text-foreground"
          aria-label={t("main.close_window")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
