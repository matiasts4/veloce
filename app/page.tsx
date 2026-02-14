"use client";

import { useState, useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AudioLines, Check, Mic, X } from "lucide-react";
import { TitleBar } from "@/components/veloce/title-bar";
import { MicButton } from "@/components/veloce/mic-button";
import { StatusPill } from "@/components/veloce/status-pill";
import { SettingsModal } from "@/components/veloce/settings-modal";
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
type ExpandedViewSize = "compact" | "large";
type ModelDownloadStatus = "idle" | "starting" | "downloading" | "completed" | "error";
type ModelDownloadState = { progress: number; status: ModelDownloadStatus };

const SETTINGS_KEY = "veloce:settings:v1";
const ONBOARDING_DONE_KEY = "veloce:onboarding:done:v1";
const NORMAL_WIDTH = 500;
const NORMAL_HEIGHT = 620;
const LARGE_WIDTH = 700;
const LARGE_HEIGHT = 640;
const MINI_WIDTH = 196;
const MINI_HEIGHT = 52;

const DEFAULT_TOGGLE_WIDGET: HotkeyCombo = {
  key: "v",
  ctrlKey: true,
  shiftKey: false,
  altKey: true,
  metaKey: false,
};

const DEFAULT_TOGGLE_CAPTURE: HotkeyCombo = {
  key: " ",
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
};

function inferShortcutType(combo: HotkeyCombo | null): CaptureShortcutType {
  if (!combo) return "single";
  return combo.ctrlKey || combo.shiftKey || combo.altKey || combo.metaKey ? "combo" : "single";
}

