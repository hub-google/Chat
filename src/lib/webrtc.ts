import { useMatchStore } from '../store/matchStore';
import { supabase } from './supabase';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getUserId } from './user';

type ConnectionState = 'open' | 'closed';

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private channel: RealtimeChannel | null = null;
  private onMessage: (msg: any) => void;
  private matchId: string | null = null;
  private handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
  private isInitiator: boolean = false;
  private closing = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private onConnectionState: (state: ConnectionState) => void;
  
  constructor(onMessage: (msg: any) => void, onConnectionState: (state: ConnectionState) => void = () => {}) {
    this.onMessage = onMessage;
    this.onConnectionState = onConnectionState;
  }

  public async initConnection(matchId: string, isInitiator: boolean) {
    this.matchId = matchId;
    this.isInitiator = isInitiator;
    
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    if (this.isInitiator) {
      this.dataChannel = this.pc.createDataChannel('chat');
      this.setupDataChannel();
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };
    }

    this.channel = supabase.channel(`match_${matchId}`);
    
    this.channel.on('broadcast', { event: 'webrtc_signal' }, async (payload) => {
      if (!this.pc) return;
      const { sdp, ice, sender } = payload.payload;
      const userId = await getUserId();
      if (sender === userId) return; // ignore own signals

      try {
        if (payload.payload.type === 'ready' && this.isInitiator) {
          await this.sendOffer();
          return;
        }
        if (sdp) {
          await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
          for (const candidate of this.pendingIce.splice(0)) {
            await this.pc.addIceCandidate(candidate);
          }
        if (sdp.type === 'offer') {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.channel?.send({
            type: 'broadcast',
            event: 'webrtc_signal',
            payload: { sdp: this.pc.localDescription, sender: userId }
          });
        }
        } else if (ice) {
          if (this.pc.remoteDescription) await this.pc.addIceCandidate(ice);
          else this.pendingIce.push(ice);
        }
      } catch (error) {
        console.error('WebRTC signaling failed', error);
      }
    });

    this.channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED' && this.pc) {
        this.channel?.send({
          type: 'broadcast',
          event: 'webrtc_signal',
          payload: { type: 'ready', sender: await getUserId() }
        });
      }
    });

    this.pc.onicecandidate = async (event) => {
      if (event.candidate && this.channel) {
        this.channel.send({
          type: 'broadcast',
          event: 'webrtc_signal',
          payload: { ice: event.candidate.toJSON(), sender: await getUserId() }
        });
      }
    };

    // 8-second handshake timeout
    this.handshakeTimeout = setTimeout(() => {
      if (this.dataChannel?.readyState !== 'open') {
        this.close();
        this.onConnectionState('closed');
        console.warn('WebRTC handshake timed out; database fallback remains active.');
      }
    }, 8000);
  }

  private async sendOffer() {
    if (!this.pc || this.pc.signalingState !== 'stable') return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.channel?.send({
      type: 'broadcast',
      event: 'webrtc_signal',
      payload: { sdp: this.pc.localDescription, sender: await getUserId() },
    });
  }

  private setupDataChannel() {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout);
      useMatchStore.getState().setMatch(this.matchId as string);
      this.onConnectionState('open');
    };

    this.dataChannel.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed && typeof parsed === 'object') this.onMessage(parsed);
      } catch {
        console.warn('Dropped malformed WebRTC message');
      }
    };

    this.dataChannel.onclose = () => {
      if (!this.closing) {
        this.onConnectionState('closed');
      }
    };
  }

  public sendMessage(message: any) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(message));
    }
  }

  public close() {
    if (this.closing) return;
    this.closing = true;
    if (this.handshakeTimeout) clearTimeout(this.handshakeTimeout);
    if (this.dataChannel) this.dataChannel.close();
    if (this.pc) this.pc.close();
    if (this.channel) supabase.removeChannel(this.channel);

    this.dataChannel = null;
    this.pc = null;
    this.channel = null;
    this.pendingIce = [];
  }
}
