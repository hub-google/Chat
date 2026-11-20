import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureChatRecaptcha } from './recaptcha';
import { supabase } from './supabase';

vi.mock('./env', () => ({ env: { RECAPTCHA_SITE_KEY: 'test-google-site-key' } }));
vi.mock('./supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

describe('CHAT Google reCAPTCHA v3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.grecaptcha;
  });

  it('does not challenge when CHAT server enforcement is disabled', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { required: false, verified: false }, error: null } as never);
    await expect(ensureChatRecaptcha('off-user')).resolves.toBeUndefined();
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it('reuses a server-confirmed proof instead of challenging on each re-match', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { required: true, verified: true }, error: null } as never);
    await ensureChatRecaptcha('already-verified-user');
    await ensureChatRecaptcha('already-verified-user');
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it('requires a Google token and backend acknowledgement before allowing a new match', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { required: true, verified: false }, error: null } as never);
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { verified: true }, error: null } as never);
    const execute = vi.fn().mockResolvedValue('valid-recaptcha-test-token');
    window.grecaptcha = { ready: (fn) => fn(), execute };
    await ensureChatRecaptcha('new-captcha-user');
    expect(execute).toHaveBeenCalledWith('test-google-site-key', { action: 'chat_match' });
    expect(supabase.functions.invoke).toHaveBeenCalledWith('chat-recaptcha-verify', {
      body: { token: 'valid-recaptcha-test-token' },
    });
  });

  it('rejects failed Google/backend verification', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { required: true, verified: false }, error: null } as never);
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { verified: false }, error: null } as never);
    window.grecaptcha = { ready: (fn) => fn(), execute: vi.fn().mockResolvedValue('valid-recaptcha-test-token') };
    await expect(ensureChatRecaptcha('invalid-captcha-user')).rejects.toThrow('Google 人機驗證未通過');
  });
});
