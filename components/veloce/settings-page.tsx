"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { ArrowLeft } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

type DownloadStatus = "idle" | "starting" | "downloading" | "completed" | "error";

type ModelDownloadState = {
  progress: number;
  status: DownloadStatus;
  loaded?: number;
  total?: number;
  unit?: string;
};

interface SettingsPageProps {
  onBack: () => void;
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
  showFloatingWidget: boolean;
  onShowFloatingWidgetChange: (enabled: boolean) => void;
  showTrayIcon: boolean;
  onShowTrayIconChange: (enabled: boolean) => void;
  gpuEnabled: boolean;
  onGpuToggle: (enabled: boolean) => void;
  toggleWidgetCombo: HotkeyCombo | null;
  onToggleWidgetComboChange: (combo: HotkeyCombo | null) => void;
  toggleCaptureCombo: HotkeyCombo | null;
  onToggleCaptureComboChange: (combo: HotkeyCombo | null) => void;
  onRecordingChange: (recording: boolean) => void;
  // Dynamic Data
  availableMics: { id: number | string; name: string }[];
  gpuInfo: { available: boolean; name: string; reason?: string };
  availableBackends: { id: "auto" | "faster-whisper" | "whispercpp"; available: boolean; reason?: string }[];
  downloadedModels: { id: string; name: string; downloaded?: boolean }[];
  modelDownloads: Record<string, ModelDownloadState>;
  isAnyModelDownloading: boolean;
  onDownloadModel: (modelId: string, downloadDir?: string) => void;
  showResponseTimes: boolean;
  onShowResponseTimesChange: (enabled: boolean) => void;
  clipboardMode: boolean;
  onClipboardModeChange: (enabled: boolean) => void;
  clipboardAutoPaste: boolean;
  onClipboardAutoPasteChange: (enabled: boolean) => void;
  onRefreshHardware: () => void;
  onSave: () => void;
  className?: string;
}