export default function VelocePage() {
  const [isVisible, setIsVisible] = useState(true);
  const [showMiniWidget, setShowMiniWidget] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Whether a keybind recorder is currently capturing keys
  const [isRecording, setIsRecording] = useState(false);

  // Settings state
  const [microphone, setMicrophone] = useState("default");
  const [model, setModel] = useState("large-v3-turbo");
  const [modelDir, setModelDir] = useState("");
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
  const [gpuEnabled, setGpuEnabled] = useState(false);
  const [availableMics, setAvailableMics] = useState<{ id: number; name: string }[]>([]);
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
  const [showResponseTimes, setShowResponseTimes] = useState(false);
  const [latestTranscript, setLatestTranscript] = useState("");
  const [lastResponseMs, setLastResponseMs] = useState<number | null>(null);
  const [showMiniDoneTick, setShowMiniDoneTick] = useState(false);
  const [engineError, setEngineError] = useState("");
  const [engineLog, setEngineLog] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const miniIsListening = isActive && status === "listening";
  const activeRecordingIdRef = useRef<number | null>(null);

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

  // Toggle widget between normal and mini mode
  const handleToggleVisibility = useCallback(() => {
    if (isVisible) {
      setIsVisible(false);
      setShowMiniWidget(true);

      Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
        .then(async ([windowApi, dpiApi]) => {
          const { getCurrentWindow } = windowApi;
          const { LogicalSize } = dpiApi;
          const window = getCurrentWindow();
          await window.setSize(new LogicalSize(MINI_WIDTH, MINI_HEIGHT));
          await window.setResizable(false);
          await window.setAlwaysOnTop(true);
        })
        .catch((error) => console.error("Failed to minimize from hotkey", error));
      return;
    }

    setIsVisible(true);
    setShowMiniWidget(false);

    Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
      .then(async ([windowApi, dpiApi]) => {
        const { getCurrentWindow } = windowApi;
        const { LogicalSize } = dpiApi;
        const window = getCurrentWindow();
        const target = getExpandedWindowSize();
        await window.setAlwaysOnTop(false);
        await window.setResizable(true);
        await window.setSize(new LogicalSize(target.width, target.height));
      })
      .catch((error) => console.error("Failed to restore from hotkey", error));
  }, [getExpandedWindowSize, isVisible]);

  const handleMinimizeToMiniWidget = useCallback(() => {
    setIsVisible(false);
    setShowMiniWidget(true);

    Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
      .then(async ([windowApi, dpiApi]) => {
        const { getCurrentWindow } = windowApi;
        const { LogicalSize } = dpiApi;
        const window = getCurrentWindow();
        await window.setSize(new LogicalSize(MINI_WIDTH, MINI_HEIGHT));
        await window.setResizable(false);
        await window.setAlwaysOnTop(true);
      })
      .catch((error) => console.error("Failed to minimize to mini widget", error));
  }, []);

  const handleRestoreFromMiniWidget = useCallback(() => {
    setIsVisible(true);
    setShowMiniWidget(false);

    Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
      .then(async ([windowApi, dpiApi]) => {
        const { getCurrentWindow } = windowApi;
        const { LogicalSize } = dpiApi;
        const window = getCurrentWindow();
        const target = getExpandedWindowSize();
        await window.setAlwaysOnTop(false);
        await window.setResizable(true);
        await window.setSize(new LogicalSize(target.width, target.height));
      })
      .catch((error) => console.error("Failed to restore window", error));
  }, [getExpandedWindowSize]);

  const handleCloseWindow = useCallback(async () => {
    if (closeToMiniWidget) {
      handleMinimizeToMiniWidget();
      return;
    }

    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (error) {
      console.error("Failed to close window", error);
    }
  }, [closeToMiniWidget, handleMinimizeToMiniWidget]);

  const handleStartWindowDrag = useCallback(async (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,a,input,select,textarea,[role='button']")) {
      return;
    }

    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
    } catch (error) {
      console.error("Failed to start dragging", error);
    }
  }, []);

  // Toggle capture
  const handleToggleCapture = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const recording = await invoke<boolean>("toggle_recording");
      if (recording) {
        activeRecordingIdRef.current = null;
        setLatestTranscript("");
        setLastResponseMs(null);
      }
      setIsActive(recording);
      setStatus(recording ? "listening" : "idle");
    } catch (error) {
      console.error("Failed to toggle recording", error);
      setEngineError(uiLanguage === "es" ? "No se pudo iniciar/detener la grabación." : "Could not start/stop recording.");
    }
  }, [uiLanguage]);

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

    import("@tauri-apps/api/event").then(async ({ listen }) => {
      unlistenStatus = await listen<string>("status-update", (event) => {
        console.log("Status update:", event.payload);
        // Map backend status to UI status
        // Backend: "recording", "stopped", "loading_model", "ready"
        if (event.payload === "recording") {
          setStatus("listening");
          setIsActive(true);
        } else if (event.payload === "stopped") {
          setStatus("idle");
          setIsActive(false);
        } else if (event.payload === "transcribing") {
          setStatus("transcribing");
          // Keep current active state: during segmented live capture backend can
          // briefly switch to transcribing and back to recording.
        } else if (event.payload === "loading_model") {
          setStatus("processing"); // Reusing processing state for loading
          setIsActive(false);
        } else if (event.payload === "ready") {
          setStatus("idle");
          setIsActive(false);
        }
      });

      unlistenRecording = await listen<boolean>("recording-state", (event) => {
        const isRecording = event.payload;
        if (isRecording) {
          activeRecordingIdRef.current = null;
          setLatestTranscript("");
          setLastResponseMs(null);
        }
        setIsActive(isRecording);
        setStatus(isRecording ? "listening" : "idle");
      });

      // Listen for hardware info
      unlistenHardware = await listen<any>("hardware-info", (event) => {
        console.log("Hardware Info:", event.payload);
        const whispercppAvailable = Array.isArray(event.payload?.backends?.available)
          ? event.payload.backends.available.some((item: any) => item?.id === "whispercpp" && item?.available === true)
          : false;

        if (Array.isArray(event.payload.microphones)) {
          setAvailableMics(event.payload.microphones);
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

          if (!modelDir && typeof event.payload.default_model_dir === "string") {
            const fallbackDir = event.payload.default_model_dir.trim();
            if (fallbackDir.length > 0 && options.includes(fallbackDir)) {
              setModelDir(fallbackDir);
            }
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

      unlistenTranscription = await listen<{ text?: string; response_ms?: number; recording_id?: number } | string>("transcription-update", (event) => {
        const payload = event.payload;
        const text = typeof payload === "string" ? payload : (payload?.text ?? "");
        const responseMs = typeof payload === "string" ? null : payload?.response_ms;
        const recordingId = typeof payload === "string" ? null : (typeof payload?.recording_id === "number" ? payload.recording_id : null);

        setLatestTranscript((previous) => {
          const chunk = text.trim();
          if (!chunk) {
            return previous;
          }

          if (recordingId !== null) {
            if (activeRecordingIdRef.current === null || activeRecordingIdRef.current !== recordingId) {
              activeRecordingIdRef.current = recordingId;
              return chunk;
            }
          }

          const current = previous.trim();
          if (!current) {
            return chunk;
          }

          if (chunk.startsWith(current)) {
            return chunk;
          }

          if (current.endsWith(chunk)) {
            return current;
          }

          const currentLower = current.toLowerCase();
          const chunkLower = chunk.toLowerCase();
          const maxOverlap = Math.min(currentLower.length, chunkLower.length);
          let overlap = 0;
          for (let size = maxOverlap; size > 0; size -= 1) {
            if (currentLower.endsWith(chunkLower.slice(0, size))) {
              overlap = size;
              break;
            }
          }

          if (overlap > 0) {
            return `${current}${chunk.slice(overlap)}`.trim();
          }

          return `${current} ${chunk}`;
        });
        if (typeof responseMs === "number") {
          setLastResponseMs(Math.max(0, Math.round(responseMs)));
        }
        setShowMiniDoneTick(true);
        window.setTimeout(() => setShowMiniDoneTick(false), 1200);
        setEngineError("");
      });

      unlistenError = await listen<string>("engine-error", (event) => {
        const message = event.payload ?? "";
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
        setEngineLog(event.payload);
      });

      unlistenModelDownload = await listen<{ model?: string; progress?: number }>("model-download-progress", (event) => {
        const modelId = typeof event.payload?.model === "string" ? event.payload.model : "";
        if (!modelId) return;

        const progress = Math.max(0, Math.min(100, Number(event.payload?.progress ?? 0)));
        setModelDownloads((previous) => ({
          ...previous,
          [modelId]: {
            status: progress >= 100 ? "completed" : "downloading",
            progress,
          },
        }));

        if (progress >= 100) {
          setActiveModelDownload(null);
        }
      });

      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("refresh_hardware");
    });

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenRecording) unlistenRecording();
      if (unlistenHardware) unlistenHardware();
      if (unlistenTranscription) unlistenTranscription();
      if (unlistenError) unlistenError();
      if (unlistenLog) unlistenLog();
      if (unlistenModelDownload) unlistenModelDownload();
    };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved.microphone === "string") setMicrophone(saved.microphone);
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
        } else {
          const loadedCaptureCombo =
            saved.toggleCaptureCombo && typeof saved.toggleCaptureCombo === "object"
              ? (saved.toggleCaptureCombo as HotkeyCombo)
              : DEFAULT_TOGGLE_CAPTURE;
          setCaptureShortcutType(inferShortcutType(loadedCaptureCombo));
        }
        if (typeof saved.language === "string") setLanguage(saved.language);
        if (saved.uiLanguage === "es" || saved.uiLanguage === "en") setUiLanguage(saved.uiLanguage);
        if (saved.expandedViewSize === "compact" || saved.expandedViewSize === "large") setExpandedViewSize(saved.expandedViewSize);
        if (typeof saved.startWithWindows === "boolean") setStartWithWindows(saved.startWithWindows);
        if (typeof saved.gpuEnabled === "boolean") setGpuEnabled(saved.gpuEnabled);
        if (typeof saved.clipboardMode === "boolean") setClipboardMode(saved.clipboardMode);
        if (typeof saved.clipboardAutoPaste === "boolean") setClipboardAutoPaste(saved.clipboardAutoPaste);
        if (typeof saved.showResponseTimes === "boolean") setShowResponseTimes(saved.showResponseTimes);
        if (typeof saved.closeToMiniWidget === "boolean") setCloseToMiniWidget(saved.closeToMiniWidget);
        if (saved.toggleWidgetCombo === null || typeof saved.toggleWidgetCombo === "object") setToggleWidgetCombo(saved.toggleWidgetCombo ?? null);
        if (saved.toggleCaptureCombo === null || typeof saved.toggleCaptureCombo === "object") setToggleCaptureCombo(saved.toggleCaptureCombo ?? null);
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
        showResponseTimes,
        closeToMiniWidget,
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
    showResponseTimes,
    closeToMiniWidget,
    toggleWidgetCombo,
    toggleCaptureCombo,
  ]);

  useEffect(() => {
    if (!settingsOpen) return;

    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("refresh_hardware"))
      .catch((error) => console.error("Failed to refresh hardware", error));
  }, [settingsOpen]);

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

  useEffect(() => {
    if (!settingsLoaded) return;

    import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("set_engine_settings", {
          microphone,
          model,
          modelDir,
          backend,
          language,
          gpuEnabled,
        })
      )
      .catch((error) => {
        console.error("Failed to update engine settings", error);
        setEngineError(uiLanguage === "es" ? "No se pudo actualizar configuración del motor." : "Could not update engine settings.");
      });
  }, [settingsLoaded, microphone, model, modelDir, backend, language, gpuEnabled, uiLanguage]);

  useEffect(() => {
    if (!settingsLoaded) return;

    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_capture_mode", { mode: captureMode }))
      .catch((error) => {
        console.error("Failed to update capture mode", error);
        setEngineError(uiLanguage === "es" ? "No se pudo actualizar el modo de captura." : "Could not update capture mode.");
      });
  }, [settingsLoaded, captureMode, uiLanguage]);

  useEffect(() => {
    if (!settingsLoaded || !toggleCaptureCombo) return;

    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_capture_hotkey", { hotkey: toggleCaptureCombo }))
      .catch((error) => {
        console.error("Failed to update capture hotkey", error);
        setEngineError(uiLanguage === "es" ? "No se pudo actualizar el atajo global de captura." : "Could not update global capture hotkey.");
      });
  }, [settingsLoaded, toggleCaptureCombo, uiLanguage]);

  useEffect(() => {
    if (!settingsLoaded || !toggleCaptureCombo) return;
    setCaptureShortcutType(inferShortcutType(toggleCaptureCombo));
  }, [settingsLoaded, toggleCaptureCombo]);

  useEffect(() => {
    if (!settingsLoaded) return;

    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_clipboard_settings", { enabled: clipboardMode, autoPaste: clipboardAutoPaste }))
      .catch((error) => console.error("Failed to sync clipboard mode", error));
  }, [settingsLoaded, clipboardMode, clipboardAutoPaste]);

  useEffect(() => {
    if (!settingsLoaded) return;

    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_startup_enabled", { enabled: startWithWindows }))
      .catch((error) => console.error("Failed to sync startup setting", error));
  }, [settingsLoaded, startWithWindows]);

  useEffect(() => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("get_startup_enabled"))
      .then((enabled) => setStartWithWindows(Boolean(enabled)))
      .catch((error) => console.error("Failed to read startup setting", error));
  }, []);

  useEffect(() => {
    if (showMiniWidget || !isVisible) return;

    Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")])
      .then(async ([windowApi, dpiApi]) => {
        const { getCurrentWindow } = windowApi;
        const { LogicalSize } = dpiApi;
        const window = getCurrentWindow();
        const target = getExpandedWindowSize();
        await window.setResizable(true);
        await window.setSize(new LogicalSize(target.width, target.height));
      })
      .catch((error) => console.error("Failed to apply expanded view size", error));
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

  const handleRefreshHardware = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("refresh_hardware");
      setEngineLog(uiLanguage === "es" ? "Hardware actualizado" : "Hardware refreshed");
    } catch (error) {
      console.error("Failed to refresh hardware", error);
      setEngineError(uiLanguage === "es" ? "No se pudo actualizar el hardware." : "Could not refresh hardware.");
    }
  }, [uiLanguage]);

  const handleDownloadModel = useCallback(
    async (modelId: string) => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        setEngineError("");
        setActiveModelDownload(modelId);
        setModelDownloads((previous) => ({
          ...previous,
          [modelId]: { status: "starting", progress: 0 },
        }));
        await invoke("download_model", { model: modelId });
      } catch (error) {
        console.error("Failed to start model download", error);
        setModelDownloads((previous) => ({
          ...previous,
          [modelId]: { status: "error", progress: 0 },
        }));
        setActiveModelDownload(null);
        setEngineError(uiLanguage === "es" ? "No se pudo iniciar la descarga del modelo." : "Could not start model download.");
      }
    },
    [uiLanguage]
  );

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
          showResponseTimes,
          closeToMiniWidget,
          toggleWidgetCombo,
          toggleCaptureCombo,
        })
      );
      setEngineLog(uiLanguage === "es" ? "Configuración guardada" : "Settings saved");
    } catch (error) {
      console.error("Failed to save settings", error);
    }
    setSettingsOpen(false);
  }, [
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
    showResponseTimes,
    closeToMiniWidget,
    toggleWidgetCombo,
    toggleCaptureCombo,
  ]);

  return (
    <main
      className="h-full w-full overflow-hidden bg-transparent p-0"
      style={{ backgroundColor: "transparent" }}
    >
      <AnimatePresence mode="wait">
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

            <TitleBar
              onOpenSettings={() => setSettingsOpen(true)}
              onMinimize={handleMinimizeToMiniWidget}
              onClose={handleCloseWindow}
              onDragMouseDown={handleStartWindowDrag}
            />
            <div onMouseDown={handleStartWindowDrag} className="h-4 w-full cursor-grab" aria-label="Drag strip" />

            <div className="flex h-[calc(100%-4.75rem)] w-full flex-col items-center">
              <MicButton isActive={isActive} status={status} onToggle={handleToggleCapture} />
              <StatusPill status={status} uiLanguage={uiLanguage} />
              <div className="mt-2 flex w-full flex-1 px-4 pb-4">
                <div className="flex h-full min-h-[11rem] w-full flex-col rounded-md border border-border/60 bg-secondary/30 px-3 py-2">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/90">
                    {uiLanguage === "es" ? "Última transcripción" : "Latest transcription"}
                  </p>
                  <div className="mt-1 flex-1 overflow-y-auto pr-1">
                    <p className="text-xs text-foreground/90 whitespace-pre-wrap break-words">
                      {latestTranscript || (uiLanguage === "es" ? "Aún no hay texto transcrito." : "No transcribed text yet.")}
                    </p>
                  </div>
                  {showResponseTimes && lastResponseMs !== null ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {uiLanguage === "es" ? `Tiempo de respuesta: ${lastResponseMs} ms` : `Response time: ${lastResponseMs} ms`}
                    </p>
                  ) : null}
                  {engineError ? (
                    <p className="mt-2 text-[11px] text-red-400">{engineError}</p>
                  ) : null}
                  {!engineError && engineLog ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">{engineLog}</p>
                  ) : null}
                </div>
              </div>
            </div>

            {onboardingOpen ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-card/92 p-4">
                <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-4">
                  <h3 className="font-mono text-xs uppercase tracking-wider text-foreground">
                    {uiLanguage === "es" ? "Configuración inicial" : "Initial setup"}
                  </h3>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {uiLanguage === "es"
                      ? "Vamos a dejar Veloce listo en este equipo. Descarga el modelo recomendado para comenzar a transcribir."
                      : "Let’s prepare Veloce on this machine. Download the recommended model to start transcribing."}
                  </p>

                  <div className="mt-4 rounded-lg border border-border bg-secondary/40 p-3">
                    <p className="text-xs text-foreground">large-v3-turbo</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {uiLanguage === "es" ? "Recomendado: velocidad + precisión" : "Recommended: speed + accuracy"}
                    </p>
                    {onboardingBusy ? (
                      <div className="mt-2">
                        <Progress value={onboardingProgress} className="h-1.5" />
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {uiLanguage === "es" ? `Descargando ${onboardingProgress}%` : `Downloading ${onboardingProgress}%`}
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
                        ? (uiLanguage === "es" ? "Modelo listo" : "Model ready")
                        : onboardingBusy
                          ? (uiLanguage === "es" ? "Descargando" : "Downloading")
                          : (uiLanguage === "es" ? "Descargar modelo" : "Download model")}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setSettingsOpen(true)}>
                      {uiLanguage === "es" ? "Opciones" : "Options"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        localStorage.setItem(ONBOARDING_DONE_KEY, "1");
                        setOnboardingOpen(false);
                      }}
                    >
                      {uiLanguage === "es" ? "Omitir" : "Skip"}
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
            initial={{ opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 10 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="absolute left-0 top-0 z-50 h-full w-full overflow-hidden rounded-full"
          >
            <div
              className="group relative flex h-full w-full items-center rounded-full border border-border/70 bg-card px-2"
            >
              <button
                onClick={handleRestoreFromMiniWidget}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-border/80 bg-secondary/60 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={uiLanguage === "es" ? "Restaurar app" : "Restore app"}
              >
                <motion.div
                  animate={{ scale: [1, 1.06, 1] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                  className="relative"
                >
                  {showMiniDoneTick ? (
                    <motion.div
                      initial={{ scale: 0.7, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.7, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <Check className="h-4 w-4 text-emerald-400" />
                    </motion.div>
                  ) : miniIsListening ? (
                    <AudioLines className="h-4 w-4 text-primary" />
                  ) : (
                    <Mic className="h-4 w-4 text-muted-foreground" />
                  )}
                </motion.div>
              </button>

              <div data-tauri-drag-region className="ml-2 flex min-w-0 flex-1 cursor-grab select-none items-center gap-2 pr-8">
                <div className="flex items-end gap-1">
                  {[0, 1, 2, 3].map((bar) => (
                    <motion.span
                      key={bar}
                      className={`block w-1 rounded-full ${miniIsListening ? "bg-primary" : "bg-muted-foreground/60"}`}
                      animate={
                        miniIsListening
                          ? { height: [4, 12, 6, 10, 4] }
                          : { height: [4, 6, 4] }
                      }
                      transition={{
                        duration: miniIsListening ? 0.8 : 1.2,
                        repeat: Infinity,
                        ease: "easeInOut",
                        delay: bar * 0.08,
                      }}
                    />
                  ))}
                </div>
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {showMiniDoneTick ? (uiLanguage === "es" ? "Listo" : "Ready") : (uiLanguage === "es" ? "Grabador" : "Recorder")}
                </span>
              </div>

              <button
                onClick={async () => {
                  try {
                    const { getCurrentWindow } = await import("@tauri-apps/api/window");
                    await getCurrentWindow().close();
                  } catch (error) {
                    console.error("Failed to close app", error);
                  }
                }}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label={uiLanguage === "es" ? "Cerrar mini icono" : "Close mini widget"}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="hidden-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
        )}
      </AnimatePresence>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        microphone={microphone}
        onMicrophoneChange={setMicrophone}
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
        onRefreshHardware={handleRefreshHardware}
        onSave={handleSaveSettings}
      />
    </main>
  );
}
