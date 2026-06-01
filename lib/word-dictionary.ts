import { safeInvoke } from "@/lib/tauri-client";

export interface WordSub {
  from: string;
  to: string;
}

const DICT_KEY = "veloce:word_dictionary:v1";
const DICT_ENABLED_KEY = "veloce:word_dictionary_enabled:v1";

export async function loadWordDictionary(): Promise<WordSub[]> {
  try {
    const raw = localStorage.getItem(DICT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveWordDictionary(subs: WordSub[]): Promise<void> {
  localStorage.setItem(DICT_KEY, JSON.stringify(subs));
  // Persist to disk via Tauri command. Payload shape is wrapped to match
  // Python load_word_dictionary(): data.get("substitutions", []).
  // localStorage remains source of truth for loadWordDictionary(); on disk
  // failure we rethrow so the caller can surface a non-fatal error.
  const json = JSON.stringify({ substitutions: subs });
  try {
    await safeInvoke("write_word_dictionary", { json });
  } catch (e) {
    console.error("Failed to write word dictionary to disk:", e);
    throw e;
  }
}

export async function isDictionaryEnabled(): Promise<boolean> {
  return localStorage.getItem(DICT_ENABLED_KEY) !== "false";
}

export async function setDictionaryEnabled(enabled: boolean): Promise<void> {
  localStorage.setItem(DICT_ENABLED_KEY, enabled ? "true" : "false");
  try {
    await safeInvoke("reload_word_dictionary");
  } catch (e) {
    console.error("Failed to reload dictionary in engine:", e);
  }
}
