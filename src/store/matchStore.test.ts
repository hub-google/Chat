import { describe, it, expect, beforeEach } from 'vitest';
import { useMatchStore } from './matchStore';

describe('MatchStore', () => {
  beforeEach(() => {
    useMatchStore.getState().reset();
  });

  it('initializes with idle status', () => {
    expect(useMatchStore.getState().status).toBe('idle');
    expect(useMatchStore.getState().matchId).toBeNull();
  });

  it('updates status to waiting when setStatus is called', () => {
    useMatchStore.getState().setStatus('waiting');
    expect(useMatchStore.getState().status).toBe('waiting');
  });

  it('updates status to chatting and sets matchId when setMatch is called', () => {
    const matchId = '123e4567-e89b-12d3-a456-426614174000';
    useMatchStore.getState().setMatch(matchId);
    
    expect(useMatchStore.getState().status).toBe('chatting');
    expect(useMatchStore.getState().matchId).toBe(matchId);
  });

  it('resets to idle state', () => {
    useMatchStore.getState().setMatch('123');
    useMatchStore.getState().reset();
    
    expect(useMatchStore.getState().status).toBe('idle');
    expect(useMatchStore.getState().matchId).toBeNull();
  });
});

describe('match-store hydration', () => {
  it('never restores a queue that has no matching heartbeat after reload', async () => {
    localStorage.setItem('tunnel-match-storage', JSON.stringify({
      state: { status: 'waiting', matchId: null, intent: 'venting', distanceMode: 'unlimited' },
      version: 0,
    }));
    await useMatchStore.persist.rehydrate();
    const state = useMatchStore.getState();
    expect(state.status).toBe('idle');
    expect(state.matchId).toBeNull();
    expect(state.intent).toBe('venting');
    useMatchStore.getState().reset();
  });

  it('restores a chatting room so it can be checked against the database', async () => {
    localStorage.setItem('tunnel-match-storage', JSON.stringify({
      state: { status: 'chatting', matchId: 'test-room-id', intent: 'chill' },
      version: 0,
    }));
    await useMatchStore.persist.rehydrate();
    expect(useMatchStore.getState().status).toBe('chatting');
    expect(useMatchStore.getState().matchId).toBe('test-room-id');
    useMatchStore.getState().reset();
  });
});
