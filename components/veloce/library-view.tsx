"use client";

import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Download, Trash, Copy, ArrowLeft, Calendar, Clock, Edit2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { getTranscriptions, deleteTranscription, updateTranscription, type Transcription } from "@/lib/store";
import { safeInvoke } from "@/lib/tauri-client";

interface LibraryViewProps {
  onBack: () => void;
  className?: string;
}

export function LibraryView({ onBack, className }: LibraryViewProps) {
  const { t, i18n } = useTranslation();
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const LIMIT = 50;
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    // Initial load
    setOffset(0);
    setHasMore(true);
    getTranscriptions(0, LIMIT).then((newItems) => {
      setTranscriptions(newItems);
      if (newItems.length < LIMIT) setHasMore(false);
    });
  }, []);

  const loadMore = async () => {
    const nextOffset = offset + LIMIT;
    const moreItems = await getTranscriptions(nextOffset, LIMIT);

    if (moreItems.length === 0) {
      setHasMore(false);
      return;
    }

    setTranscriptions((prev) => [...prev, ...moreItems]);
    setOffset(nextOffset);
    if (moreItems.length < LIMIT) setHasMore(false);
  };

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return transcriptions;
    const q = searchQuery.toLowerCase();
    return transcriptions.filter((item) => item.text.toLowerCase().includes(q));
  }, [transcriptions, searchQuery]);

  const selectedItem = useMemo(
    () => transcriptions.find((item) => item.id === selectedId),
    [transcriptions, selectedId]
  );

  const handleDelete = async (id: string) => {
    await deleteTranscription(id);
    setTranscriptions((prev) => prev.filter((t) => t.id !== id));
    if (selectedId === id) {
      setSelectedId(null);
      setIsEditing(false);
    }
  };

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };

  const handleExport = async (item: Transcription) => {
    const filename = `veloce-${new Date(item.createdAt).toISOString().slice(0, 10)}-${item.id.slice(0, 4)}.txt`;

    // Use browser download method which works in Tauri webview as well
    const blob = new Blob([item.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const startEditing = (item: Transcription) => {
    setEditValue(item.text);
    setIsEditing(true);
  };

  const saveEdit = async () => {
    if (!selectedId) return;
    const updated = await updateTranscription(selectedId, { text: editValue });
    if (updated) {
      setTranscriptions((prev) =>
        prev.map((t) => (t.id === selectedId ? updated : t))
      );
      setIsEditing(false);
    }
  };

  return (
    <div className={`flex h-full w-full flex-col bg-background ${className}`}>
      {/* Header */}
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 rounded-full" aria-label={t("library.back")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="font-mono text-sm font-medium uppercase tracking-wider text-foreground">
          {t("library.title")}
        </h2>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar List */}
        <div className={`flex w-full min-w-0 flex-col border-r bg-muted/10 transition-all md:w-64 ${selectedId ? "hidden md:flex" : "flex"}`}>
          <div className="p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("library.search_placeholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 w-full bg-background pl-9 text-xs"
                aria-label={t("library.search_placeholder")}
              />
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-1 p-2">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <p className="text-xs text-muted-foreground">
                    {searchQuery ? t("library.no_results") : t("library.empty_state")}
                  </p>
                </div>
              ) : (
                filtered.map((item) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedId(item.id);
                      setIsEditing(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(item.id);
                        setIsEditing(false);
                      }
                    }}
                    className={`group flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring ${selectedId === item.id ? "border-primary/50 bg-primary/5" : "border-transparent bg-background"
                      }`}
                  >
                    <p className="line-clamp-2 text-xs font-medium text-foreground">
                      {item.text || "..."}
                    </p>
                    <div className="flex items-center justify-between w-full mt-1">
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(item.createdAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {new Date(item.createdAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity focus:opacity-100 bg-background/50 hover:bg-background"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopy(item.text, item.id);
                        }}
                        aria-label={t("library.copy")}
                      >
                        {copiedId === item.id ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Detail View */}
        <div className={`flex flex-1 flex-col bg-background ${selectedId ? "flex" : "hidden md:flex"}`}>
          {selectedItem ? (
            <>
              <div className="flex items-center justify-between border-b px-4 py-2">
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSelectedId(null)} aria-label={t("library.back")}>
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {new Date(selectedItem.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {isEditing ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="h-7 px-2">
                        <X className="mr-1 h-3.5 w-3.5" />
                        Cancel
                      </Button>
                      <Button size="sm" onClick={saveEdit} className="h-7 px-2">
                        <Check className="mr-1 h-3.5 w-3.5" />
                        {t("library.save")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEditing(selectedItem)} aria-label={t("library.edit")}>
                        <Edit2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleCopy(selectedItem.text, selectedItem.id)} aria-label={t("library.copy")}>
                        {copiedId === selectedItem.id ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleExport(selectedItem)} aria-label={t("library.export")}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" aria-label={t("library.delete")}>
                            <Trash className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("library.delete")}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(selectedItem.id)} className="bg-destructive hover:bg-destructive/90">
                              {t("library.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  )}
                </div>
              </div>
              <div className="flex-1 p-4">
                {isEditing ? (
                  <Textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="h-full resize-none border-0 bg-transparent p-0 text-sm focus-visible:ring-0"
                  />
                ) : (
                  <ScrollArea className="h-full">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {selectedItem.text}
                    </p>
                  </ScrollArea>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-muted-foreground/50">
              <Search className="mb-2 h-10 w-10 opacity-20" />
              <p className="text-sm">Select a transcription to view</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