export function SettingsPage({
  onBack,
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
  showFloatingWidget,
  onShowFloatingWidgetChange,
  showTrayIcon,
  onShowTrayIconChange,
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
  className,
}: SettingsPageProps) {
  const { t } = useTranslation();
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

  const backendMap = new Map(availableBackends.map((item) => [item.id, item]));
  const whispercppAvailable = backendMap.get("whispercpp")?.available === true;
  const gpuToggleAvailable = gpuInfo.available || whispercppAvailable;
  const backendDisplayName = (value: "auto" | "faster-whisper" | "whispercpp" | "none") => {
    if (value === "none") return t("settings.not_loaded");
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
        return t("settings.whispercpp_active");
      }
      return backendMap.get("whispercpp")?.reason || t("settings.whispercpp_unavailable");
    }

    if (gpuInfo.available) {
      return gpuInfo.name || "GPU detected";
    }

    return gpuInfo.reason || "AMD / NVIDIA";
  })();
  const getModelDownloadState = (modelId: string): ModelDownloadState =>
    modelDownloads[modelId] ?? { progress: 0, status: "idle" };

  const getDownloadButtonText = (status: DownloadStatus, progress: number, state?: ModelDownloadState) => {
    if (status === "starting") return t("settings.queued_action");
    if (status === "downloading") {
      if (state?.total && state?.loaded) {
        const loadedMB = (state.loaded / (1024 * 1024)).toFixed(1);
        const totalMB = (state.total / (1024 * 1024)).toFixed(1);
        return `${t("settings.downloading_action")} ${progress}% (${loadedMB}/${totalMB} MB)`;
      }
      return `${t("settings.downloading_action")} ${progress}%`;
    }
    if (status === "completed") return t("settings.downloaded_action");
    if (status === "error") return t("settings.retry_action");
    return t("settings.download_action");
  };

  const handleBrowseModelDir = async () => {
    const { isTauri } = await import("@/lib/tauri-client");
    if (!isTauri()) {
      console.warn("File picker not available in browser mode");
      return;
    }

    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: modelDir || undefined,
      });

      if (selected && typeof selected === "string") {
        onModelDirChange(selected);
      }
    } catch (error) {
      console.error("Failed to open directory picker", error);
    }
  };

  const handleBrowseModelFile = async () => {
    const { isTauri } = await import("@/lib/tauri-client");
    if (!isTauri()) {
      console.warn("File picker not available in browser mode");
      return;
    }

    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{
          name: "Whisper Models",
          extensions: ["bin", "gguf"]
        }]
      });

      if (selected && typeof selected === "string") {
        onModelChange(selected);
      }
    } catch (error) {
      console.error("Failed to open file picker", error);
    }
  };

  return (
    <div className={`flex h-full w-full flex-col bg-background ${className}`}>
      {/* Header */}
      <header className="flex items-center gap-3 border-b px-4 py-3 shrink-0">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 rounded-full" aria-label={t("library.back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="font-mono text-sm font-medium uppercase tracking-wider text-foreground">
          {t("settings.title")}
        </h2>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/70 [&::-webkit-scrollbar-thumb:hover]:bg-border [&_*]:min-w-0">
        <div className="flex flex-col gap-5 max-w-2xl mx-auto">
          {/* Keyboard Shortcuts Section */}
          <div className="flex flex-col gap-3">
            <span className="font-mono text-[11px] font-medium tracking-wider uppercase text-muted-foreground">
              {t("settings.keyboard_shortcuts")}
            </span>

            <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/50 p-3">
              <Label
                htmlFor="capture-mode-select"
                className="font-mono text-xs text-foreground"
              >
                {t("settings.capture_mode")}
              </Label>
              <Select value={captureMode} onValueChange={(value) => onCaptureModeChange(value as "toggle" | "hold")}>
                <SelectTrigger
                  id="capture-mode-select"
                  className="border-border bg-secondary text-foreground"
                >
                  <SelectValue placeholder="Select capture mode" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card text-foreground">
                  <SelectItem value="toggle">{t("settings.capture_mode_toggle")}</SelectItem>
                  <SelectItem value="hold">{t("settings.capture_mode_hold")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{t("settings.capture_mode_hint")}</p>
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/50 p-3">
              <Label
                htmlFor="capture-shortcut-type-select"
                className="font-mono text-xs text-foreground"
              >
                {t("settings.capture_shortcut_type")}
              </Label>
              <Select value={captureShortcutType} onValueChange={(value) => onCaptureShortcutTypeChange(value as "single" | "combo")}>
                <SelectTrigger
                  id="capture-shortcut-type-select"
                  className="border-border bg-secondary text-foreground"
                >
                  <SelectValue placeholder="Select shortcut type" />
                </SelectTrigger>
                <SelectContent className="border-border bg-card text-foreground">
                  <SelectItem value="single">{t("settings.capture_type_single")}</SelectItem>
                  <SelectItem value="combo">{t("settings.capture_type_combo")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{t("settings.capture_shortcut_type_hint")}</p>
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
                {t("settings.use_home")}
              </Button>
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/50 p-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <Label className="min-w-0 shrink font-mono text-xs text-foreground">
                  {t("settings.show_hide_widget")}
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
                  {t("settings.toggle_capture")}
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
                {t("settings.microphone_input")}
              </Label>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={onRefreshHardware}>
                {t("settings.refresh")}
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
                <SelectItem value="default">{t("settings.default_microphone")}</SelectItem>
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
              {t("settings.ai_model")}
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
                )) : null}
                <SelectItem value="__custom_file__">{t("settings.select_file")}</SelectItem>
                {model && !downloadedOnly.find(m => m.id === model) && model !== "__custom_file__" && (
                  <SelectItem value={model}>{model}</SelectItem>
                )}
              </SelectContent>
            </Select>
            {model === "__custom_file__" && (
              <div className="mt-2">
                <Button type="button" variant="secondary" size="sm" onClick={handleBrowseModelFile} className="w-full">
                  {t("settings.browse")}
                </Button>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              {t("settings.downloaded_model_hint")}
            </p>
            <p className="text-[11px] text-muted-foreground">{t("settings.model_manual_hint")}</p>
            {downloadedOnly.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1 h-7 w-full px-2 text-[11px]"
                onClick={() => setShowDownloads((value) => !value)}
              >
                {showDownloads
                  ? t("settings.hide_downloads")
                  : t("settings.show_downloads")}
              </Button>
            ) : null}

            {showDownloads ? (
              <div className="mt-1 rounded-lg border border-border bg-secondary/40 p-3">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{t("settings.model_download_title")}</p>
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
                            {getDownloadButtonText(downloadState.status, downloadState.progress, downloadState)}
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
                  {t("settings.download_one_at_a_time_hint")}
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label
              htmlFor="backend-select"
              className="font-mono text-xs text-muted-foreground"
            >
              {t("settings.backend_label")}
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
                  return (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label + (isAvailable ? "" : " (unavailable)")}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t("settings.backend_hint")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("settings.active_backend")}: {backendDisplayName(activeBackend)}
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
              {t("settings.model_dir_label")}
            </Label>
            <Select value={modelDir || "__default__"} onValueChange={(value) => onModelDirChange(value === "__default__" ? "" : value)}>
              <SelectTrigger
                id="model-dir-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder={t("settings.model_dir_default")} />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                <SelectItem value="__default__">{t("settings.model_dir_default")}</SelectItem>
                {mergedModelDirOptions.map((dirPath) => (
                  <SelectItem key={dirPath} value={dirPath}>
                    {dirPath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleBrowseModelDir}
              className="mt-1 w-full"
            >
              {t("settings.browse_folder")}
            </Button>
            <p className="text-[11px] text-muted-foreground">{t("settings.model_dir_hint")}</p>
          </div>

          {/* Language */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="language-select"
              className="font-mono text-xs text-muted-foreground"
            >
              {t("settings.transcription_language")}
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
              {t("settings.interface_language")}
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
              {t("settings.expanded_view_size")}
            </Label>
            <Select value={expandedViewSize} onValueChange={(value) => onExpandedViewSizeChange(value as "compact" | "large")}>
              <SelectTrigger
                id="expanded-view-size-select"
                className="border-border bg-secondary text-foreground"
              >
                <SelectValue placeholder="Select expanded size" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                <SelectItem value="compact">{t("settings.compact")}</SelectItem>
                <SelectItem value="large">{t("settings.large")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t("settings.expanded_view_hint")}</p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="startup-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t("settings.start_with_windows")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settings.start_with_windows_hint")}
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
                {t("settings.close_button_action")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settings.close_action_hint")}
              </span>
            </div>
            <Switch
              id="close-action-toggle"
              checked={closeToMiniWidget}
              onCheckedChange={onCloseToMiniWidgetChange}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="floating-widget-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t("settings.show_floating_widget", "Mostrar widget flotante")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settings.show_floating_widget_hint", "Si se desactiva, la ventana se ocultará totalmente al minimizar.")}
              </span>
            </div>
            <Switch
              id="floating-widget-toggle"
              checked={showFloatingWidget}
              onCheckedChange={onShowFloatingWidgetChange}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="tray-icon-toggle"
                className="cursor-pointer font-mono text-xs text-foreground"
              >
                {t("settings.show_tray_icon", "Icono en la barra de sistema (Tray)")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settings.show_tray_icon_hint", "Muestra el icono de Veloce en la parte superior del sistema.")}
              </span>
            </div>
            <Switch
              id="tray-icon-toggle"
              checked={showTrayIcon}
              onCheckedChange={onShowTrayIconChange}
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
                {t("settings.gpu_acceleration")}
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
                {t("settings.copy_to_clipboard")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settings.clipboard_hint")}
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
                {t("settings.auto_paste")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settings.auto_paste_hint")}
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
                {t("settings.response_time")}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t("settings.response_time_hint")}
              </span>
            </div>
            <Switch
              id="response-times-toggle"
              checked={showResponseTimes}
              onCheckedChange={onShowResponseTimesChange}
              className="data-[state=checked]:bg-primary"
            />
          </div>

          <div className="pb-8">
            <Button
              onClick={onSave}
              className="w-full"
            >
              {t("settings.save_changes")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
