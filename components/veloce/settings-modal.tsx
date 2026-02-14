"use client";

import { useEffect, useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { KeybindRecorder } from "@/components/veloce/keybind-recorder";
import type { HotkeyCombo } from "@/hooks/use-hotkey";

type DownloadStatus = "idle" | "starting" | "downloading" | "completed" | "error";

type ModelDownloadState = {
  progress: number;
  status: DownloadStatus;
};

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  microphone: string;
  onMicrophoneChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  modelDir: string;
  onModelDirChange: (value: string) => void;
  modelDirOptions: string[];
  backend: "auto" | "faster-whisper" | "whispercpp";
  onBackendChange: (value: "auto" | "faster-whisper" | "whispercpp") => void;
  captureMode: "toggle" | "hold";
  onCaptureModeChange: (value: "toggle" | "hold") => void;
  captureShortcutType: "single" | "combo";
  onCaptureShortcutTypeChange: (value: "single" | "combo") => void;
  activeBackend: "auto" | "faster-whisper" | "whispercpp" | "none";
  language: string;
  onLanguageChange: (value: string) => void;
  uiLanguage: "es" | "en";
  onUiLanguageChange: (value: string) => void;
  expandedViewSize: "compact" | "large";
  onExpandedViewSizeChange: (value: "compact" | "large") => void;
  startWithWindows: boolean;
  onStartWithWindowsChange: (enabled: boolean) => void;
  closeToMiniWidget: boolean;
  onCloseToMiniWidgetChange: (enabled: boolean) => void;
  gpuEnabled: boolean;
  onGpuToggle: (enabled: boolean) => void;
  toggleWidgetCombo: HotkeyCombo | null;
  onToggleWidgetComboChange: (combo: HotkeyCombo | null) => void;
  toggleCaptureCombo: HotkeyCombo | null;
  onToggleCaptureComboChange: (combo: HotkeyCombo | null) => void;
  onRecordingChange: (recording: boolean) => void;
  // Dynamic Data
  availableMics: { id: number; name: string }[];
  gpuInfo: { available: boolean; name: string; reason?: string };
  availableBackends: { id: "auto" | "faster-whisper" | "whispercpp"; available: boolean; reason?: string }[];
  downloadedModels: { id: string; name: string; downloaded?: boolean }[];
  modelDownloads: Record<string, ModelDownloadState>;
  isAnyModelDownloading: boolean;
  onDownloadModel: (modelId: string) => void;
  showResponseTimes: boolean;
  onShowResponseTimesChange: (enabled: boolean) => void;
  clipboardMode: boolean;
  onClipboardModeChange: (enabled: boolean) => void;
  clipboardAutoPaste: boolean;
  onClipboardAutoPasteChange: (enabled: boolean) => void;
  onRefreshHardware: () => void;
  onSave: () => void;
}

