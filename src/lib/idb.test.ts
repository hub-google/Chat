import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveToIDB, type StoredChatMessage } from './idb';

describe('IndexedDB transaction durability', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not acknowledge a write until its transaction actually commits', async () => {
    const write: { onsuccess?: () => void; result?: unknown } = { result: undefined };
    const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void } = {};
    const close = vi.fn();
    const db = {
      close,
      objectStoreNames: { contains: () => true },
      transaction: vi.fn(() => Object.assign(tx, { objectStore: () => ({ put: () => write }) })),
    };
    const open: { onsuccess?: () => void; result: typeof db } = { result: db };
    vi.stubGlobal('indexedDB', {
      open: vi.fn(() => {
        queueMicrotask(() => open.onsuccess?.());
        return open;
      }),
    });
    const message: StoredChatMessage = { id: 'a', match_id: 'room', sender_id: 'user', content: 'hi', type: 'text' };
    let saved = false;
    const pending = saveToIDB(message).then(() => { saved = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    write.onsuccess?.();
    await Promise.resolve();
    expect(saved).toBe(false);
    expect(close).not.toHaveBeenCalled();
    tx.oncomplete?.();
    await pending;
    expect(saved).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects an aborted transaction rather than incorrectly reporting success', async () => {
    const write: { onsuccess?: () => void; result?: unknown } = { result: undefined };
    const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error?: Error } = { error: new Error('aborted') };
    const db = { close: vi.fn(), objectStoreNames: { contains: () => true },
      transaction: () => Object.assign(tx, { objectStore: () => ({ put: () => write }) }) };
    const open: { onsuccess?: () => void; result: typeof db } = { result: db };
    vi.stubGlobal('indexedDB', { open: () => { queueMicrotask(() => open.onsuccess?.()); return open; } });
    const pending = saveToIDB({ id: 'b', match_id: 'room', sender_id: 'user', content: 'hi', type: 'text' });
    // Attach the expectation before manually aborting to avoid unhandled rejections.
    const expectRejected = expect(pending).rejects.toThrow('aborted');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    write.onsuccess?.();
    tx.onabort?.();
    await expectRejected;
    expect(db.close).toHaveBeenCalledOnce();
  });
});
