import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureUser } from './user';
import { supabase } from './supabase';

vi.mock('./supabase', () => ({
  assertSupabaseConfigured: vi.fn(),
  supabase: {
    auth: {
      getUser: vi.fn(),
      getSession: vi.fn(),
      signInAnonymously: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

describe('ensureUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reuses an existing session', async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({
      data: { user: { id: 'existing-user' } },
      error: null,
    } as never);

    await expect(ensureUser()).resolves.toMatchObject({ id: 'existing-user' });
    expect(supabase.auth.signInAnonymously).not.toHaveBeenCalled();
  });

  it('creates an anonymous user when the session is missing', async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({
      data: { user: null },
      error: null,
    } as never);
    vi.mocked(supabase.auth.signInAnonymously).mockResolvedValue({
      data: { user: { id: 'anonymous-user' }, session: null },
      error: null,
    } as never);

    await expect(ensureUser()).resolves.toMatchObject({ id: 'anonymous-user' });
  });

  it('clears invalid session and creates anonymous user', async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({
      data: { user: null },
      error: { message: 'User deleted' },
    } as never);
    vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null } as never);
    vi.mocked(supabase.auth.signInAnonymously).mockResolvedValue({
      data: { user: { id: 'new-anonymous-user' }, session: null },
      error: null,
    } as never);

    await expect(ensureUser()).resolves.toMatchObject({ id: 'new-anonymous-user' });
    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(supabase.auth.signInAnonymously).toHaveBeenCalled();
  });

  it('shares one sign-in across concurrent callers', async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({ data: { user: null }, error: null } as never);
    vi.mocked(supabase.auth.signInAnonymously).mockResolvedValue({
      data: { user: { id: 'anonymous-user' }, session: null },
      error: null,
    } as never);

    const [first, second] = await Promise.all([ensureUser(), ensureUser()]);
    expect(first.id).toBe(second.id);
    expect(supabase.auth.signInAnonymously).toHaveBeenCalledTimes(1);
  });
});
