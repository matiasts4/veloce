import { getAllTranscriptions, saveTranscriptionToDB, updateTranscriptionInDB, deleteTranscriptionFromDB, migrateFromLocalStorage } from "@/lib/db";

// Export the interface from db.ts or redefine here if preferred for consumers
export interface Transcription {
  id: string;
  text: string;
  createdAt: string; // ISO string
  tags: string[];
  durationMs?: number;
}

// Perform migration on first load if possible
if (typeof window !== "undefined") {
  migrateFromLocalStorage().catch(console.error);
}

export async function getTranscriptions(offset: number = 0, limit: number = 50): Promise<Transcription[]> {
  try {
    return await getAllTranscriptions(offset, limit);
  } catch (error) {
    console.error("Failed to load transcriptions from DB", error);
    return [];
  }
}

export async function saveTranscription(text: string, durationMs?: number): Promise<Transcription> {
  return await saveTranscriptionToDB(text, durationMs);
}

export async function updateTranscription(id: string, updates: Partial<Omit<Transcription, "id" | "createdAt">>): Promise<Transcription | null> {
  return await updateTranscriptionInDB(id, updates);
}

export async function deleteTranscription(id: string): Promise<void> {
  await deleteTranscriptionFromDB(id);
}
