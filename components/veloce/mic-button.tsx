"use client";

import { Mic } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface MicButtonProps {
  isActive: boolean;
  status?: "idle" | "listening" | "processing" | "transcribing";
  onToggle: () => void;
}

export function MicButton({ isActive, status = "idle", onToggle }: MicButtonProps) {
  const isTranscribing = status === "transcribing" || status === "processing";

  return (
    <div className="relative flex items-center justify-center py-10">
      {/* Outer pulse rings - only when active */}
      <AnimatePresence>
        {(isActive || isTranscribing) && (
          <>
            <motion.div
              className={`absolute h-36 w-36 rounded-full border ${isTranscribing ? "border-cyan-300/20" : "border-primary/20"}`}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: [0.8, 1.3], opacity: [0.4, 0] }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeOut",
              }}
            />
            <motion.div
              className={`absolute h-36 w-36 rounded-full border ${isTranscribing ? "border-cyan-300/15" : "border-primary/15"}`}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: [0.8, 1.5], opacity: [0.3, 0] }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeOut",
                delay: 0.5,
              }}
            />
            <motion.div
              className={`absolute h-36 w-36 rounded-full border ${isTranscribing ? "border-cyan-300/10" : "border-primary/10"}`}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: [0.8, 1.7], opacity: [0.2, 0] }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeOut",
                delay: 1,
              }}
            />
          </>
        )}
      </AnimatePresence>

      {/* Glow background */}
      <motion.div
        className="absolute h-28 w-28 rounded-full"
        animate={{
          boxShadow: isActive
            ? [
                "0 0 20px 0px hsl(199 89% 48% / 0.15)",
                "0 0 40px 8px hsl(199 89% 48% / 0.25)",
                "0 0 20px 0px hsl(199 89% 48% / 0.15)",
              ]
            : isTranscribing
              ? [
                  "0 0 18px 0px hsl(188 94% 43% / 0.16)",
                  "0 0 34px 7px hsl(188 94% 43% / 0.22)",
                  "0 0 18px 0px hsl(188 94% 43% / 0.16)",
                ]
            : "0 0 0px 0px hsl(199 89% 48% / 0)",
        }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />

      {/* Button */}
      <motion.button
        onClick={onToggle}
        className={`relative z-10 flex h-28 w-28 items-center justify-center rounded-full border-2 transition-colors ${
          isActive
            ? "border-primary/50 bg-primary/10 text-primary"
            : isTranscribing
              ? "border-cyan-300/45 bg-cyan-400/10 text-cyan-300"
            : "border-border bg-secondary text-muted-foreground hover:border-primary/30 hover:text-foreground"
        }`}
        whileTap={{ scale: 0.95 }}
        whileHover={{ scale: 1.03 }}
        aria-label={isActive ? "Stop listening" : "Start listening"}
        aria-pressed={isActive}
      >
        <motion.div
          animate={
            (isActive || isTranscribing)
              ? { scale: [1, 1.1, 1] }
              : { scale: 1 }
          }
          transition={{
            duration: 1.5,
            repeat: (isActive || isTranscribing) ? Infinity : 0,
            ease: "easeInOut",
          }}
        >
          <Mic className="h-10 w-10" />
        </motion.div>
      </motion.button>
    </div>
  );
}
