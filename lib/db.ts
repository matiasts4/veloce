const DB_NAME = "VeloceDB";
const DB_VERSION = 1;
const STORE_NAME = "transcriptions";

export interface Transcription {
  id: string;
  text: string;
  createdAt: string; // ISO string
  tags: string[];
  durationMs?: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = (event) => {
      reject((event.target as IDBOpenDBRequest).error);
    };
  });

  return dbPromise;
}

export async function getAllTranscriptions(offset: number = 0, limit: number = 50): Promise<Transcription[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index("createdAt");

    // Open a cursor going backwards (prev) to get newest first
    const request = index.openCursor(null, "prev");
    const results: Transcription[] = [];
    let hasAdvanced = false;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      
      if (!cursor) {
        resolve(results);
        return;
      }

      if (offset > 0 && !hasAdvanced) {
        hasAdvanced = true;
        cursor.advance(offset);
        return;
      }

      if (results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    
    request.onerror = () => reject(request.error);
  });
}

export async function saveTranscriptionToDB(text: string, durationMs?: number): Promise<Transcription> {
  const db = await openDB();
  const newTranscription: Transcription = {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
    tags: [],
    durationMs,
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.add(newTranscription);

    request.onsuccess = () => resolve(newTranscription);
    request.onerror = () => reject(request.error);
  });
}

export async function updateTranscriptionInDB(id: string, updates: Partial<Omit<Transcription, "id" | "createdAt">>): Promise<Transcription | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const item = getRequest.result as Transcription;
      if (!item) {
        resolve(null);
        return;
      }

      const updatedItem = { ...item, ...updates };
      const putRequest = store.put(updatedItem);

      putRequest.onsuccess = () => resolve(updatedItem);
      putRequest.onerror = () => reject(putRequest.error);
    };

    getRequest.onerror = () => reject(getRequest.error);
  });
}

export async function deleteTranscriptionFromDB(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Migration helper to move data from localStorage to IndexedDB once
export async function migrateFromLocalStorage() {
  const STORAGE_KEY = "veloce:transcriptions:v1";
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const legacyData = JSON.parse(raw) as Transcription[];
    if (Array.isArray(legacyData) && legacyData.length > 0) {
      console.log(`Migrating ${legacyData.length} items from localStorage to IndexedDB...`);
      const db = await openDB();
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      
      for (const item of legacyData) {
        // Use put to avoid errors on duplicates if migration ran partially
        store.put(item); 
      }
      
      // Clear legacy storage only after successful transaction setup
      transaction.oncomplete = () => {
        localStorage.removeItem(STORAGE_KEY);
        console.log("Migration complete.");
      };
    }
  } catch (e) {
    console.error("Migration failed", e);
  }
}
