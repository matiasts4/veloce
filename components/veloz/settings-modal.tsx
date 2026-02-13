"use client";

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
import { KeybindRecorder } from "@/components/veloz/keybind-recorder";
import type { HotkeyCombo } from "@/hooks/use-hotkey";

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  microphone: string;
  onMicrophoneChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  language: string;
  onLanguageChange: (value: string) => void;
  uiLanguage: "es" | "en";
  onUiLanguageChange: (value: string) => void;
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
  gpuInfo: { available: boolean; name: string };
  downloadedModels: { id: string; name: string; downloaded?: boolean }[];
  showResponseTimes: boolean;
  onShowResponseTimesChange: (enabled: boolean) => void;
  clipboardMode: boolean;
  onClipboardModeChange: (enabled: boolean) => void;
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
  language,
  onLanguageChange,
  uiLanguage,
  onUiLanguageChange,
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
  gpuInfo = { available: false, name: "None" },
  downloadedModels = [],
  showResponseTimes,
  onShowResponseTimesChange,
  clipboardMode,
  onClipboardModeChange,
  onRefreshHardware,
  onSave,
}: SettingsModalProps) {
  const recommendedModels = [
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

  const t = {
    settingsTitle: uiLanguage === "es" ? "Configuración" : "Settings",
    settingsDescription: uiLanguage === "es" ? "Configura tus preferencias de dictado por voz." : "Configure your voice dictation preferences.",
    keyboardShortcuts: uiLanguage === "es" ? "Atajos de Teclado" : "Keyboard Shortcuts",
    showHideWidget: uiLanguage === "es" ? "Mostrar / Ocultar Widget" : "Show / Hide Widget",
    toggleCapture: uiLanguage === "es" ? "Iniciar/Detener Captura" : "Toggle Capture",
    microphoneInput: uiLanguage === "es" ? "Micrófono" : "Microphone Input",
    defaultMicrophone: uiLanguage === "es" ? "Micrófono Predeterminado" : "Default Microphone",
    refreshHardware: uiLanguage === "es" ? "Actualizar" : "Refresh",
    aiModel: uiLanguage === "es" ? "Modelo de IA" : "AI Model",
    downloadedModel: uiLanguage === "es" ? "Descargado" : "Downloaded",
    notDownloadedModel: uiLanguage === "es" ? "No descargado" : "Not downloaded",
    downloadModel: uiLanguage === "es" ? "Descarga manual" : "Manual download",
    topModels: uiLanguage === "es" ? "Top modelos recomendados" : "Top recommended models",
    modelHint: uiLanguage === "es"
      ? "Solo se pueden seleccionar modelos detectados como descargados."
      : "Only models detected as downloaded can be selected.",
    modelManualHint: uiLanguage === "es"
      ? "Descárgalos desde Hugging Face y luego pulsa Actualizar."
      : "Download from Hugging Face and then click Refresh.",
    languageLabel: uiLanguage === "es" ? "Idioma de Transcripción" : "Transcription Language",
    uiLanguageLabel: uiLanguage === "es" ? "Idioma de la Interfaz" : "Program Language",
    closeActionLabel: uiLanguage === "es" ? "Acción al presionar X" : "Close Button Action",
    closeActionHint: uiLanguage === "es" ? "Minimizar al mini icono" : "Minimize to mini icon",
    gpuAcceleration: uiLanguage === "es" ? "Aceleración GPU" : "GPU Acceleration",
    clipboardMode: uiLanguage === "es" ? "Modo Portapapeles" : "Clipboard Mode",
    clipboardHint: uiLanguage === "es" ? "Pegar (Ctrl+V) en lugar de escribir" : "Paste (Ctrl+V) instead of Typing",
    responseTimes: uiLanguage === "es" ? "Tiempo de Respuesta" : "Response Time",
    responseTimesHint: uiLanguage === "es" ? "Mostrar ms por transcripción" : "Show ms per transcription",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,24rem)] max-w-none max-h-[calc(100vh-1rem)] overflow-y-auto border-border bg-card [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/70 [&::-webkit-scrollbar-thumb:hover]:bg-border">
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

            <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/50 p-3">
              <div className="flex items-center justify-between gap-3">
                <Label className="shrink-0 font-mono text-xs text-foreground">
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

              <div className="flex items-center justify-between gap-3">
                <Label className="shrink-0 font-mono text-xs text-foreground">
                  {t.toggleCapture}
                </Label>
                <div className="w-40">
                  <KeybindRecorder
                    value={toggleCaptureCombo}
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
            <div className="mt-1 rounded-lg border border-border bg-secondary/40 p-3">
              <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{t.topModels}</p>
              <div className="flex flex-col gap-1.5">
                {topModels.map((topModel, index) => (
                  <a
                    key={topModel.id}
                    href={topModel.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-border/70 bg-secondary/70 px-2 py-1.5 text-xs text-foreground transition-colors hover:border-primary/60 hover:text-primary"
                  >
                    {`${index + 1}. ${topModel.name}`}
                  </a>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                {uiLanguage === "es"
                  ? "También puedes usar otros modelos compatibles de faster-whisper."
                  : "You can also use other faster-whisper compatible models."}
              </p>
            </div>
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
                AMD / NVIDIA
              </span>
            </div>
            <Switch
              id="gpu-toggle"
              checked={gpuEnabled}
              onCheckedChange={onGpuToggle}
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
