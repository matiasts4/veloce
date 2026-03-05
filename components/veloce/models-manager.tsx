"use client";

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Trash, HardDrive, AlertTriangle, RefreshCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface ModelsManagerProps {
  models: { id: string; name: string; downloaded?: boolean; path?: string }[];
  modelDownloads: Record<string, { progress: number; status: string; loaded?: number; total?: number }>;
  onDeleteModel: (modelId: string, path?: string) => void;
  onRefresh: () => void;
  onBack?: () => void;
  className?: string;
  modelDir?: string;
}

export function ModelsManager({ models, modelDownloads, onDeleteModel, onRefresh, onBack, className, modelDir }: ModelsManagerProps) {
  const { t } = useTranslation();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const downloadedModels = useMemo(() => {
    return models.filter((m) => m.downloaded);
  }, [models]);

  const formatBytes = (bytes?: number) => {
    if (typeof bytes !== 'number') return 'Unknown size';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className={`flex min-h-0 w-full flex-col bg-background ${className}`}>
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
            {onBack && (
                <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 -ml-2" aria-label={t("common.back", "Back")}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
            )}
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-mono text-sm font-medium uppercase tracking-wider text-foreground">
            {t("models.title", "Local Models")}
            </h2>
        </div>
        <Button variant="ghost" size="icon" onClick={onRefresh} className="h-8 w-8" title={t("models.refresh", "Refresh List")}>
            <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
          {downloadedModels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center opacity-60">
              <HardDrive className="mb-2 h-8 w-8 stroke-[1.5]" />
              <p className="text-sm text-muted-foreground">{t("models.empty", "No models downloaded")}</p>
            </div>
          ) : (
            downloadedModels.map((model) => (
              <div
                key={model.id}
                className="flex items-center justify-between rounded-lg border bg-card p-3 shadow-sm transition-all hover:border-border/80"
              >
                <div className="flex flex-col gap-1 min-w-0 flex-1 pr-3">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-medium text-foreground truncate" title={model.name}>
                        {model.name}
                    </h3>
                    <span className="text-[10px] font-mono text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded">
                        {model.id}
                    </span>
                  </div>
                  {model.path ? (
                      <div className="flex flex-col mt-0.5">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground/60">Path</span>
                        <p className="text-[10px] text-muted-foreground break-all leading-tight">
                            {model.path}
                        </p>
                      </div>
                  ) : (
                      <p className="text-[10px] text-muted-foreground/50 italic mt-0.5">
                        {t("models.path_unknown", "Path not available (Restart required)")}
                      </p>
                  )}
                </div>

                <AlertDialog open={deletingId === model.id} onOpenChange={(open) => !open && setDeletingId(null)}>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                      onClick={() => setDeletingId(model.id)}
                    >
                      <Trash className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("models.delete_confirm_title", "Delete Model?")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("models.delete_confirm_desc", "This will remove the model files from your disk. You can download it again later.")}
                        <div className="mt-2 rounded-md bg-secondary/50 p-2 text-xs font-mono">
                            {model.name}
                        </div>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={() => setDeletingId(null)}>{t("common.cancel", "Cancel")}</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive hover:bg-destructive/90"
                        onClick={() => {
                            onDeleteModel(model.id, model.path);
                            setDeletingId(null);
                        }}
                      >
                        {t("common.delete", "Delete")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))
          )}

          {/* Active Downloads Section */}
          {Object.entries(modelDownloads).map(([id, state]) => {
             if (state.status === "completed" || state.status === "idle" || state.status === "error") return null;
             return (
                <div key={id} className="flex flex-col gap-2 rounded-lg border bg-secondary/20 p-3">
                    <div className="flex justify-between text-xs">
                        <span className="font-medium">{id}</span>
                        <span className="text-muted-foreground">{state.progress}%</span>
                    </div>
                    <Progress value={state.progress} className="h-1.5" />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>{state.status}</span>
                        {state.loaded && state.total ? (
                            <span>{formatBytes(state.loaded)} / {formatBytes(state.total)}</span>
                        ) : null}
                    </div>
                </div>
             );
          })}
        </div>
      </ScrollArea>

      <div className="border-t bg-secondary/10 px-4 py-2 text-[10px] text-muted-foreground break-all">
          <span className="font-semibold mr-1 opacity-70">{t("models.directory", "Directory")}:</span>
          {modelDir || <span className="opacity-50 italic">...</span>}
      </div>
    </div>
  );
}