export function SettingsModal({
  open,
  onOpenChange,
  microphone,
  onMicrophoneChange,
  model,
  onModelChange,
  modelDir,
  onModelDirChange,
  modelDirOptions,
  backend,
  onBackendChange,
  captureMode,
  onCaptureModeChange,
  captureShortcutType,
  onCaptureShortcutTypeChange,
  activeBackend,
  language,
  onLanguageChange,
  uiLanguage,
  onUiLanguageChange,
  expandedViewSize,
  onExpandedViewSizeChange,
  startWithWindows,
  onStartWithWindowsChange,
  closeToMiniWidget,
  onCloseToMiniWidgetChange,
  gpuEnabled,
  onGpuToggle,
  toggleWidgetCombo,
  onToggleWidgetComboChange,
  toggleCaptureCombo,
  onToggleCaptureComboChange,
  onRecordingChange,
  availableMics = [],
  gpuInfo = { available: false, name: "None", reason: "" },
  availableBackends = [],
  downloadedModels = [],
  modelDownloads,
  isAnyModelDownloading,
  onDownloadModel,
  showResponseTimes,
  onShowResponseTimesChange,
  clipboardMode,
  onClipboardModeChange,
  clipboardAutoPaste,
  onClipboardAutoPasteChange,
  onRefreshHardware,
  onSave,
}: SettingsModalProps) {
  const [showDownloads, setShowDownloads] = useState(false);

  const recommendedModels: Array<{ id: string; name: string; downloaded: boolean; url?: string }> = [
    { id: "tiny", name: "Tiny — Más rápido", downloaded: false, url: "https://huggingface.co/Systran/faster-whisper-tiny" },
    { id: "base", name: "Base — Balanceado", downloaded: false, url: "https://huggingface.co/Systran/faster-whisper-base" },
    { id: "small", name: "Small — Mejor precisión", downloaded: false, url: "https://huggingface.co/Systran/faster-whisper-small" },
    { id: "medium", name: "Medium — Alta precisión", downloaded: false, url: "https://huggingface.co/Systran/faster-whisper-medium" },
    { id: "large-v3", name: "Large V3 — Máxima precisión", downloaded: false, url: "https://huggingface.co/Systran/faster-whisper-large-v3" },
    { id: "large-v3-turbo", name: "Large V3 Turbo — Muy rápido y preciso", downloaded: false, url: "https://huggingface.co/openai/whisper-large-v3-turbo" },
    { id: "distil-large-v3", name: "Distil Large V3 — Preciso y más rápido", downloaded: false, url: "https://huggingface.co/distil-whisper/distil-large-v3" },
    { id: "voxtral-mini-4b-realtime-2602", name: "Voxtral Mini 4B Realtime — Experimental", downloaded: false, url: "https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602" },
  ];

  const normalizeModelLabel = (name: string) => name.replace(/^[✓↓]\s*/, "").trim();

  const mergedMap = new Map(recommendedModels.map((model) => [model.id, model]));
  for (const model of downloadedModels) {
    const existing = mergedMap.get(model.id);
    mergedMap.set(model.id, {
      id: model.id,
      name: existing?.name ?? model.name,
      downloaded: model.downloaded ?? true,
      url: existing?.url,
    });
  }
  const mergedModels = Array.from(mergedMap.values());
  const downloadedOnly = mergedModels.filter((m) => m.downloaded);
  const topModels = ["large-v3-turbo", "large-v3", "distil-large-v3"]
    .map((id) => mergedMap.get(id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));

  useEffect(() => {
    setShowDownloads(downloadedOnly.length === 0);
  }, [downloadedOnly.length]);

  const mergedModelDirOptions = useMemo(() => {
    const options = Array.isArray(modelDirOptions) ? [...modelDirOptions] : [];
    if (modelDir && !options.includes(modelDir)) {
      options.unshift(modelDir);
    }
    return options;
  }, [modelDir, modelDirOptions]);

  const t = {
    settingsTitle: uiLanguage === "es" ? "Configuración" : "Settings",
    settingsDescription: uiLanguage === "es" ? "Configura tus preferencias de dictado por voz." : "Configure your voice dictation preferences.",
    keyboardShortcuts: uiLanguage === "es" ? "Atajos de Teclado" : "Keyboard Shortcuts",
    captureModeLabel: uiLanguage === "es" ? "Modo de captura" : "Capture mode",
    captureShortcutTypeLabel: uiLanguage === "es" ? "Tipo de atajo de captura" : "Capture shortcut type",
    captureShortcutTypeHint: uiLanguage === "es" ? "Tecla única usa solo una tecla (sin Ctrl/Alt/Shift), por ejemplo Home." : "Single key uses only one key (no Ctrl/Alt/Shift), for example Home.",
    captureModeHint: uiLanguage === "es" ? "Toggle: un toque inicia/detiene. Mantener: graba mientras mantienes presionado." : "Toggle: one press starts/stops. Hold: records while key is held.",
    showHideWidget: uiLanguage === "es" ? "Mostrar / Ocultar Widget" : "Show / Hide Widget",
    toggleCapture: uiLanguage === "es" ? "Iniciar/Detener Captura" : "Toggle Capture",
    microphoneInput: uiLanguage === "es" ? "Micrófono" : "Microphone Input",
    defaultMicrophone: uiLanguage === "es" ? "Micrófono Predeterminado" : "Default Microphone",
    refreshHardware: uiLanguage === "es" ? "Actualizar" : "Refresh",
    aiModel: uiLanguage === "es" ? "Modelo de IA" : "AI Model",
    modelDirLabel: uiLanguage === "es" ? "Ruta de modelos" : "Model directory",
    modelDirDefault: uiLanguage === "es" ? "Predeterminada" : "Default",
    modelDirHint: uiLanguage === "es"
      ? "Selecciona una carpeta detectada para modelos locales o caché de modelos ya descargados."
      : "Select a detected folder for local models or previously downloaded model cache.",
    backendLabel: uiLanguage === "es" ? "Backend de inferencia" : "Inference Backend",
    backendHint: uiLanguage === "es" ? "Auto cambia al backend compatible según GPU/modelo." : "Auto switches to a compatible backend based on GPU/model.",
    activeBackendLabel: uiLanguage === "es" ? "Backend activo" : "Active backend",
    downloadedModel: uiLanguage === "es" ? "Descargado" : "Downloaded",
    notDownloadedModel: uiLanguage === "es" ? "No descargado" : "Not downloaded",
    downloadModel: uiLanguage === "es" ? "Descarga de modelos" : "Model download",
    downloadAction: uiLanguage === "es" ? "Descargar" : "Download",
    downloadingAction: uiLanguage === "es" ? "Descargando" : "Downloading",
    downloadedAction: uiLanguage === "es" ? "Descargado" : "Downloaded",
    retryAction: uiLanguage === "es" ? "Reintentar" : "Retry",
    waitingAction: uiLanguage === "es" ? "En cola" : "Queued",
    topModels: uiLanguage === "es" ? "Top modelos recomendados" : "Top recommended models",
    modelHint: uiLanguage === "es"
      ? "Solo se pueden seleccionar modelos detectados como descargados."
      : "Only models detected as downloaded can be selected.",
    modelManualHint: uiLanguage === "es"
      ? "Descárgalos desde Hugging Face y luego pulsa Actualizar."
      : "Download from Hugging Face and then click Refresh.",
    languageLabel: uiLanguage === "es" ? "Idioma de Transcripción" : "Transcription Language",
    uiLanguageLabel: uiLanguage === "es" ? "Idioma de la Interfaz" : "Program Language",
    expandedViewLabel: uiLanguage === "es" ? "Tamaño de Vista Extendida" : "Expanded View Size",
    expandedViewHint: uiLanguage === "es" ? "Compacto mantiene el tamaño actual. Grande abre una vista más amplia." : "Compact keeps the current size. Large opens a wider view.",
    startupLabel: uiLanguage === "es" ? "Iniciar con Windows" : "Start with Windows",
    startupHint: uiLanguage === "es" ? "Abre Veloce automáticamente al iniciar sesión." : "Launches Veloce automatically on sign in.",
    closeActionLabel: uiLanguage === "es" ? "Acción al presionar X" : "Close Button Action",
    closeActionHint: uiLanguage === "es" ? "Minimizar al mini icono" : "Minimize to mini icon",
    gpuAcceleration: uiLanguage === "es" ? "Aceleración GPU" : "GPU Acceleration",
    clipboardMode: uiLanguage === "es" ? "Copiar al Portapapeles" : "Copy to Clipboard",
    clipboardHint: uiLanguage === "es" ? "Guarda la transcripción en portapapeles en vez de escribirla." : "Stores transcription in clipboard instead of typing.",
    clipboardAutoPaste: uiLanguage === "es" ? "Pegar automáticamente" : "Auto Paste",
    clipboardAutoPasteHint: uiLanguage === "es" ? "Pega al finalizar (Ctrl+V). Si está apagado, solo copia." : "Pastes when finished (Ctrl+V). If off, it only copies.",
    responseTimes: uiLanguage === "es" ? "Tiempo de Respuesta" : "Response Time",
    responseTimesHint: uiLanguage === "es" ? "Mostrar ms por transcripción" : "Show ms per transcription",
  };

  const backendMap = new Map(availableBackends.map((item) => [item.id, item]));
  const whispercppAvailable = backendMap.get("whispercpp")?.available === true;
  const gpuToggleAvailable = gpuInfo.available || whispercppAvailable;
  const backendDisplayName = (value: "auto" | "faster-whisper" | "whispercpp" | "none") => {
    if (value === "none") return uiLanguage === "es" ? "sin cargar" : "not loaded";
    if (value === "whispercpp") return "whisper.cpp";
    return value;
  };
  const backendOptions: Array<{ id: "auto" | "faster-whisper" | "whispercpp"; label: string }> = [
    { id: "auto", label: "Auto" },
    { id: "faster-whisper", label: "faster-whisper" },
    { id: "whispercpp", label: "whisper.cpp" },
  ];
  const gpuStatusText = (() => {
    if (activeBackend === "whispercpp") {
      if (whispercppAvailable) {
        return uiLanguage === "es"
          ? "whisper.cpp activo (GPU según build Vulkan/CUDA)."
          : "whisper.cpp active (GPU depends on Vulkan/CUDA build).";
      }
      return backendMap.get("whispercpp")?.reason || (uiLanguage === "es" ? "whisper.cpp no disponible" : "whisper.cpp unavailable");
    }

    if (gpuInfo.available) {
      return gpuInfo.name || "GPU detected";
    }

    return gpuInfo.reason || "AMD / NVIDIA";
  })();
  const getModelDownloadState = (modelId: string): ModelDownloadState =>
    modelDownloads[modelId] ?? { progress: 0, status: "idle" };

  const getDownloadButtonText = (status: DownloadStatus, progress: number) => {
    if (status === "starting") return t.waitingAction;
    if (status === "downloading") return `${t.downloadingAction} ${progress}%`;
    if (status === "completed") return t.downloadedAction;
    if (status === "error") return t.retryAction;
    return t.downloadAction;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[96vw] max-w-[32rem] max-h-[calc(100vh-1.25rem)] overflow-y-auto overflow-x-hidden rounded-2xl border-border bg-card p-4 [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/70 [&::-webkit-scrollbar-thumb:hover]:bg-border [&_*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm font-medium tracking-wider uppercase text-foreground">
            {t.settingsTitle}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t.settingsDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 pt-2">
          {/* Keyboard Shortcuts Section */}
          <div className="flex flex-col gap-3">
            <span className="font-mono text-[11px] font-medium tracking-wider uppercase text-muted-foreground">
              {t.keyboardShortcuts}
            </span>

            <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/50 p-3">
              <Label
                htmlFor="capture-mode-select"
                className="font-mono text-xs text-foreground"
              >
                {t.captureModeLabel}
              </Label>
              <Select value={captureMode} onValueChange={(value) => onCaptureModeChange(value as "toggle" | "hold")}>
                <SelectTrigger
                  id="capture-mode-select"
                  className="border-border bg-secondary text-foreground"
                >
                  <SelectValue placeholder="Select capture mode" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card text-foreground">
                  <SelectItem value="toggle">{uiLanguage === "es" ? "Toggle (apretar y volver a apretar)" : "Toggle (press again to stop)"}</SelectItem>
                  <SelectItem value="hold">{uiLanguage === "es" ? "Mantener presionado" : "Hold to talk"}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{t.captureModeHint}</p>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/50 p-3">
              <Label
                htmlFor="capture-shortcut-type-select"
                className="font-mono text-xs text-foreground"
              >
                {t.captureShortcutTypeLabel}
              </Label>
              <Select value={captureShortcutType} onValueChange={(value) => onCaptureShortcutTypeChange(value as "single" | "combo")}>
                <SelectTrigger
                  id="capture-shortcut-type-select"
                  className="border-border bg-secondary text-foreground"
                >
                  <SelectValue placeholder="Select shortcut type" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card text-foreground">
                  <SelectItem value="single">{uiLanguage === "es" ? "Tecla única" : "Single key"}</SelectItem>
                  <SelectItem value="combo">{uiLanguage === "es" ? "Combinación" : "Combination"}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{t.captureShortcutTypeHint}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-fit px-2 text-[11px]"
                onClick={() => {
                  onCaptureShortcutTypeChange("single");
                  onToggleCaptureComboChange({ key: "Home", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
                }}
              >
                {uiLanguage === "es" ? "Usar Home" : "Use Home"}
              </Button>
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/50 p-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <Label className="min-w-0 shrink font-mono text-xs text-foreground">
                  {t.showHideWidget}
                </Label>
                <div className="w-40">
                  <KeybindRecorder
                    value={toggleWidgetCombo}
                    onChange={onToggleWidgetComboChange}
                    onRecordingChange={onRecordingChange}
                  />
                </div>
              </div>

              <div className="h-px bg-border" />

              <div className="flex min-w-0 items-center justify-between gap-3">
                <Label className="min-w-0 shrink font-mono text-xs text-foreground">
                  {t.toggleCapture}
                </Label>
                <div className="w-40">
                  <KeybindRecorder
                    value={toggleCaptureCombo}
                    mode={captureShortcutType}
                    onChange={onToggleCaptureComboChange}
                    onRecordingChange={onRecordingChange}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Microphone Input */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <Label
                htmlFor="mic-select"
                className="font-mono text-xs text-muted-foreground"
              >
                {t.microphoneInput}
              </Label>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={onRefreshHardware}>
                {t.refreshHardware}
              </Button>
            </div>
            <Select value={microphone} onValueChange={onMicrophoneChange}>
              <SelectTrigger
                id="mic-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder="Select microphone" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                <SelectItem value="default">{t.defaultMicrophone}</SelectItem>
                {availableMics.map((mic) => (
                  <SelectItem key={mic.id} value={mic.id.toString()}>
                    {mic.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* AI Model */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="model-select"
              className="font-mono text-xs text-muted-foreground"
            >
              {t.aiModel}
            </Label>
            <Select value={model} onValueChange={onModelChange}>
              <SelectTrigger
                id="model-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                {downloadedOnly.length > 0 ? downloadedOnly.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {"✓ " + normalizeModelLabel(m.name)}
                  </SelectItem>
                )) : (
                  <SelectItem value="__none__" disabled>
                    {uiLanguage === "es" ? "No hay modelos detectados" : "No detected models"}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {"✓ " + t.downloadedModel + " · " + t.modelHint}
            </p>
            <p className="text-[11px] text-muted-foreground">{t.modelManualHint}</p>
            {downloadedOnly.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1 h-7 w-full px-2 text-[11px]"
                onClick={() => setShowDownloads((value) => !value)}
              >
                {showDownloads
                  ? (uiLanguage === "es" ? "Ocultar descargas" : "Hide downloads")
                  : (uiLanguage === "es" ? "Mostrar descargas" : "Show downloads")}
              </Button>
            ) : null}

            {showDownloads ? (
              <div className="mt-1 rounded-lg border border-border bg-secondary/40 p-3">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{t.downloadModel}</p>
                <div className="flex flex-col gap-2">
                  {topModels.map((topModel) => {
                    const downloadState = getModelDownloadState(topModel.id);
                    const isBusy = downloadState.status === "starting" || downloadState.status === "downloading";
                    const isDownloaded = topModel.downloaded;
                    const disableDownload = isDownloaded || (isAnyModelDownloading && !isBusy);

                    return (
                      <div key={topModel.id} className="rounded-md border border-border/70 bg-secondary/70 p-2">
                        <div className="flex flex-col gap-2">
                          <div className="min-w-0">
                            <p className="text-xs text-foreground break-words">{topModel.name}</p>
                            <p className="text-[10px] text-muted-foreground break-all">{topModel.id}</p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 w-full px-2 text-[11px]"
                            disabled={disableDownload}
                            onClick={() => onDownloadModel(topModel.id)}
                          >
                            {getDownloadButtonText(downloadState.status, downloadState.progress)}
                          </Button>
                        </div>
                        {isBusy ? (
                          <div className="mt-2">
                            <Progress value={downloadState.progress} className="h-1.5" />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {uiLanguage === "es"
                    ? "Puedes descargar uno por vez. El progreso se actualiza en tiempo real."
                    : "You can download one model at a time. Progress updates in real time."}
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label
              htmlFor="backend-select"
              className="font-mono text-xs text-muted-foreground"
            >
              {t.backendLabel}
            </Label>
            <Select value={backend} onValueChange={(value) => onBackendChange(value as "auto" | "faster-whisper" | "whispercpp")}>
              <SelectTrigger
                id="backend-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder="Select backend" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                {backendOptions.map((option) => {
                  const backendState = backendMap.get(option.id);
                  const isAvailable = option.id === "auto" || backendState?.available !== false;
                  const suffix = isAvailable ? "" : ` (${uiLanguage === "es" ? "no disponible" : "unavailable"})`;
                  return (
                    <SelectItem key={option.id} value={option.id} disabled={!isAvailable}>
                      {option.label + suffix}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t.backendHint}</p>
            <p className="text-[11px] text-muted-foreground">
              {t.activeBackendLabel}: {backendDisplayName(activeBackend)}
            </p>
            {backend === "whispercpp" && backendMap.get("whispercpp")?.reason ? (
              <p className="text-[11px] text-muted-foreground">{backendMap.get("whispercpp")?.reason}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label
              htmlFor="model-dir-select"
              className="font-mono text-xs text-muted-foreground"
            >
              {t.modelDirLabel}
            </Label>
            <Select value={modelDir || "__default__"} onValueChange={(value) => onModelDirChange(value === "__default__" ? "" : value)}>
              <SelectTrigger
                id="model-dir-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder={t.modelDirDefault} />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                <SelectItem value="__default__">{t.modelDirDefault}</SelectItem>
                {mergedModelDirOptions.map((dirPath) => (
                  <SelectItem key={dirPath} value={dirPath}>
                    {dirPath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t.modelDirHint}</p>
          </div>

          {/* Language */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="language-select"
              className="font-mono text-xs text-muted-foreground"
            >
              {t.languageLabel}
            </Label>
            <Select value={language} onValueChange={onLanguageChange}>
              <SelectTrigger
                id="language-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                <SelectItem value="es">Español</SelectItem>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="zh">中文 (Mandarin)</SelectItem>
                <SelectItem value="auto">Auto Detect</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* UI Language */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="ui-language-select"
              className="font-mono text-xs text-muted-foreground"
            >
              {t.uiLanguageLabel}
            </Label>
            <Select value={uiLanguage} onValueChange={onUiLanguageChange}>
              <SelectTrigger
                id="ui-language-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder="Select UI language" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                <SelectItem value="es">Español</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Close Action Toggle */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="expanded-view-size-select"
              className="font-mono text-xs text-muted-foreground"
            >
              {t.expandedViewLabel}
            </Label>
            <Select value={expandedViewSize} onValueChange={(value) => onExpandedViewSizeChange(value as "compact" | "large")}>
              <SelectTrigger
                id="expanded-view-size-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder="Select expanded size" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                <SelectItem value="compact">{uiLanguage === "es" ? "Compacto" : "Compact"}</SelectItem>
                <SelectItem value="large">{uiLanguage === "es" ? "Grande" : "Large"}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t.expandedViewHint}</p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="startup-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t.startupLabel}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t.startupHint}
              </span>
            </div>
            <Switch
              id="startup-toggle"
              checked={startWithWindows}
              onCheckedChange={onStartWithWindowsChange}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="close-action-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t.closeActionLabel}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t.closeActionHint}
              </span>
            </div>
            <Switch
              id="close-action-toggle"
              checked={closeToMiniWidget}
              onCheckedChange={onCloseToMiniWidgetChange}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          {/* GPU Acceleration Toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="gpu-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t.gpuAcceleration}
              </Label>
              <span className="text-xs text-muted-foreground">
                {gpuStatusText}
              </span>
            </div>
            <Switch
              id="gpu-toggle"
              checked={gpuEnabled}
              onCheckedChange={onGpuToggle}
              disabled={!gpuToggleAvailable}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          {/* Clipboard Mode Toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="clipboard-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t.clipboardMode}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t.clipboardHint}
              </span>
            </div>
            <Switch
              id="clipboard-toggle"
              checked={clipboardMode}
              onCheckedChange={onClipboardModeChange}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="clipboard-auto-paste-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t.clipboardAutoPaste}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t.clipboardAutoPasteHint}
              </span>
            </div>
            <Switch
              id="clipboard-auto-paste-toggle"
              checked={clipboardAutoPaste}
              onCheckedChange={onClipboardAutoPasteChange}
              disabled={!clipboardMode}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="response-times-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t.responseTimes}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t.responseTimesHint}
              </span>
            </div>
            <Switch
              id="response-times-toggle"
              checked={showResponseTimes}
              onCheckedChange={onShowResponseTimesChange}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          <Button
            onClick={onSave}
            className="w-full"
          >
            {uiLanguage === "es" ? "Guardar cambios" : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
