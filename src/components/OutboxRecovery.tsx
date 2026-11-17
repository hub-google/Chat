'use client';

import { useEffect } from 'react';
import { getUserId } from '../lib/user';
import { getAllFromIDB } from '../lib/idb';
import { OUTBOX_QUEUED, retryOutbox } from '../lib/messageOutbox';

/** Active on every page: recovery must not stop when a chat closes. */
export function OutboxRecovery() {
  useEffect(() => {
    let disposed = false;
    let running = false;
    let currentUser: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, delay);
    };
    const flush = async () => {
      if (disposed || running) return;
      if (!navigator.onLine) {
        schedule(12000);
        return;
      }
      running = true;
      let retryDelay = 60000;
      try {
        currentUser ??= await getUserId();
        const pending = await getAllFromIDB();
        const ownPending = pending.some((msg) => msg.sender_id === currentUser);
        if (ownPending) {
          await retryOutbox(currentUser);
          retryDelay = 4000;
        }
      } catch (error) {
        console.warn('離線訊息補傳暫時失敗', error);
        retryDelay = 12000;
      } finally {
        running = false;
        schedule(retryDelay);
      }
    };
    const wake = () => schedule(0);
    const onVisibility = () => { if (document.visibilityState === 'visible') wake(); };
    window.addEventListener('online', wake);
    window.addEventListener(OUTBOX_QUEUED, wake);
    document.addEventListener('visibilitychange', onVisibility);
    wake();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', wake);
      window.removeEventListener(OUTBOX_QUEUED, wake);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return null;
}
