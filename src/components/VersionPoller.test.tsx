import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { VersionPoller } from './VersionPoller';
import { useMatchStore } from '../store/matchStore';

describe('VersionPoller', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); useMatchStore.getState().reset(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); useMatchStore.getState().reset(); });

  it('never checks for updates during an active P2P conversation', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    useMatchStore.getState().setMatch('active-room');
    const ui = render(<VersionPoller />);
    await vi.advanceTimersByTimeAsync(600000);
    expect(request).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('never checks for updates during matchmaking', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    useMatchStore.getState().setStatus('waiting');
    const ui = render(<VersionPoller />);
    await vi.advanceTimersByTimeAsync(300000);
    expect(request).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('checks only in the idle lobby and remembers the version', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => 'etag-initial' } });
    vi.stubGlobal('fetch', request);
    const ui = render(<VersionPoller />);
    await vi.advanceTimersByTimeAsync(300000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('app_etag')).toBe('etag-initial');
    ui.unmount();
  });
});
