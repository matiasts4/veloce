"use client";

import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BrandMark } from "@/components/veloce/brand-mark";

interface StartupOverlayProps {
  message?: string;
}

export function StartupOverlay({ message }: StartupOverlayProps) {
  const { t } = useTranslation();

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center gap-6"
      >
        <div className="relative flex items-center justify-center">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            className="absolute h-24 w-24 rounded-full border-b-2 border-t-2 border-primary/20"
          />
          <motion.div
            animate={{ rotate: -360 }}
            transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
            className="absolute h-16 w-16 rounded-full border-b-2 border-t-2 border-primary/40"
          />
          <BrandMark className="h-8 w-8 text-primary" />
        </div>

        <div className="flex flex-col items-center gap-2">
          <h2 className="font-mono text-sm font-medium uppercase tracking-widest text-foreground">
            Veloce
          </h2>
          <motion.p
            key={message}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-xs text-muted-foreground"
          >
            {message || t("boot.initializing")}
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
