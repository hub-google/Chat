import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPanel } from './AdminPanel';
import { supabase } from '../lib/supabase';

vi.mock('../lib/user', () => ({ ensureUser: vi.fn().mockResolvedValue({ id: 'admin-test' }) }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));

describe('AdminPanel login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a password form without browser prompts and lets a failed login retry', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: false, error: null } as never);
    const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('prompt unsupported'); });
    render(<AdminPanel />);
    const password = await screen.findByLabelText('管理員密碼');
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.change(password, { target: { value: 'incorrect-test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登入管理後台' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('密碼錯誤');
    await waitFor(() => expect(screen.getByRole('button', { name: '登入管理後台' })).toBeEnabled());
    expect(supabase.rpc).toHaveBeenCalledWith('verify_admin_password', { p_password: 'incorrect-test-password' });
    prompt.mockRestore();
  });
});
