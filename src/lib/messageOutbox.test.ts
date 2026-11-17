import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from './supabase';
import { deleteFromIDB, getAllFromIDB, saveToIDB, type StoredChatMessage } from './idb';
import { retryOutbox, stageMessage, uploadStagedMessage } from './messageOutbox';

vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./idb', () => ({
  saveToIDB: vi.fn(),
  getAllFromIDB: vi.fn(),
  deleteFromIDB: vi.fn(),
}));

const message = (id: string, sender_id = 'person-a', match_id = 'room-a'): StoredChatMessage => ({
  id, sender_id, match_id, content: 'Hi', type: 'text',
});

describe('durable message outbox', () => {
  let request: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    request = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn().mockReturnValue({ abortSignal: request }),
    } as never);
    vi.mocked(saveToIDB).mockResolvedValue(undefined);
    vi.mocked(deleteFromIDB).mockResolvedValue(undefined);
    vi.mocked(getAllFromIDB).mockResolvedValue([]);
  });

  it('commits to the local outbox before the first network write', async () => {
    const order: string[] = [];
    vi.mocked(saveToIDB).mockImplementation(async () => { order.push('local'); });
    request.mockImplementation(async () => { order.push('remote'); return { error: null }; });
    const entry = message('local-first');
    await stageMessage(entry);
    expect(order).toEqual(['local']);
    await uploadStagedMessage(entry);
    expect(order).toEqual(['local', 'remote']);
    expect(deleteFromIDB).toHaveBeenCalledWith(entry.id);
  });

  it('does not transmit a message when offline persistence fails', async () => {
    vi.mocked(saveToIDB).mockRejectedValue(new Error('QuotaExceededError'));
    await expect(stageMessage(message('no-space'))).rejects.toThrow('QuotaExceededError');
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('treats the same UUID after an uncertain timeout as already saved', async () => {
    request.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });
    const entry = message('duplicate-after-timeout');
    expect((await uploadStagedMessage(entry)).status).toBe('saved');
    expect(deleteFromIDB).toHaveBeenCalledWith(entry.id);
  });

  it('retries pending messages from other rooms, but never another account', async () => {
    const a = message('cross-room-a', 'person-a', 'room-old');
    const b = message('cross-room-b', 'person-a', 'room-new');
    const other = message('cross-room-other', 'person-b', 'room-other');
    vi.mocked(getAllFromIDB).mockResolvedValue([a, b, other]);
    expect(await retryOutbox('person-a')).toBe(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(deleteFromIDB).toHaveBeenCalledWith(a.id);
    expect(deleteFromIDB).toHaveBeenCalledWith(b.id);
    expect(deleteFromIDB).not.toHaveBeenCalledWith(other.id);
  });

  it('preserves pending records on transient failures and recovers later', async () => {
    const entry = message('temporary-failure');
    request.mockResolvedValueOnce({ error: { code: 'ECONNRESET', message: 'network' } })
      .mockResolvedValueOnce({ error: null });
    expect((await uploadStagedMessage(entry)).status).toBe('pending');
    expect(deleteFromIDB).not.toHaveBeenCalled();
    vi.mocked(getAllFromIDB).mockResolvedValue([entry]);
    await retryOutbox(entry.sender_id);
    expect(deleteFromIDB).toHaveBeenCalledWith(entry.id);
  });

  it('does not hammer the database after an authorization rejection', async () => {
    const entry = message('permission-denied');
    request.mockResolvedValue({ error: { code: '42501', message: 'row-level security' } });
    expect((await uploadStagedMessage(entry)).status).toBe('blocked');
    vi.mocked(getAllFromIDB).mockResolvedValue([entry]);
    await retryOutbox(entry.sender_id);
    expect(request).toHaveBeenCalledTimes(1);
    expect(deleteFromIDB).not.toHaveBeenCalled();
  });
});
