"use client";

import "@/lib/i18n"; // Initialize i18n
import { useState, useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { safeInvoke } from "@/lib/tauri-client";
import { AnimatePresence, motion } from "framer-motion";
import { AudioLines, Check, Mic, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TitleBar } from "@/components/veloce/title-bar";
import { MicButton } from "@/components/veloce/mic-button";
import { StatusPill } from "@/components/veloce/status-pill";
import { SettingsPage } from "@/components/veloce/settings-page";
import { VUMeter } from "@/components/VUMeter";
import { LibraryView } from "@/components/veloce/library-view";
import { ModelsManager } from "@/components/veloce/models-manager";
import { StartupOverlay } from "@/components/veloce/startup-overlay"; // Import Overlay
import { MiniVUBars } from "@/components/veloce/mini-vu-bars";
import { saveTranscription } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  type HotkeyCombo,
  useHotkey,
} from "@/hooks/use-hotkey";

type Status = "idle" | "listening" | "processing" | "transcribing";
type UiLanguage = "es" | "en";
type BackendId = "auto" | "faster-whisper" | "whispercpp";
type CaptureMode = "toggle" | "hold";
type CaptureShortcutType = "single" | "combo";
type AutoPasteMode = "ctrl_v" | "ctrl_shift_v" | "type_text";
type ExpandedViewSize = "compact" | "large";
type ModelDownloadStatus = "idle" | "starting" | "downloading" | "completed" | "error";
type ModelDownloadState = {
  progress: number;
  status: ModelDownloadStatus;
  loaded?: number;
  total?: number;
  unit?: string;
};
type View = "recorder" | "library" | "models" | "settings";

const SETTINGS_KEY = "veloce:settings:v1";
const ONBOARDING_DONE_KEY = "veloce:onboarding:done:v1";
const DEFAULT_AUTO_PASTE_MODE: AutoPasteMode = typeof navigator !== "undefined" && /linux/i.test(navigator.userAgent)
  ? "ctrl_shift_v"
  : "ctrl_v";
const NORMAL_WIDTH = 500;
const NORMAL_HEIGHT = 620;
const LARGE_WIDTH = 700;
const LARGE_HEIGHT = 640;
const MINI_WIDTH = 224;
const MINI_HEIGHT = 68;
// Minimum time to show the loading screen to mask backend instability (ms)
const MIN_BOOT_TIME_MS = 3500;

const DEFAULT_TOGGLE_WIDGET: HotkeyCombo = {
  key: "v",
  ctrlKey: true,
  shiftKey: false,
  altKey: true,
  metaKey: false,
};

const DEFAULT_TOGGLE_CAPTURE: HotkeyCombo = {
  key: " ",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
};

function inferShortcutType(combo: HotkeyCombo | null): CaptureShortcutType {
  if (!combo) return "single";
  return combo.ctrlKey || combo.shiftKey || combo.altKey || combo.metaKey ? "combo" : "single";
}

function mergeTranscriptText(currentText: string, incomingText: string): string {
  const current = currentText.trim();
  const incoming = incomingText.trim();

  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  if (current.endsWith(incoming)) return current;

  const currentLower = current.toLowerCase();
  const incomingLower = incoming.toLowerCase();
  const maxOverlap = Math.min(currentLower.length, incomingLower.length);
  let overlap = 0;

  for (let size = maxOverlap; size > 0; size -= 1) {
    if (currentLower.endsWith(incomingLower.slice(0, size))) {
      overlap = size;
      break;
    }
  }

  if (overlap > 0) {
    return `${current}${incoming.slice(overlap)}`.trim();
  }

  return `${current} ${incoming}`.trim();
}

