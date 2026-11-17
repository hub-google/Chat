/**
 * One write path for the entire application. Every message is committed to
 * IndexedDB before it can be sent to another peer or uploaded to Supabase.
 * Retries use the original UUID, making uncertain HTTP timeouts idempotent.
 */
import { supabase } from './supabase';
import { deleteFromIDB, getAllFromIDB, saveToIDB, type StoredChatMessage } from './idb';

export const OUTBOX_UPDATED = 'tunnel-outbox-updated';
export const OUTBOX_QUEUED = 'tunnel-outbox-queued';
export type OutboxStatus = 'saved' | 'pending' | 'blocked';
export type OutboxResult = { status: OutboxStatus; error?: string };
type OutboxUpdate = OutboxResult & { id: string };
const activeUploads = new Map<string, Promise<OutboxResult>>();
const permissionBlocked = new Set<string>();

function announce(id: string, result: OutboxResult): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<OutboxUpdate>(OUTBOX_UPDATED, {
      detail: { id, ...result },
    }));
  }
}

export async function stageMessage(message: StoredChatMessage): Promise<void> {
  if (!message.id || !message.match_id || !message.sender_id || !message.content) {
    throw new Error('訊息資料不完整，無法安全暫存');
  }
  await saveToIDB(message);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OUTBOX_QUEUED));
}

async function uploadOnce(message: StoredChatMessage): Promise<OutboxResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  let error: { code?: string; message: string } | null = null;
  try {
    const response = await supabase
      .from('messages')
      .insert(message)
      .abortSignal(controller.signal);
    error = response.error;
  } catch (cause) {
    error = { message: cause instanceof Error ? cause.message : '資料庫連線中斷' };
  } finally {
    clearTimeout(timeout);
  }

  // A 23505 on this stable UUID means an earlier timed-out request committed.
  if (!error || error.code === '23505') {
    try {
      await deleteFromIDB(message.id);
      permissionBlocked.delete(message.id);
      const result: OutboxResult = { status: 'saved' };
      announce(message.id, result);
      return result;
    } catch {
      // Keep the local item; a future retry will observe the same UUID.
      const result: OutboxResult = { status: 'pending', error: '雲端已儲存，本機清理暫時失敗' };
      announce(message.id, result);
      return result;
    }
  }

  const rejected = error.code === '42501' || /permission denied|row.level security|not authorized/i.test(error.message);
  if (rejected) permissionBlocked.add(message.id);
  const result: OutboxResult = {
    status: rejected ? 'blocked' : 'pending',
    error: rejected ? '資料庫拒絕補傳，已保留本機紀錄' : '雲端儲存未完成，會自動重試',
  };
  announce(message.id, result);
  return result;
}

export function uploadStagedMessage(message: StoredChatMessage): Promise<OutboxResult> {
  const existing = activeUploads.get(message.id);
  if (existing) return existing;
  if (permissionBlocked.has(message.id)) {
    return Promise.resolve({ status: 'blocked', error: '資料庫拒絕補傳，已保留本機紀錄' });
  }
  const task = uploadOnce(message);
  activeUploads.set(message.id, task);
  void task.then(
    () => { if (activeUploads.get(message.id) === task) activeUploads.delete(message.id); },
    () => { if (activeUploads.get(message.id) === task) activeUploads.delete(message.id); },
  );
  return task;
}

/** Replays all rooms, never other accounts' messages. */
export async function retryOutbox(userId: string): Promise<number> {
  if (!userId) return 0;
  const pending = await getAllFromIDB();
  const own = pending.filter((msg) => msg.sender_id === userId);
  for (const message of own) {
    if (permissionBlocked.has(message.id)) continue;
    if (typeof navigator !== 'undefined' && !navigator.onLine) break;
    await uploadStagedMessage(message);
  }
  return own.length;
}
