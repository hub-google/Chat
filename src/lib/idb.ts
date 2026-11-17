/**
 * Durable per-device message outbox.
 * Resolve writes only after the IndexedDB transaction commits.
 */
export interface StoredChatMessage {
  id: string;
  match_id: string;
  sender_id: string;
  content: string;
  type: 'text' | 'image';
}
export const IDB_STORE_NAME = 'failed_messages';
const DB_NAME = 'TunnelChatDB';

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error ?? new Error('Unable to open offline message storage'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    let result: T;
    let settled = false;
    const tx = db.transaction(IDB_STORE_NAME, mode);
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      db.close();
      if (error) reject(error);
      else resolve(result);
    };
    const request = operation(tx.objectStore(IDB_STORE_NAME));
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => finish();
    tx.onerror = () => finish(tx.error ?? new Error('Offline message transaction failed'));
    tx.onabort = () => finish(tx.error ?? new Error('Offline message transaction aborted'));
  }));
}

export async function saveToIDB(msg: StoredChatMessage): Promise<void> {
  await transact('readwrite', (store) => store.put(msg));
}

export function getAllFromIDB(): Promise<StoredChatMessage[]> {
  return transact('readonly', (store) => store.getAll() as IDBRequest<StoredChatMessage[]>);
}

export async function deleteFromIDB(id: string): Promise<void> {
  await transact('readwrite', (store) => store.delete(id));
}
