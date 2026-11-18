import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WebRTCManager } from './webrtc';
import { supabase } from './supabase';
import { getUserId } from './user';

vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./user', () => ({ getUserId: vi.fn() }));

type Signal = {
  match_id: string; sender_id: string; kind: string;
  sdp: RTCSessionDescriptionInit; negotiation_id: string; created_at: string;
};
const signals: Signal[] = [];

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close() { this.readyState = 'closed'; this.onclose?.(); }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  readonly iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;
  channel: FakeDataChannel | null = null;
  constructor() { FakePeerConnection.instances.push(this); }
  createDataChannel() { this.channel = new FakeDataChannel(); return this.channel; }
  async createOffer() { return { type: 'offer' as const, sdp: 'test-offer' }; }
  async createAnswer() { return { type: 'answer' as const, sdp: 'test-answer' }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) {
    this.localDescription = { ...value, toJSON: () => value };
  }
  async setRemoteDescription(value: RTCSessionDescriptionInit) {
    this.remoteDescription = value;
  }
  addEventListener() {}
  removeEventListener() {}
  close() { this.connectionState = 'closed'; this.channel?.close(); }
}

function setupSignalingStore() {
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table !== 'tunnel_webrtc_signals') throw new Error('Unexpected table ' + table);
    const filters: Array<(signal: Signal) => boolean> = [];
    const query = {
      eq(column: string, value: unknown) {
        filters.push((row) => (row as unknown as Record<string, unknown>)[column] === value);
        return this;
      },
      neq(column: string, value: unknown) {
        filters.push((row) => (row as unknown as Record<string, unknown>)[column] !== value);
        return this;
      },
      limit() { return this; },
      async maybeSingle() {
        const found = signals.find((row) => filters.every((check) => check(row)));
        return { data: found ?? null, error: null };
      },
      then(resolve: (result: { error: null }) => unknown) {
        const index = signals.findIndex((row) => filters.every((check) => check(row)));
        if (index >= 0) signals.splice(index, 1);
        return Promise.resolve(resolve({ error: null }));
      },
    };
    return {
      upsert: async (row: Signal) => {
        const index = signals.findIndex((old) =>
          old.match_id === row.match_id && old.sender_id === row.sender_id);
        if (index >= 0) signals.splice(index, 1);
        signals.push(row);
        return { error: null };
      },
      select: () => query,
      delete: () => query,
    } as never;
  });
}

describe('HTTP WebRTC handshake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signals.length = 0;
    FakePeerConnection.instances.length = 0;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    setupSignalingStore();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('negotiates two distinct participants using a shared offer ID', async () => {
    vi.mocked(getUserId).mockResolvedValueOnce('user-a').mockResolvedValueOnce('user-b');
    const a = new WebRTCManager(vi.fn());
    const b = new WebRTCManager(vi.fn());
    try {
      await Promise.all([a.initConnection('match-1', true), b.initConnection('match-1', false)]);
      expect(FakePeerConnection.instances).toHaveLength(2);
      expect(FakePeerConnection.instances[0].remoteDescription?.type).toBe('answer');
      expect(FakePeerConnection.instances[1].remoteDescription?.type).toBe('offer');
      expect(signals.find((signal) => signal.kind === 'answer')?.negotiation_id)
        .toBe(signals.find((signal) => signal.kind === 'offer')?.negotiation_id);
    } finally {
      a.close(); b.close();
    }
  });

  it('accepts real chat-shaped messages but ignores malformed peer payloads', async () => {
    vi.mocked(getUserId).mockResolvedValue('user-a');
    const received = vi.fn();
    const manager = new WebRTCManager(received);
    try {
      // The local channel is installed as soon as the offer is created.
      const starting = manager.initConnection('match-2', true);
      await vi.waitFor(() => expect(FakePeerConnection.instances[0]?.channel).not.toBeNull());
      const channel = FakePeerConnection.instances[0].channel!;
      channel.onmessage?.({ data: JSON.stringify({ type: 'chat', message: { id: 'bad', text: '<script>', timestamp: 1 } }) } as MessageEvent);
      expect(received).not.toHaveBeenCalled();
      channel.onmessage?.({ data: JSON.stringify({ type: 'typing', isTyping: true }) } as MessageEvent);
      expect(received).toHaveBeenCalledWith({ type: 'typing', isTyping: true });
      manager.close();
      await starting;
    } finally { manager.close(); }
  });

  it('switches to fallback after denied or unavailable signaling', async () => {
    vi.mocked(getUserId).mockResolvedValue('user-a');
    vi.mocked(supabase.from).mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: { code: '42501', message: 'RLS denied' } }),
    } as never);
    const onState = vi.fn();
    const manager = new WebRTCManager(vi.fn(), onState);
    await manager.initConnection('match-3', true);
    expect(onState).toHaveBeenCalledWith('closed');
    manager.close();
  });
});
