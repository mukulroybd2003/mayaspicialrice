import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { OfflineMutation } from '../types/erp';

interface SonaGrainDB extends DBSchema {
  kv_cache: {
    key: string;
    value: {
      key: string;
      data: unknown;
      updated_at: string;
    };
  };
  mutation_queue: {
    key: string;
    value: OfflineMutation;
    indexes: { 'by-status': string };
  };
}

let dbPromise: Promise<IDBPDatabase<SonaGrainDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<SonaGrainDB>('sonagrain-erp-offline', 2, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains('kv_cache')) {
          db.createObjectStore('kv_cache', { keyPath: 'key' });
        } else if (oldVersion < 2) {
          transaction.objectStore('kv_cache').clear();
        }
        if (!db.objectStoreNames.contains('mutation_queue')) {
          const store = db.createObjectStore('mutation_queue', { keyPath: 'client_uuid' });
          store.createIndex('by-status', 'status');
        }
      },
    });
  }
  return dbPromise;
}

export async function cacheSet(key: string, data: unknown): Promise<void> {
  try {
    const db = await getDb();
    await db.put('kv_cache', { key, data, updated_at: new Date().toISOString() });
  } catch {
    // Ignore IndexedDB errors in restricted iframe/private modes
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await getDb();
    const row = await db.get('kv_cache', key);
    return row ? (row.data as T) : null;
  } catch {
    return null;
  }
}

export async function enqueueMutation(mutation: OfflineMutation): Promise<void> {
  const db = await getDb();
  await db.put('mutation_queue', mutation);
}

export async function getQueuedMutations(): Promise<OfflineMutation[]> {
  try {
    const db = await getDb();
    const items = await db.getAll('mutation_queue');
    return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  } catch {
    return [];
  }
}

export async function updateMutation(mutation: OfflineMutation): Promise<void> {
  try {
    const db = await getDb();
    await db.put('mutation_queue', mutation);
  } catch {
    // ignore
  }
}

export async function removeMutation(clientUuid: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete('mutation_queue', clientUuid);
  } catch {
    // ignore
  }
}

export async function clearKvCache(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear('kv_cache');
  } catch {
    // ignore
  }
}

export async function clearOfflineStorage(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear('kv_cache');
    await db.clear('mutation_queue');
  } catch {
    // ignore
  }
}

