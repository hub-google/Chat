import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type MatchStatus = 'idle' | 'waiting' | 'matched' | 'chatting' | 'ended';
type Intent = 'venting' | 'stimulation' | 'chill';
export type DistanceMode = 'nearest' | 'farthest' | 'unlimited';

interface MatchState {
  status: MatchStatus;
  matchId: string | null;
  intent: Intent;
  distanceMode: DistanceMode;
  distanceKm: number;
  openingMessage: string;
  setStatus: (status: MatchStatus) => void;
  setMatch: (matchId: string) => void;
  setIntent: (intent: Intent) => void;
  setDistanceMode: (mode: DistanceMode) => void;
  setDistanceKm: (km: number) => void;
  setOpeningMessage: (msg: string) => void;
  reset: () => void;
  syncFromChannel: (state: Partial<MatchState>) => void;
}

const channel = typeof window !== 'undefined' && 'BroadcastChannel' in window
  ? new BroadcastChannel('tunnel_sync')
  : null;

export const useMatchStore = create<MatchState>()(
  persist(
    (set) => {
  if (channel) {
    channel.onmessage = (event) => {
      // Avoid infinite loops by using a direct set without broadcasting
      set((state) => ({ ...state, ...event.data }));
    };
  }

  const broadcastAndSet = (update: Partial<MatchState>) => {
    set((state) => {
      const newState = { ...state, ...update };
      if (channel) {
        channel.postMessage(update);
      }
      return newState;
    });
  };

  return {
    status: 'idle',
    matchId: null,
    intent: 'chill',
    distanceMode: 'nearest',
    distanceKm: 5,
    openingMessage: '',
    setStatus: (status) => broadcastAndSet({ status }),
    setMatch: (matchId) => broadcastAndSet({ matchId, status: 'chatting' }),
    setIntent: (intent) => broadcastAndSet({ intent }),
    setDistanceMode: (mode) => broadcastAndSet({ distanceMode: mode }),
    setDistanceKm: (km) => broadcastAndSet({ distanceKm: km }),
    setOpeningMessage: (msg) => broadcastAndSet({ openingMessage: msg }),
    reset: () => broadcastAndSet({ status: 'idle', matchId: null }),
    syncFromChannel: (state) => set((s) => ({ ...s, ...state })), // for internal sync
  };
    },
    {
      name: 'tunnel-match-storage',
      // A waiting room cannot survive reload: the in-memory matching parameters
      // and heartbeat are gone, so a persisted 'waiting' state would hang forever.
      // A live chatting matchId is still restored and validated by ChatWindow.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<MatchState> | undefined) };
        if (merged.status === 'waiting' || merged.status === 'matched' ||
            merged.status === 'ended' || (merged.status === 'chatting' && !merged.matchId)) {
          return { ...merged, status: 'idle' as const, matchId: null };
        }
        return merged;
      },
    }
  )
);