export default function VelocePage() {
  const { t, i18n } = useTranslation();
  const [isVisible, setIsVisible] = useState(true);
  const [showMiniWidget, setShowMiniWidget] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [view, setView] = useState<View>("recorder");

  // Booting state
  const [isBooting, setIsBooting] = useState(true);
  const [bootMessage, setBootMessage] = useState("");
  const bootMinTimePassedRef = useRef(false);
  const hasValidHardwareRef = useRef(false);
  const [isBackendReady, setIsBackendReady] = useState(false);

  // Whether a keybind recorder is currently capturing keys
  const [isRecording, setIsRecording] = useState(false);

  // Settings state
  const [microphone, setMicrophone] = useState("default");
  // Tracks the user's desired mic (persisted preference) so hardware-info events can reconcile
  const desiredMicrophoneRef = useRef("default");
  const [model, setModel] = useState("large-v3-turbo");
  const [modelDir, setModelDir] = useState("");
  const [defaultModelDir, setDefaultModelDir] = useState("");
  const [modelDirOptions, setModelDirOptions] = useState<string[]>([]);
  const [language, setLanguage] = useState("es");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("toggle");
  const [captureShortcutType, setCaptureShortcutType] = useState<CaptureShortcutType>("single");
  const [backend, setBackend] = useState<BackendId>("auto");
  const [activeBackend, setActiveBackend] = useState<BackendId | "none">("none");
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("es");
  const [expandedViewSize, setExpandedViewSize] = useState<ExpandedViewSize>("large");
  const [startWithWindows, setStartWithWindows] = useState(false);
  const [closeToMiniWidget, setCloseToMiniWidget] = useState(true);
  const [showFloatingWidget, setShowFloatingWidget] = useState(true);
  const [showTrayIcon, setShowTrayIcon] = useState(true);
  const lastTrayLevelRef = useRef(0);
  const [gpuEnabled, setGpuEnabled] = useState(false);
  const [availableMics, setAvailableMics] = useState<{ id: number | string; name: string }[]>([]);
  const [downloadedModels, setDownloadedModels] = useState<{ id: string; name: string; downloaded?: boolean }[]>([]);
  const [modelDownloads, setModelDownloads] = useState<Record<string, ModelDownloadState>>({});
  const [activeModelDownload, setActiveModelDownload] = useState<string | null>(null);
  const activeModelDownloadRef = useRef<string | null>(null);
  const [gpuInfo, setGpuInfo] = useState<{ available: boolean; name: string; reason?: string }>({ available: false, name: "None", reason: "" });
  const [availableBackends, setAvailableBackends] = useState<{ id: BackendId; available: boolean; reason?: string }[]>([
    { id: "auto", available: true, reason: "" },
    { id: "faster-whisper", available: true, reason: "" },
    { id: "whispercpp", available: false, reason: "" },
  ]);
  const [clipboardMode, setClipboardMode] = useState(false);
  const [clipboardAutoPaste, setClipboardAutoPaste] = useState(false);
  const [autoPasteMode, setAutoPasteMode] = useState<AutoPasteMode>(DEFAULT_AUTO_PASTE_MODE);
  const [showResponseTimes, setShowResponseTimes] = useState(true);
  const [latestTranscript, setLatestTranscript] = useState("");
  const [lastResponseMs, setLastResponseMs] = useState<number | null>(null);
  const [showMiniDoneTick, setShowMiniDoneTick] = useState(false);
  const [engineError, setEngineError] = useState("");
  const [engineLog, setEngineLog] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const miniIsListening = isActive && status === "listening";
  const activeRecordingIdRef = useRef<number | null>(null);
  const committedTranscriptRef = useRef("");
  const sessionTranscriptRef = useRef(""); // All finals accumulated for the full session
  const sessionSavedRef = useRef(false);
  const clipboardModeRef = useRef(clipboardMode);
  const clipboardAutoPasteRef = useRef(clipboardAutoPaste);
  const autoPasteModeRef = useRef<AutoPasteMode>(autoPasteMode);

  useEffect(() => {
    clipboardModeRef.current = clipboardMode;
    clipboardAutoPasteRef.current = clipboardAutoPaste;
    autoPasteModeRef.current = autoPasteMode;
  }, [clipboardMode, clipboardAutoPaste, autoPasteMode]);

  // Update tray icon based on recording state — reset when recording stops
  useEffect(() => {
    if (!showTrayIcon) return;
    const isRecording = status === "listening" || status === "transcribing";
    if (!isRecording) {
      lastTrayLevelRef.current = -1; // force reset so next recording start re-draws level 0
      import("@/lib/tauri-client").then(({ safeInvoke }) => {
        safeInvoke("update_tray_icon", { recording: false }).catch(console.error);
      });
    }
  }, [status, showTrayIcon]);

  // Handle dynamic tray icon updates from VU meter (stable listener — no re-register on level change)
  useEffect(() => {
    if (!showTrayIcon || (status !== "listening" && status !== "transcribing")) return;

    let unlisten: () => void;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<any>("vu-update", (event) => {
        const rms = event.payload.rms;

        // Same log scale as mini-vu-bars.tsx
        let normalized = Math.log10(rms + 1) / 4.2;
        normalized = (normalized - 0.3) / 0.7;
        normalized = Math.max(0, Math.min(1, normalized));

        // 5 levels: 0 = minimal bars, 4 = full bars
        let level = 0;
        if (normalized > 0.75) level = 4;
        else if (normalized > 0.5) level = 3;
        else if (normalized > 0.25) level = 2;
        else if (normalized > 0.05) level = 1;

        // Only update icon when level actually changes (avoids IPC spam)
        if (level !== lastTrayLevelRef.current) {
          lastTrayLevelRef.current = level;
          const volumes = [0, 100, 500, 1000, 2000];
          import("@/lib/tauri-client").then(({ safeInvoke }) => {
            safeInvoke("update_tray_icon", { recording: true, volume: volumes[level] }).catch(console.error);
          });
        }
      }).then(u => { unlisten = u; });
    });

    return () => { if (unlisten) unlisten(); };
  }, [showTrayIcon, status]);

  // Sync Tray Icon presence with backend
  useEffect(() => {
    import("@/lib/tauri-client").then(({ safeInvoke }) => {
      safeInvoke("set_tray_visible", { visible: showTrayIcon }).catch(console.error);
    });
  }, [showTrayIcon]);

  // Sync language with i18n
  useEffect(() => {
    if (i18n.language !== uiLanguage) {
      i18n.changeLanguage(uiLanguage);
    }
  }, [uiLanguage, i18n]);

  // Boot sequence logic
  useEffect(() => {
    // 1. Initial wait
    const minTimer = setTimeout(() => {
      bootMinTimePassedRef.current = true;
      // If hardware was already ready and backend is ready, finish boot now
      if (hasValidHardwareRef.current && isBackendReady) {
        setIsBooting(false);
      }
    }, MIN_BOOT_TIME_MS);

    // 2. Safety timeout (force boot finish after 20s if nothing happens)
    const safetyTimer = setTimeout(() => {
      setIsBooting(false);
    }, 20000);

    return () => {
      clearTimeout(minTimer);
      clearTimeout(safetyTimer);
    };
  }, []);

  // Update boot message periodically
  useEffect(() => {
    if (!isBooting) return;

    const messages = [
      "boot.initializing",
      "boot.checking_hardware",
      "boot.loading_models",
      "boot.loading_ai_model", // Added for clarity
      "boot.almost_ready"
    ];
    let index = 0;

    const interval = setInterval(() => {
      index = (index + 1) % messages.length;
      setBootMessage(messages[index]);
    }, 2500);

    return () => clearInterval(interval);
  }, [isBooting]);

  // Auto-save logic
  useEffect(() => {
    if (status === "listening" || status === "transcribing") {
      sessionSavedRef.current = false;
    } else if (status === "idle" && !sessionSavedRef.current && latestTranscript.trim()) {
      saveTranscription(latestTranscript, lastResponseMs ?? undefined).catch(console.error);
      sessionSavedRef.current = true;
    }
  }, [status, latestTranscript, lastResponseMs]);

  // Hotkey combos
  const [toggleWidgetCombo, setToggleWidgetCombo] =
    useState<HotkeyCombo | null>(DEFAULT_TOGGLE_WIDGET);
  const [toggleCaptureCombo, setToggleCaptureCombo] =
    useState<HotkeyCombo | null>(DEFAULT_TOGGLE_CAPTURE);

  const getExpandedWindowSize = useCallback(
    () =>
      expandedViewSize === "large"
        ? { width: LARGE_WIDTH, height: LARGE_HEIGHT }
        : { width: NORMAL_WIDTH, height: NORMAL_HEIGHT },
    [expandedViewSize]
  );

  const dockMiniWidgetWindow = useCallback(async () => {
    const [{ getCurrentWindow, currentMonitor }, { LogicalPosition, LogicalSize }] = await Promise.all([
      import("@tauri-apps/api/window"),
      import("@tauri-apps/api/dpi"),
    ]);

    const window = getCurrentWindow();
    await window.setAlwaysOnTop(true);
    await window.setResizable(false);
    await window.setMaximizable(false);
    await window.setSkipTaskbar(true);
    await window.show();
    await window.setSize(new LogicalSize(MINI_WIDTH, MINI_HEIGHT));

    const monitor = await currentMonitor();
    if (monitor) {
      const margin = 12;
      const x = monitor.position.x + monitor.size.width - MINI_WIDTH - margin;
      const y = monitor.position.y + monitor.size.height - MINI_HEIGHT - margin;
      await window.setPosition(new LogicalPosition(x, y));
    }
  }, []);

  // Toggle widget between normal and mini mode
  const handleToggleVisibility = useCallback(() => {
    if (isVisible) {
      setIsVisible(false);
      setShowMiniWidget(showFloatingWidget);

      import("@/lib/tauri-client").then(({ isTauri }) => {
        if (!isTauri()) return;

        Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
          .then(async ([windowApi, dpiApi]) => {
            const { getCurrentWindow } = windowApi;
            const window = getCurrentWindow();
            if (!showFloatingWidget) {
              await window.setSkipTaskbar(true);
              setTimeout(async () => {
                await window.hide();
              }, 50);
            } else {
              setTimeout(async () => {
                await dockMiniWidgetWindow();
              }, 50);
            }
          })
          .catch((error) => console.error("Failed to minimize from hotkey", error));
      });
      return;
    }

    setIsVisible(true);
    setShowMiniWidget(false);

    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri()) return;

      Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
        .then(async ([windowApi, dpiApi]) => {
          const { getCurrentWindow } = windowApi;
          const { LogicalSize } = dpiApi;
          const window = getCurrentWindow();
          const target = getExpandedWindowSize();
          await window.setSkipTaskbar(false);
          await window.show();
          await window.setAlwaysOnTop(true);
          await window.setSize(new LogicalSize(target.width, target.height));
          await window.unminimize();
          await window.setFocus();
        })
        .catch((error) => console.error("Failed to restore from hotkey", error));
    });
  }, [dockMiniWidgetWindow, getExpandedWindowSize, isVisible, showFloatingWidget]);

  const handleMinimizeToMiniWidget = useCallback(() => {
    setIsVisible(false);
    setShowMiniWidget(showFloatingWidget);

    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri()) return;

      Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
        .then(async ([windowApi, dpiApi]) => {
          const { getCurrentWindow } = windowApi;
          const window = getCurrentWindow();
          if (!showFloatingWidget) {
            await window.setSkipTaskbar(true);
            setTimeout(async () => {
              await window.hide();
            }, 50);
          } else {
            setTimeout(async () => {
              await dockMiniWidgetWindow();
            }, 50);
          }
        })
        .catch((error) => console.error("Failed to minimize to mini widget", error));
    });
  }, [dockMiniWidgetWindow, showFloatingWidget]);

  const handleRestoreFromMiniWidget = useCallback(() => {
    setIsVisible(true);
    setShowMiniWidget(false);

    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri()) return;

      Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
        .then(async ([windowApi, dpiApi]) => {
          const { getCurrentWindow } = windowApi;
          const { LogicalSize } = dpiApi;
          const window = getCurrentWindow();
          const target = getExpandedWindowSize();
          await window.setSkipTaskbar(false);
          await window.show();
          await window.setAlwaysOnTop(true);
          await window.setResizable(true);
          await window.setMaximizable(true);
          await window.setSize(new LogicalSize(target.width, target.height));
          await window.unminimize();
          await window.setFocus();
        })
        .catch((error) => console.error("Failed to restore window", error));
    });
  }, [getExpandedWindowSize]);

  const handleCloseWindow = useCallback(async () => {
    if (closeToMiniWidget) {
      handleMinimizeToMiniWidget();
      return;
    }

    import("@/lib/tauri-client").then(async ({ isTauri }) => {
      if (!isTauri()) return;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch (error) {
        console.error("Failed to close window", error);
      }
    });
  }, [closeToMiniWidget, handleMinimizeToMiniWidget]);

  const handleStartWindowDrag = useCallback(async (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,a,input,select,textarea,[role='button']")) {
      return;
    }

    import("@/lib/tauri-client").then(async ({ isTauri }) => {
      if (!isTauri()) return;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().startDragging();
      } catch (error) {
        console.error("Failed to start dragging", error);
      }
    });
  }, []);

  // Toggle capture
  const handleToggleCapture = useCallback(async () => {
    try {
      const recording = await safeInvoke<boolean>("toggle_recording");
      if (typeof recording === "boolean" && recording) {
        activeRecordingIdRef.current = null;
        committedTranscriptRef.current = "";
        sessionTranscriptRef.current = "";
        setLatestTranscript("");
        setLastResponseMs(null);
        setIsActive(recording);
        setStatus("listening");
      } else if (typeof recording === "boolean") {
        setIsActive(recording);
        // Do not force "idle" here. Let the backend "stopped" event drive the final status
        // so the user sees "Processing..." while the queue drains.
      }
    } catch (error) {
      console.error("Failed to toggle recording", error);
      setEngineError(t("main.start_stop_recording_error"));
    }
  }, [t]);

  // Listen for the Wayland global stealth HTTP listener
  useEffect(() => {
    let unlistenGlobalToggle: () => void;
    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri()) return;
      import("@tauri-apps/api/event").then(async ({ listen }) => {
        unlistenGlobalToggle = await listen("global-toggle-capture", () => {
          handleToggleCapture();
        });
      });
    });
    return () => {
      if (unlistenGlobalToggle) unlistenGlobalToggle();
    };
  }, [handleToggleCapture]);

  // Register global hotkeys (disabled while recording a new keybind)
  useHotkey(toggleWidgetCombo, handleToggleVisibility, !isRecording);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;

    if (showMiniWidget) {
      html.classList.add("mini-widget-mode");
      body.classList.add("mini-widget-mode");
    } else {
      html.classList.remove("mini-widget-mode");
      body.classList.remove("mini-widget-mode");
    }

    return () => {
      html.classList.remove("mini-widget-mode");
      body.classList.remove("mini-widget-mode");
    };
  }, [showMiniWidget]);

  useEffect(() => {
    const handleResize = () => {
      if (showMiniWidget && window.innerWidth > MINI_WIDTH + 50) {
        handleRestoreFromMiniWidget();
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [showMiniWidget, handleRestoreFromMiniWidget]);

  // Listen to Tauri events
  useEffect(() => {
    activeModelDownloadRef.current = activeModelDownload;
  }, [activeModelDownload]);

  useEffect(() => {
    let unlistenStatus: () => void;
    let unlistenRecording: () => void;
    let unlistenHardware: () => void;
    let unlistenTranscription: () => void;
    let unlistenError: () => void;
    let unlistenLog: () => void;
    let unlistenModelDownload: () => void;
    let unlistenUnminimize: () => void;
    let unlistenShowWindow: () => void;

    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri()) return;

      import("@tauri-apps/api/event").then(async ({ listen }) => {
        unlistenUnminimize = await listen("tauri://unminimize", () => {
          handleRestoreFromMiniWidget();
        });

        // Fired when the tray "Mostrar Veloce" is clicked while the window is hidden
        unlistenShowWindow = await listen("show-window", () => {
          handleRestoreFromMiniWidget();
        });

        unlistenStatus = await listen<string>("status-update", (event) => {
          console.log("Status update:", event.payload);
          // Map backend status to UI status
          // Backend: "recording", "stopped", "loading_model", "ready"
          if (event.payload === "recording") {
            setStatus("listening");
            setIsActive(true);
          } else if (event.payload === "speech_start") {
            setStatus("listening");
            setIsActive(true);
          } else if (event.payload === "transcribing_final") {
            setStatus("transcribing");
            setIsActive(true);
          } else if (event.payload === "stopped") {
            // Note: with the async queue, "stopped" only arrives when all background transcriptions
            // are thoroughly flushed. Therefore, we can confidently reset to idle without cutting off text.
            const fullText = sessionTranscriptRef.current.trim();
            if (fullText && clipboardModeRef.current) {
              if (clipboardAutoPasteRef.current) {
                import("@/lib/tauri-client").then(({ safeInvoke }) => {
                  if (autoPasteModeRef.current === "type_text") {
                    safeInvoke("type_text", { text: fullText })
                      .catch(console.error);
                    return;
                  }

                  safeInvoke("set_clipboard", { text: fullText })
                    .then(() => safeInvoke("press_paste_shortcut", { autoPasteMode: autoPasteModeRef.current }))
                    .catch(console.error);
                });
              } else {
                import("@/lib/tauri-client").then(({ safeInvoke }) => {
                  safeInvoke("set_clipboard", { text: fullText });
                });
              }
            }

            setStatus("idle");
            setIsActive(false);
          } else if (event.payload === "transcribing") {
            // Keep current active state: during segmented live capture backend can
            // briefly switch to transcribing and back to recording. We don't want to
            // flicker the UI, so we ignore 'transcribing' and only act on 'transcribing_final'
          } else if (event.payload === "loading_model") {
            setStatus("processing"); // Reusing processing state for loading
            setIsActive(false);
          } else if (event.payload === "ready") {
            setStatus("idle");
            setIsActive(false);
            setEngineError(""); // Clear any initialization logs/errors
            setIsBackendReady(true);
            if (bootMinTimePassedRef.current && hasValidHardwareRef.current) {
              setIsBooting(false);
            }
          }
        });

        unlistenRecording = await listen<boolean>("recording-state", (event) => {
          const isRecording = event.payload;
          if (isRecording) {
            activeRecordingIdRef.current = null;
            committedTranscriptRef.current = "";
            sessionTranscriptRef.current = "";
            setLatestTranscript("");
            setLastResponseMs(null);
            setEngineError(""); // Clear error on start
            setIsActive(true);
            setStatus("listening");
          } else {
            // Wait for "stopped" status-update from backend to revert UI cleanly.
            // Just update the internal `isActive` flag so buttons feel responsive, but 
            // leave status alone to let "Transcribing..." or "Processing..." finish gracefully.
            setIsActive(false);
          }
        });

        // Listen for hardware info
        unlistenHardware = await listen<any>("hardware-info", (event) => {
          console.log("Hardware Info:", event.payload);
          // If we got hardware info, the engine is likely healthy, clear errors
          setEngineError("");

          const whispercppAvailable = Array.isArray(event.payload?.backends?.available)
            ? event.payload.backends.available.some((item: any) => item?.id === "whispercpp" && item?.available === true)
            : false;

          if (Array.isArray(event.payload.microphones)) {
            const mics: { id: number | string; name: string }[] = event.payload.microphones;
            setAvailableMics(mics);

            // Reconcile selection: try to restore the desired mic, fall back to default
            setMicrophone((current) => {
              const desired = desiredMicrophoneRef.current;
              const ids = mics.map((m) => m.id.toString());

              if (desired !== "default" && ids.includes(desired)) {
                return desired;
              }
              if (current !== "default" && ids.includes(current)) {
                return current;
              }
              return "default";
            });

            // Mark hardware as valid if we have microphones
            if (mics.length > 0) {
              hasValidHardwareRef.current = true;
              hasValidHardwareRef.current = true;
              if (bootMinTimePassedRef.current && isBackendReady) {
                setIsBooting(false);
              }
            }
          }
          if (Array.isArray(event.payload.models)) {
            setDownloadedModels(event.payload.models);
            setModelDownloads((previous) => {
              let hasChanges = false;
              const next = { ...previous };
              for (const item of event.payload.models) {
                if (!item || typeof item.id !== "string") continue;
                if (item.downloaded === true) {
                  const current = next[item.id];
                  if (!current || current.status !== "completed" || current.progress !== 100) {
                    next[item.id] = { status: "completed", progress: 100 };
                    hasChanges = true;
                  }
                }
              }
              return hasChanges ? next : previous;
            });
            const currentActiveDownload = activeModelDownloadRef.current;
            if (currentActiveDownload) {
              const done = event.payload.models.some((item: { id?: string; downloaded?: boolean }) => item.id === currentActiveDownload && item.downloaded === true);
              if (done) {
                setActiveModelDownload(null);
              }
            }
          }
          if (Array.isArray(event.payload.model_dirs)) {
            const options = event.payload.model_dirs
              .filter((item: unknown) => typeof item === "string")
              .map((item: string) => item.trim())
              .filter((item: string) => item.length > 0);
            setModelDirOptions(options);

            const fallbackDir = typeof event.payload.default_model_dir === "string" ? event.payload.default_model_dir.trim() : "";
            setDefaultModelDir(fallbackDir);

            if (!modelDir && fallbackDir.length > 0 && options.includes(fallbackDir)) {
              setModelDir(fallbackDir);
            }
          }
          if (event.payload.gpu) {
            setGpuInfo(event.payload.gpu);
            // Auto-enable GPU if available
            if (event.payload.gpu.available) {
              setGpuEnabled(true);
            } else if (!whispercppAvailable) {
              setGpuEnabled(false);
            }
          }
          if (event.payload.backends && Array.isArray(event.payload.backends.available)) {
            const normalized = event.payload.backends.available
              .filter((item: any) => item && typeof item.id === "string")
              .map((item: any) => ({
                id: item.id as BackendId,
                available: Boolean(item.available),
                reason: typeof item.reason === "string" ? item.reason : "",
              }));
            if (normalized.length > 0) {
              setAvailableBackends(normalized);
            }

            if (typeof event.payload.backends.requested === "string") {
              const requested = event.payload.backends.requested as BackendId;
              if (["auto", "faster-whisper", "whispercpp"].includes(requested)) {
                setBackend(requested);
              }
            }

            if (typeof event.payload.backends.active === "string") {
              const active = event.payload.backends.active as BackendId | "none";
              if (["auto", "faster-whisper", "whispercpp", "none"].includes(active)) {
                setActiveBackend(active);
              }
            }
          }
        });

        unlistenTranscription = await listen<{ text?: string; is_final?: boolean; response_ms?: number; recording_id?: number } | string>("transcription-update", (event) => {
          console.log("[FRONTEND] Transcription update:", event.payload); // Debug Log
          const payload = event.payload;
          const text = typeof payload === "string" ? payload : (payload?.text ?? "");
          const isFinal = typeof payload === "string" ? false : payload?.is_final === true;
          const responseMs = typeof payload === "string" ? null : payload?.response_ms;
          const recordingId = typeof payload === "string" ? null : (typeof payload?.recording_id === "number" ? payload.recording_id : null);

          // Backend sends cumulative session text directly - just display it
          setLatestTranscript((_previous) => {
            const chunk = text.trim();
            if (!chunk) return _previous;
            return chunk;
          });

          // Continuously save the cumulative text to the ref so we can safely paste it all when recording STOPS
          if (text.trim()) {
            sessionTranscriptRef.current = text.trim();
          }

          // Output actions: type/clipboard only for final segments, using phrase_text (just the new phrase)
          // Removed per-segment auto-pasting logic to prevent double pasting and "intelligent" pasting.
          // Auto-pasting is now handled exactly once when the user manually stops the session (status: "stopped").
          if (typeof responseMs === "number") {
            setLastResponseMs(Math.max(0, Math.round(responseMs)));
          }
          setShowMiniDoneTick(true);
          window.setTimeout(() => setShowMiniDoneTick(false), 1200);
          setEngineError("");
        });

        const ignoredTechnicalMessages = [
          "compute buffer",
          "whisper_init_state",
          "init: ",
          "system_info:",
          "AVX",
          "BLAS",
          "decimal model",
          "size_t",
          "kv self size",
          "max_nodes",
          "model size",
          "whisper-server", // Filter specifically requested
        ];

        unlistenError = await listen<string>("engine-error", (event) => {
          const message = event.payload ?? "";

          if (message.includes("Audio engine executable/script not found")) {
            console.log("[FRONTEND] Engine missing. Triggering auto-install.");
            setBootMessage(t("boot.downloading_engine") || "Downloading Audio Engine...");

            import("@/lib/tauri-client").then(({ safeInvoke }) => {
              safeInvoke("install_audio_engine")
                .then(() => {
                  console.log("[FRONTEND] Engine installed.");
                  setBootMessage(t("boot.initializing") || "Initializing...");
                  safeInvoke("refresh_hardware");
                })
                .catch((err) => {
                  console.error("[FRONTEND] Install failed:", err);
                  setEngineError(`Install failed: ${err}`);
                });
            });
            return;
          }

          if (ignoredTechnicalMessages.some(pattern => message.includes(pattern))) {
            console.log("Ignored technical error:", message);
            return;
          }

          if (message.includes("Model download failed (")) {
            const modelMatch = message.match(/Model download failed \(([^)]+)\):/);
            const failedModel = modelMatch?.[1] ?? activeModelDownloadRef.current;
            if (failedModel) {
              setModelDownloads((previous) => ({
                ...previous,
                [failedModel]: { status: "error", progress: 0 },
              }));
            }
            setActiveModelDownload(null);
          } else if (message.includes("Another model download is already in progress") && activeModelDownloadRef.current) {
            setModelDownloads((previous) => ({
              ...previous,
              [activeModelDownloadRef.current as string]: { status: "error", progress: 0 },
            }));
            setActiveModelDownload(null);
          }
          setEngineError(event.payload);
        });

        unlistenLog = await listen<string>("engine-log", (event) => {
          const message = event.payload ?? "";
          if (ignoredTechnicalMessages.some(pattern => message.includes(pattern))) {
            return;
          }
          setEngineLog(message);
        });

        unlistenModelDownload = await listen<{ model?: string; progress?: number; loaded?: number; total?: number; unit?: string }>("model-download-progress", (event) => {
          const modelId = typeof event.payload?.model === "string" ? event.payload.model : "";
          if (!modelId) return;

          const progress = Math.max(0, Math.min(100, Number(event.payload?.progress ?? 0)));
          const { loaded, total, unit } = event.payload || {};

          setModelDownloads((previous) => ({
            ...previous,
            [modelId]: {
              status: progress >= 100 ? "completed" : "downloading",
              progress,
              loaded,
              total,
              unit
            },
          }));

          if (progress >= 100) {
            setActiveModelDownload(null);
          }
        });

        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("refresh_hardware");
      }); // Close import event

    }); // Close isTauri check

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenRecording) unlistenRecording();
      if (unlistenHardware) unlistenHardware();
      if (unlistenTranscription) unlistenTranscription();
      if (unlistenError) unlistenError();
      if (unlistenLog) unlistenLog();
      if (unlistenModelDownload) unlistenModelDownload();
      if (unlistenUnminimize) unlistenUnminimize();
      if (unlistenShowWindow) unlistenShowWindow();
    };
  }, []);

  // Load settings - ONLY ONCE on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        console.log("Loading saved settings:", saved);
        
        if (typeof saved.microphone === "string") {
          setMicrophone(saved.microphone);
          desiredMicrophoneRef.current = saved.microphone;
        }
        if (typeof saved.model === "string") setModel(saved.model);
        if (typeof saved.modelDir === "string") setModelDir(saved.modelDir);
        if (saved.backend === "auto" || saved.backend === "faster-whisper" || saved.backend === "whispercpp") {
          setBackend(saved.backend);
        }
        if (saved.captureMode === "toggle" || saved.captureMode === "hold") {
          setCaptureMode(saved.captureMode);
        }
        if (saved.captureShortcutType === "single" || saved.captureShortcutType === "combo") {
          setCaptureShortcutType(saved.captureShortcutType);
        } else if (saved.toggleCaptureCombo) {
          setCaptureShortcutType(inferShortcutType(saved.toggleCaptureCombo as HotkeyCombo));
        }
        if (typeof saved.language === "string") setLanguage(saved.language);
        if (saved.uiLanguage === "es" || saved.uiLanguage === "en") setUiLanguage(saved.uiLanguage);
        if (typeof saved.expandedViewSize === "string") setExpandedViewSize(saved.expandedViewSize as ExpandedViewSize);
        if (typeof saved.startWithWindows === "boolean") setStartWithWindows(saved.startWithWindows);
        if (typeof saved.closeToMiniWidget === "boolean") setCloseToMiniWidget(saved.closeToMiniWidget);
        if (typeof saved.showFloatingWidget === "boolean") setShowFloatingWidget(saved.showFloatingWidget);
        if (typeof saved.showTrayIcon === "boolean") setShowTrayIcon(saved.showTrayIcon);
        if (typeof saved.gpuEnabled === "boolean") setGpuEnabled(saved.gpuEnabled);
        if (typeof saved.clipboardMode === "boolean") setClipboardMode(saved.clipboardMode);
        if (typeof saved.clipboardAutoPaste === "boolean") setClipboardAutoPaste(saved.clipboardAutoPaste);
        if (saved.autoPasteMode === "ctrl_v" || saved.autoPasteMode === "ctrl_shift_v" || saved.autoPasteMode === "type_text") {
          setAutoPasteMode(saved.autoPasteMode);
        }
        if (typeof saved.showResponseTimes === "boolean") setShowResponseTimes(saved.showResponseTimes);
        if (saved.toggleWidgetCombo === null || typeof saved.toggleWidgetCombo === "object") {
          setToggleWidgetCombo(saved.toggleWidgetCombo ?? DEFAULT_TOGGLE_WIDGET);
        }
        if (saved.toggleCaptureCombo === null || typeof saved.toggleCaptureCombo === "object") {
          setToggleCaptureCombo(saved.toggleCaptureCombo ?? DEFAULT_TOGGLE_CAPTURE);
        }
      }
    } catch (error) {
      console.error("Failed to load settings", error);
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        microphone,
        model,
        modelDir,
        backend,
        captureMode,
        captureShortcutType,
        language,
        uiLanguage,
        expandedViewSize,
        startWithWindows,
        gpuEnabled,
        clipboardMode,
        clipboardAutoPaste,
        autoPasteMode,
        showResponseTimes,
        closeToMiniWidget,
        showFloatingWidget,
        showTrayIcon,
        toggleWidgetCombo,
        toggleCaptureCombo,
      })
    );
  }, [
    settingsLoaded,
    microphone,
    model,
    modelDir,
    backend,
    captureMode,
    captureShortcutType,
    language,
    uiLanguage,
    expandedViewSize,
    startWithWindows,
    gpuEnabled,
    clipboardMode,
    clipboardAutoPaste,
    autoPasteMode,
    showResponseTimes,
    closeToMiniWidget,
    showFloatingWidget,
    showTrayIcon,
    toggleWidgetCombo,
    toggleCaptureCombo,
  ]);

  useEffect(() => {
    if (view !== "settings") return;

    safeInvoke("refresh_hardware")
      .catch((error) => console.error("Failed to refresh hardware", error));
  }, [view]);

  useEffect(() => {
    if (!downloadedModels.length) return;
    const modelAvailable = downloadedModels.some((item) => item.id === model && item.downloaded !== false);
    if (!modelAvailable) {
      const preferred = downloadedModels.find((item) => item.id === "large-v3-turbo" && item.downloaded !== false);
      if (preferred?.id) {
        setModel(preferred.id);
        return;
      }

      const firstAvailable = downloadedModels.find((item) => item.downloaded !== false);
      if (firstAvailable?.id) {
        setModel(firstAvailable.id);
      }
    }
  }, [downloadedModels, model]);

  useEffect(() => {
    if (!settingsLoaded) return;

    const onboardingDone = localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
    if (onboardingDone) {
      setOnboardingOpen(false);
      return;
    }

    const hasDownloadedModel = downloadedModels.some((item) => item.downloaded !== false);
    setOnboardingOpen(!hasDownloadedModel);
  }, [settingsLoaded, downloadedModels]);

  useEffect(() => {
    if (!settingsLoaded) return;

    const hasDownloadedModel = downloadedModels.some((item) => item.downloaded !== false);
    if (hasDownloadedModel) {
      localStorage.setItem(ONBOARDING_DONE_KEY, "1");
      setOnboardingOpen(false);
    }
  }, [settingsLoaded, downloadedModels]);

  const lastSentSettingsRef = useRef<string>("");

  useEffect(() => {
    if (!settingsLoaded) return;

    const currentSettings = JSON.stringify({
      microphone,
      model,
      modelDir,
      backend,
      language,
      gpuEnabled,
    });

    if (lastSentSettingsRef.current === currentSettings) {
      return;
    }

    lastSentSettingsRef.current = currentSettings;

    safeInvoke("set_engine_settings", {
      microphone,
      model,
      modelDir,
      backend,
      language,
      gpuEnabled,
    })
      .catch((error) => {
        console.error("Failed to update engine settings", error);
        setEngineError(t("main.engine_settings_update_failed"));
      });
  }, [settingsLoaded, microphone, model, modelDir, backend, language, gpuEnabled, t]);

  useEffect(() => {
    if (!settingsLoaded) return;

    safeInvoke("set_capture_mode", { mode: captureMode })
      .catch((error) => {
        console.error("Failed to update capture mode", error);
        setEngineError(t("main.capture_mode_update_failed"));
      });
  }, [settingsLoaded, captureMode, t]);

  useEffect(() => {
    if (!settingsLoaded || !toggleCaptureCombo) return;

    safeInvoke("set_capture_hotkey", { hotkey: toggleCaptureCombo })
      .catch((error) => {
        console.error("Failed to update capture hotkey", error);
        setEngineError(t("main.capture_hotkey_update_failed"));
      });
  }, [settingsLoaded, toggleCaptureCombo, t]);

  useEffect(() => {
    if (!settingsLoaded || !toggleCaptureCombo) return;
    setCaptureShortcutType(inferShortcutType(toggleCaptureCombo));
  }, [settingsLoaded, toggleCaptureCombo]);

  // If capture type is "single", normalize any existing combo to a single key.
  useEffect(() => {
    if (!settingsLoaded || captureShortcutType !== "single" || !toggleCaptureCombo) return;

    if (toggleCaptureCombo.ctrlKey || toggleCaptureCombo.shiftKey || toggleCaptureCombo.altKey || toggleCaptureCombo.metaKey) {
      setToggleCaptureCombo({
        key: toggleCaptureCombo.key,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      });
    }
  }, [captureShortcutType, settingsLoaded, toggleCaptureCombo]);

  useEffect(() => {
    if (!settingsLoaded) return;

    safeInvoke("set_clipboard_settings", {
      enabled: clipboardMode,
      autoPaste: clipboardAutoPaste,
      autoPasteMode,
    })
      .catch((error) => console.error("Failed to sync clipboard mode", error));
  }, [settingsLoaded, clipboardMode, clipboardAutoPaste, autoPasteMode]);

  useEffect(() => {
    if (!settingsLoaded) return;

    safeInvoke("set_startup_enabled", { enabled: startWithWindows })
      .catch((error) => console.error("Failed to sync startup setting", error));
  }, [settingsLoaded, startWithWindows]);

  useEffect(() => {
    safeInvoke<boolean>("get_startup_enabled")
      .then((enabled) => setStartWithWindows(Boolean(enabled)))
      .catch((error) => console.error("Failed to read startup setting", error));
  }, []);

  useEffect(() => {
    if (showMiniWidget || !isVisible) return;

    import("@/lib/tauri-client").then(({ isTauri }) => {
      if (!isTauri()) return;

      Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
        .then(async ([windowApi, dpiApi]) => {
          const { getCurrentWindow } = windowApi;
          const { LogicalSize } = dpiApi;
          const window = getCurrentWindow();
          const target = getExpandedWindowSize();
          await window.setSize(new LogicalSize(target.width, target.height));
        })
        .catch((error) => console.error("Failed to apply expanded view size", error));
    });
  }, [expandedViewSize, getExpandedWindowSize, isVisible, showMiniWidget]);

  const toggleGpu = (enabled: boolean) => {
    setGpuEnabled(enabled);
    // TODO: Send to backend if needed, currently Python detects auto
  };

  const toggleClipboard = async (enabled: boolean) => {
    setClipboardMode(enabled);
    if (!enabled) {
      setClipboardAutoPaste(false);
    }
  };

  const handleAutoPasteModeChange = (mode: AutoPasteMode) => {
    setAutoPasteMode(mode);
  };

  const handleRefreshHardware = useCallback(async () => {
    try {
      await safeInvoke("refresh_hardware");
      setEngineLog(t("main.hardware_refreshed"));
    } catch (error) {
      console.error("Failed to refresh hardware", error);
      setEngineError(t("main.hardware_refresh_failed"));
    }
  }, [t]);

  const handleDownloadModel = useCallback(
    async (modelId: string, downloadDir?: string) => {
      try {
        setEngineError("");
        setActiveModelDownload(modelId);
        setModelDownloads((previous) => ({
          ...previous,
          [modelId]: { status: "starting", progress: 0 },
        }));

        const dir = downloadDir || (modelDir !== "" ? modelDir : undefined);
        await safeInvoke("download_model", { model: modelId, download_dir: dir });
      } catch (error) {
        console.error("Failed to start model download", error);
        setModelDownloads((previous) => ({
          ...previous,
          [modelId]: { status: "error", progress: 0 },
        }));
        setActiveModelDownload(null);
        setEngineError(t("main.model_download_failed"));
      }
    },
    [t, modelDir]
  );

  const handleDeleteModel = useCallback(async (modelId: string, path?: string) => {
    try {
      await safeInvoke("delete_model", { model: modelId, path });
      setEngineLog(t("models.delete_started", { model: modelId }));
      // Optimistic update? No, wait for backend hardware refresh which usually happens after delete or we can trigger it.
      // The backend emits 'hardware-info' after delete anyway.
    } catch (error) {
      console.error("Failed to delete model", error);
      setEngineError(t("models.delete_failed"));
    }
  }, [t]);

  const isAnyModelDownloading = Object.values(modelDownloads).some(
    (item) => item.status === "starting" || item.status === "downloading"
  );

  const recommendedOnboardingModel = "large-v3-turbo";
  const onboardingProgress = modelDownloads[recommendedOnboardingModel]?.progress ?? 0;
  const onboardingStatus = modelDownloads[recommendedOnboardingModel]?.status ?? "idle";
  const onboardingBusy = onboardingStatus === "starting" || onboardingStatus === "downloading";

  const handleSaveSettings = useCallback(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          microphone,
          model,
          modelDir,
          backend,
          captureMode,
          captureShortcutType,
          language,
          uiLanguage,
          expandedViewSize,
          startWithWindows,
          gpuEnabled,
          clipboardMode,
          clipboardAutoPaste,
          autoPasteMode,
          showResponseTimes,
          closeToMiniWidget,
          showFloatingWidget,
          showTrayIcon,
          toggleWidgetCombo,
          toggleCaptureCombo,
        })
      );
      setEngineLog(t("main.settings_saved"));
    } catch (error) {
      console.error("Failed to save settings", error);
    }
    setView("recorder");
  }, [
    t,
    microphone, model,
    modelDir,
    backend,
    captureMode,
    captureShortcutType,
    language,
    uiLanguage,
    expandedViewSize,
    startWithWindows,
    gpuEnabled,
    clipboardMode,
    clipboardAutoPaste,
    autoPasteMode,
    showResponseTimes,
    closeToMiniWidget,
    showFloatingWidget,
    showTrayIcon,
    toggleWidgetCombo,
    toggleCaptureCombo,
  ]);

  return (
    <main
      className="h-full w-full overflow-hidden bg-transparent p-0"
      style={{ backgroundColor: "transparent" }}
    >
      <AnimatePresence>
        {isVisible ? (
          <motion.div
            key="widget"
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 20 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="relative h-full w-full overflow-hidden rounded-3xl border border-border/90 bg-card shadow-none"
          >
            {/* Subtle top accent line */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

            <AnimatePresence>
              {isBooting && (
                <motion.div
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5 }}
                  className="absolute inset-0 z-50"
                >
                  <StartupOverlay message={bootMessage ? t(bootMessage) : undefined} />
                </motion.div>
              )}
            </AnimatePresence>

            <TitleBar
              onOpenSettings={() => setView("settings")}
              onOpenLibrary={() => setView("library")}
              onOpenModels={() => setView("models")}
              onMinimize={handleMinimizeToMiniWidget}
              onClose={handleCloseWindow}
              onDragMouseDown={handleStartWindowDrag}
            />
            <div onMouseDown={handleStartWindowDrag} className="h-4 w-full cursor-grab" aria-label="Drag strip" />

            {view === "recorder" ? (
              <div className="flex h-[calc(100%-4.75rem)] w-full flex-col items-center">
                <MicButton isActive={isActive} status={status} onToggle={handleToggleCapture} />
                <div className={`mt-5 -mb-2 w-full flex justify-center h-1.5 transition-opacity duration-300 ${status === "listening" ? "opacity-100" : "opacity-0"}`}>
                  <VUMeter />
                </div>
                <StatusPill status={status} uiLanguage={uiLanguage} />
                <div className="mt-2 flex w-full flex-1 px-4 pb-4">
                  <div className="flex h-full min-h-[11rem] w-full flex-col rounded-md border border-border/60 bg-secondary/30 px-3 py-2">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/90">
                      {t("main.latest_transcription")}
                    </p>
                    <div className="mt-1 flex-1 overflow-y-auto pr-1">
                      <p className="text-xs text-foreground/90 whitespace-pre-wrap break-words">
                        {latestTranscript || t("main.no_transcribed_text")}
                      </p>
                    </div>
                    {showResponseTimes && lastResponseMs !== null ? (
                      <p className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground w-full">
                        <span>{t("main.response_time", { ms: lastResponseMs })}</span>
                        <span className="opacity-60 flex gap-2">
                          <code className="bg-foreground/5 px-1.5 py-0.5 rounded font-mono uppercase tracking-widest">{activeBackend === 'faster-whisper' ? 'Faster Whisper' : activeBackend === 'whispercpp' ? 'Whisper.cpp' : activeBackend}</code>
                          <code className="bg-foreground/5 px-1.5 py-0.5 rounded font-mono">{model}</code>
                        </span>
                      </p>
                    ) : (
                      <p className="mt-1 flex items-center justify-end text-[11px] text-muted-foreground w-full">
                        <span className="opacity-60 flex gap-2">
                          <code className="bg-foreground/5 px-1.5 py-0.5 rounded font-mono uppercase tracking-widest">{activeBackend === 'faster-whisper' ? 'Faster Whisper' : activeBackend === 'whispercpp' ? 'Whisper.cpp' : activeBackend}</code>
                          <code className="bg-foreground/5 px-1.5 py-0.5 rounded font-mono">{model}</code>
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : view === "library" ? (
              <div className="flex h-[calc(100%-4.75rem)] w-full flex-col">
                <LibraryView onBack={() => setView("recorder")} className="flex-1 rounded-b-3xl" />
              </div>
            ) : view === "models" ? (
              <div className="flex h-[calc(100%-4.75rem)] w-full flex-col">
                <ModelsManager
                  models={downloadedModels}
                  modelDownloads={modelDownloads}
                  onDeleteModel={handleDeleteModel}
                  onRefresh={handleRefreshHardware}
                  onBack={() => setView("recorder")}
                  className="flex-1 rounded-b-3xl"
                  modelDir={modelDir || defaultModelDir}
                />
              </div>
            ) : (
              <div className="flex h-[calc(100%-4.75rem)] w-full flex-col">
                <SettingsPage
                  onBack={() => setView("recorder")}
                  microphone={microphone}
                  onMicrophoneChange={(value) => {
                    desiredMicrophoneRef.current = value;
                    setMicrophone(value);
                  }}
                  model={model}
                  onModelChange={setModel}
                  modelDir={modelDir}
                  onModelDirChange={setModelDir}
                  modelDirOptions={modelDirOptions}
                  backend={backend}
                  onBackendChange={setBackend}
                  captureMode={captureMode}
                  onCaptureModeChange={setCaptureMode}
                  captureShortcutType={captureShortcutType}
                  onCaptureShortcutTypeChange={setCaptureShortcutType}
                  activeBackend={activeBackend}
                  language={language}
                  onLanguageChange={setLanguage}
                  uiLanguage={uiLanguage}
                  onUiLanguageChange={(value) => setUiLanguage(value as UiLanguage)}
                  expandedViewSize={expandedViewSize}
                  onExpandedViewSizeChange={setExpandedViewSize}
                  startWithWindows={startWithWindows}
                  onStartWithWindowsChange={setStartWithWindows}
                  closeToMiniWidget={closeToMiniWidget}
                  onCloseToMiniWidgetChange={setCloseToMiniWidget}
                  showFloatingWidget={showFloatingWidget}
                  onShowFloatingWidgetChange={setShowFloatingWidget}
                  showTrayIcon={showTrayIcon}
                  onShowTrayIconChange={setShowTrayIcon}
                  gpuEnabled={gpuEnabled}
                  onGpuToggle={setGpuEnabled}
                  toggleWidgetCombo={toggleWidgetCombo}
                  onToggleWidgetComboChange={setToggleWidgetCombo}
                  toggleCaptureCombo={toggleCaptureCombo}
                  onToggleCaptureComboChange={setToggleCaptureCombo}
                  onRecordingChange={setIsRecording}
                  availableMics={availableMics}
                  downloadedModels={downloadedModels}
                  modelDownloads={modelDownloads}
                  isAnyModelDownloading={isAnyModelDownloading}
                  onDownloadModel={handleDownloadModel}
                  showResponseTimes={showResponseTimes}
                  onShowResponseTimesChange={setShowResponseTimes}
                  gpuInfo={gpuInfo}
                  availableBackends={availableBackends}
                  clipboardMode={clipboardMode}
                  onClipboardModeChange={toggleClipboard}
                  clipboardAutoPaste={clipboardAutoPaste}
                  onClipboardAutoPasteChange={setClipboardAutoPaste}
                  autoPasteMode={autoPasteMode}
                  onAutoPasteModeChange={handleAutoPasteModeChange}
                  onRefreshHardware={handleRefreshHardware}
                  onSave={handleSaveSettings}
                  className="flex-1 rounded-b-3xl"
                />
              </div>
            )}

            {onboardingOpen && !isBooting ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-card/92 p-4">
                <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-4">
                  <h3 className="font-mono text-xs uppercase tracking-wider text-foreground">
                    {t("onboarding.title")}
                  </h3>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("onboarding.description")}
                  </p>

                  <div className="mt-4 rounded-lg border border-border bg-secondary/40 p-3">
                    <p className="text-xs text-foreground">large-v3-turbo</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t("onboarding.recommended")}
                    </p>
                    {onboardingBusy ? (
                      <div className="mt-2">
                        <Progress value={onboardingProgress} className="h-1.5" />
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {t("onboarding.downloading", { progress: onboardingProgress })}
                        </p>
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-4 flex gap-2">
                    <Button
                      type="button"
                      className="flex-1"
                      disabled={onboardingBusy || isAnyModelDownloading || onboardingStatus === "completed"}
                      onClick={() => handleDownloadModel(recommendedOnboardingModel)}
                    >
                      {onboardingStatus === "completed"
                        ? t("onboarding.model_ready")
                        : onboardingBusy
                          ? t("onboarding.downloading", { progress: "" }).replace("%", "")
                          : t("onboarding.download_model")}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setView("settings")}>
                      {t("onboarding.options")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        localStorage.setItem(ONBOARDING_DONE_KEY, "1");
                        setOnboardingOpen(false);
                      }}
                    >
                      {t("onboarding.skip")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {/* Bottom accent line */}
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
          </motion.div>
        ) : showMiniWidget ? (
          <motion.div
            key="mini-widget"
            initial={{ opacity: 0, y: -8, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.92 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute left-0 top-0 z-50 flex h-full w-full items-center justify-center"
          >
            <div
              className={`group relative flex items-center gap-2.5 cursor-grab rounded-full border px-5 py-3 shadow-2xl backdrop-blur-md transition-all duration-300 active:cursor-grabbing select-none ${
                status === "listening"
                  ? "border-primary/50 bg-primary/10 shadow-[0_4px_24px_rgba(37,99,235,0.25)] ring-1 ring-primary/20"
                  : status === "transcribing"
                  ? "border-cyan-400/50 bg-cyan-400/10 shadow-[0_4px_24px_rgba(34,211,238,0.2)] ring-1 ring-cyan-400/20"
                  : status === "processing"
                  ? "border-amber-500/50 bg-amber-500/10 shadow-[0_4px_24px_rgba(245,158,11,0.2)] ring-1 ring-amber-500/20"
                  : "border-border/60 bg-card/80 shadow-[0_4px_20px_rgba(0,0,0,0.3)]"
              }`}
              data-tauri-drag-region
              onDoubleClick={handleRestoreFromMiniWidget}
            >
              {/* Drag region overlay */}
              <div className="absolute inset-0 rounded-full" data-tauri-drag-region />

              {/* VU bars */}
              <div className="relative z-10 pointer-events-none">
                <MiniVUBars status={status} />
              </div>

              {/* Status label */}
              <span
                className={`relative z-10 pointer-events-none font-mono text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors duration-300 ${
                  status === "listening" ? "text-primary" :
                  status === "transcribing" ? "text-cyan-400" :
                  status === "processing" ? "text-amber-500" :
                  "text-muted-foreground/70"
                }`}
              >
                {status === "listening" ? t("mini.recorder") :
                 status === "transcribing" ? t("mini.ready") :
                 status === "processing" ? "loading..." :
                 showMiniDoneTick ? t("mini.ready") : t("mini.recorder")}
              </span>

              {/* Subtle animated ring when active */}
              {(status === "listening" || status === "transcribing") && (
                <span className={`absolute inset-0 rounded-full animate-ping opacity-20 ${
                  status === "listening" ? "bg-primary" : "bg-cyan-400"
                }`} style={{ animationDuration: "2s" }} />
              )}

              {/* Close button */}
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const { getCurrentWindow } = await import("@tauri-apps/api/window");
                    await getCurrentWindow().close();
                  } catch (error) {
                    console.error("Failed to close app", error);
                  }
                }}
                className="relative z-20 ml-1 flex h-5 w-5 scale-0 items-center justify-center rounded-full bg-muted/30 text-muted-foreground opacity-0 transition-all duration-200 group-hover:scale-100 group-hover:opacity-100 hover:bg-destructive/80 hover:text-white"
                aria-label={t("mini.close_mini_widget")}
              >
                <X className="h-3 w-3 stroke-[2.5]" />
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </main >
  );
}
