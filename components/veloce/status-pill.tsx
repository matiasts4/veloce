"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";

type Status = "idle" | "listening" | "processing" | "transcribing";
type UiLanguage = "es" | "en";

interface StatusPillProps {
  status: Status;
  uiLanguage?: UiLanguage;
}

const statusConfig: Record<
  Status,
  { dotClass: string; pillClass: string }
> = {
  idle: {
    dotClass: "bg-muted-foreground",
    pillClass: "border-border text-muted-foreground",
  },
  listening: {
    dotClass: "bg-primary",
    pillClass: "border-primary/30 text-primary",
  },
  processing: {
    dotClass: "bg-amber-400",
    pillClass: "border-amber-400/30 text-amber-400",
  },
  transcribing: {
    dotClass: "bg-cyan-400",
    pillClass: "border-cyan-400/30 text-cyan-300",
  },
};

export function StatusPill({ status, uiLanguage = "es" }: StatusPillProps) {
  const { t } = useTranslation();

  const config = {
    ...statusConfig[status],
    label: t(`status.${status}`),
  };

  return (
    <div className="flex items-center justify-center pb-5 pt-2">
      <motion.div
        layout
        className={`flex items-center gap-2 rounded-full border px-4 py-1.5 font-mono text-xs ${config.pillClass}`}
      >
        <span className="relative flex h-2 w-2">
          {status === "listening" && (
            <motion.span
              className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"
              animate={{ scale: [1, 1.8], opacity: [0.75, 0] }}
              transition={{ duration: 1, repeat: Infinity, ease: "easeOut" }}
            />
          )}
          {status === "transcribing" && (
            <motion.span
              className="absolute inline-flex h-full w-full rounded-full bg-cyan-300 opacity-70"
              animate={{ scale: [1, 1.9], opacity: [0.7, 0] }}
              transition={{ duration: 0.8, repeat: Infinity, ease: "easeOut" }}
            />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${config.dotClass}`} />
        </span>
        <AnimatePresence mode="wait">
          <motion.span
            key={status}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            {config.label}
          </motion.span>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
