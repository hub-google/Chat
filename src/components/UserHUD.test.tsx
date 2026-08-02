import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { UserHUD } from './UserHUD';
import { useMatchStore } from '../store/matchStore';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { supabase } from '../lib/supabase';
import * as fingerprint from '../lib/fingerprint';

// Mock Supabase
vi.mock('../lib/supabase', () => ({
  assertSupabaseConfigured: vi.fn(),
  supabase: {
    auth: {
      getUser: vi.fn(),
      getSession: vi.fn(),
      signInAnonymously: vi.fn(),
      signOut: vi.fn(),
    },
    rpc: vi.fn(),
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({}),
    }),
  },
}));

// Mock Device Fingerprint
vi.mock('../lib/fingerprint', () => ({
  generateDeviceFingerprint: vi.fn(),
}));

// Mock Geolocation
const mockGeolocation = {
  getCurrentPosition: vi.fn(),
};
Object.defineProperty(global.navigator, 'geolocation', {
  value: mockGeolocation,
  writable: true,
});

describe('UserHUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useMatchStore.getState().reset();
  });

  it('authenticates and calls rpc.fn_match_user when start button is clicked', async () => {
    // 1. Setup mocks
    (fingerprint.generateDeviceFingerprint as any).mockResolvedValue('mocked-fingerprint');
    (supabase.auth.getUser as any).mockResolvedValue({
      data: { user: { id: 'mock-user-123' } },
      error: null,
    });
    (supabase.rpc as any).mockResolvedValue({ data: [{ match_id: 'mock-match-456' }], error: null });
    
    // Mock geolocation to succeed immediately
    mockGeolocation.getCurrentPosition.mockImplementation((success) => 
      success({ coords: { latitude: 25.0, longitude: 121.5 } })
    );

    // 2. Render component
    render(<UserHUD />);

    // 3. Find and click the button
    const startButton = screen.getByText(/開始匿名配對/i);
    expect(startButton).toBeInTheDocument();
    
    fireEvent.click(startButton);

    // 4. Verify loading state appears
    expect(screen.getByText('獲取定位與安全指紋中...')).toBeInTheDocument();

    // 5. Verify the mocked functions were called correctly
    await waitFor(() => {
      expect(fingerprint.generateDeviceFingerprint).toHaveBeenCalled();
      expect(supabase.auth.getUser).toHaveBeenCalled();
      expect(mockGeolocation.getCurrentPosition).toHaveBeenCalled();
    });

    // 6. Verify RPC call for matching
    await waitFor(() => {
      expect(supabase.rpc).toHaveBeenCalledWith('fn_match_user', expect.objectContaining({
        p_user_id: 'mock-user-123',
        p_lat: 25.0,
        p_lng: 121.5,
      }));
    });
  });

  it('handles auth error gracefully if not authenticated', async () => {
    (fingerprint.generateDeviceFingerprint as any).mockResolvedValue('mocked-fingerprint');
    (supabase.auth.getUser as any).mockResolvedValue({ data: { user: null }, error: null });
    (supabase.auth.signInAnonymously as any).mockResolvedValue({
      data: { user: null },
      error: { message: 'Anonymous sign-ins are disabled' },
    });

    render(<UserHUD />);
    const startButton = screen.getByText(/開始匿名配對/i);
    fireEvent.click(startButton);

    // After failure, it should catch error, revert to idle state and show error message
    await waitFor(() => {
       expect(screen.getByText(/匿名登入失敗.*Anonymous sign-ins are disabled/i)).toBeInTheDocument();
       expect(screen.getByText(/開始匿名配對/i)).toBeInTheDocument();
    });
  });

  it('prevents matching if user cancels while getting geolocation', async () => {
    (fingerprint.generateDeviceFingerprint as any).mockResolvedValue('mocked-fingerprint');
    (supabase.auth.getUser as any).mockResolvedValue({
      data: { user: { id: 'mock-user-123' } },
      error: null,
    });
    
    // Hold geolocation promise to simulate delay
    let resolveGeo: any;
    mockGeolocation.getCurrentPosition.mockImplementation((success) => {
      resolveGeo = success;
    });

    render(<UserHUD />);
    
    // 1. Click Start
    fireEvent.click(screen.getByText(/開始匿名配對/i));
    
    // 2. Wait for loading state (getting location)
    await waitFor(() => {
      expect(screen.getByText('獲取定位與安全指紋中...')).toBeInTheDocument();
    });

    // 3. Click Cancel while geo is pending
    const cancelButton = screen.getByText(/取消搜尋/i);
    fireEvent.click(cancelButton);

    // 4. Verify we are back to idle
    await waitFor(() => {
      expect(screen.getByText(/開始匿名配對/i)).toBeInTheDocument();
    });

    // 5. Now resolve the geolocation
    resolveGeo({ coords: { latitude: 25.0, longitude: 121.5 } });

    // Wait a bit to ensure the async continuation has time to run (and hopefully fail/abort)
    await new Promise(r => setTimeout(r, 100));

    // 6. Verify that rpc was NEVER called because we cancelled
    expect(supabase.rpc).not.toHaveBeenCalledWith('fn_match_user', expect.anything());
  });
});
