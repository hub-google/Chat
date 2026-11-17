import { describe, it, expect } from 'vitest';
import { parsePeerEvent } from './chatProtocol';
const id = 'd5b0a6ed-b631-45a3-b990-22acd267367c';
describe('peer event validation', () => {
  it('accepts properly shaped chat messages', () => {
    expect(parsePeerEvent({ type: 'chat', message: { id, text: 'hello', timestamp: 10 } }))
      .toEqual({ type: 'chat', message: { id, text: 'hello', timestamp: 10 } });
  });
  it('rejects missing payloads rather than crashing the chat', () => {
    expect(parsePeerEvent({ type: 'chat' })).toBeNull();
    expect(parsePeerEvent({ type: 'chat', message: {} })).toBeNull();
    expect(parsePeerEvent([])).toBeNull();
    expect(parsePeerEvent(null)).toBeNull();
  });
  it('rejects payloads that exceed message limits', () => {
    expect(parsePeerEvent({ type: 'chat', message: { id, text: 'a'.repeat(4001), timestamp: 10 } })).toBeNull();
    expect(parsePeerEvent({ type: 'ack', id: 'malformed' })).toBeNull();
  });
  it('rejects insecure or unsupported image links', () => {
    expect(parsePeerEvent({ type: 'chat', message: { id, imageUrl: 'javascript:alert(1)', timestamp: 10 } })).toBeNull();
    expect(parsePeerEvent({ type: 'chat', message: { id, imageUrl: 'http://example.org/a.jpg', timestamp: 10 } })).toBeNull();
  });
  it('accepts HTTPS images and typing/leave events', () => {
    expect(parsePeerEvent({ type: 'chat', message: { id, imageUrl: 'https://i.ibb.co/p.png', timestamp: 10 } })?.type).toBe('chat');
    expect(parsePeerEvent({ type: 'typing', isTyping: true })).toEqual({ type: 'typing', isTyping: true });
    expect(parsePeerEvent({ type: 'leave' })).toEqual({ type: 'leave' });
  });
});
