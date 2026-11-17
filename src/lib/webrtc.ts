import { supabase } from './supabase';
import { getUserId } from './user';

type ConnectionState = 'open' | 'closed';
type SignalKind = 'offer' | 'answer';

/**
 * Tunnel signaling is deliberately HTTP-only. Each pair writes at most one
 * offer and one answer to its own match. Established DataChannels use P2P.
 */
export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private matchId: string | null = null;
  private handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private onMessage: (message: any) => void;
  private onConnectionState: (state: ConnectionState) => void;

  constructor(onMessage: (message: any) => void, onConnectionState: (state: ConnectionState) => void = () => {}) {
    this.onMessage = onMessage;
    this.onConnectionState = onConnectionState;
  }

  public async initConnection(matchId: string, isInitiator: boolean) {
    this.matchId = matchId;
    this.closing = false;
    const userId = await getUserId();
    if (this.closing) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.pc = pc;

    pc.onconnectionstatechange = () => {
      if (this.closing) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.onConnectionState('closed');
      }
    };

    if (isInitiator) {
      this.dataChannel = pc.createDataChannel('chat', { ordered: true });
      this.setupDataChannel();
    } else {
      pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };
    }

    this.handshakeTimeout = setTimeout(() => {
      if (!this.closing && this.dataChannel?.readyState !== 'open') {
        this.close();
        this.onConnectionState('closed');
      }
    }, 22000);

    try {
      if (isInitiator) {
        await pc.setLocalDescription(await pc.createOffer());
        await this.waitForIceGathering(pc);
        if (this.closing) return;
        await this.saveSignal(userId, 'offer', pc.localDescription!.toJSON());
        const answer = await this.waitForSignal(userId, 'answer');
        if (!answer || this.closing) return;
        await pc.setRemoteDescription(answer);
      } else {
        const offer = await this.waitForSignal(userId, 'offer');
        if (!offer || this.closing) return;
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());
        await this.waitForIceGathering(pc);
        if (this.closing) return;
        await this.saveSignal(userId, 'answer', pc.localDescription!.toJSON());
      }
    } catch (error) {
      if (!this.closing) {
        console.warn('HTTP WebRTC signaling failed', error);
        this.close();
        this.onConnectionState('closed');
      }
    }
  }

  private async waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const timeout = setTimeout(finish, 6500);
      pc.addEventListener('icegatheringstatechange', check);
      check();
    });
  }

  private async saveSignal(senderId: string, kind: SignalKind, sdp: RTCSessionDescriptionInit) {
    const { error } = await supabase.from('tunnel_webrtc_signals').upsert(
      { match_id: this.matchId, sender_id: senderId, kind, sdp },
      { onConflict: 'match_id,sender_id' },
    );
    if (error) throw new Error('無法交換 P2P 連線資料：' + error.message);
  }

  private async waitForSignal(userId: string, kind: SignalKind): Promise<RTCSessionDescriptionInit | null> {
    const deadline = Date.now() + 20000;
    while (!this.closing && Date.now() < deadline) {
      const { data, error } = await supabase
        .from('tunnel_webrtc_signals')
        .select('sdp')
        .eq('match_id', this.matchId!)
        .neq('sender_id', userId)
        .eq('kind', kind)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error('讀取 P2P 連線資料失敗：' + error.message);
      if (data?.sdp) return data.sdp as RTCSessionDescriptionInit;
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
    }
    if (!this.closing) {
      this.close();
      this.onConnectionState('closed');
    }
    return null;
  }

  private setupDataChannel() {
    if (!this.dataChannel) return;
    this.dataChannel.onopen = () => {
      if (this.closing) return;
      if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout);
      this.onConnectionState('open');
    };
    this.dataChannel.onmessage = (event) => {
      if (typeof event.data !== 'string' || event.data.length > 25000) return;
      try {
        const parsed = JSON.parse(event.data);
        if (parsed && typeof parsed === 'object') this.onMessage(parsed);
      } catch {
        console.warn('Dropped malformed P2P message');
      }
    };
    this.dataChannel.onclose = () => {
      if (!this.closing) this.onConnectionState('closed');
    };
  }

  public sendMessage(message: any): boolean {
    if (this.dataChannel?.readyState !== 'open') return false;
    try {
      this.dataChannel.send(JSON.stringify(message));
      return true;
    } catch {
      this.onConnectionState('closed');
      return false;
    }
  }

  public close() {
    if (this.closing) return;
    this.closing = true;
    if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout);
    this.dataChannel?.close();
    this.pc?.close();
    this.dataChannel = null;
    this.pc = null;
  }
}
