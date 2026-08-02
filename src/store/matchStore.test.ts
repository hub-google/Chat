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
