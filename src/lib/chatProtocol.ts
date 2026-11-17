/** Strict boundary for untrusted peer-to-peer data channel messages. */
export type PeerMessage = {
  id: string;
  timestamp: number;
  text?: string;
  imageUrl?: string;
};
export type PeerEvent =
  | { type: 'chat'; message: PeerMessage }
  | { type: 'typing'; isTyping: boolean }
  | { type: 'ack'; id: string }
  | { type: 'leave' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isUUID = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** Reject malformed, excessively large, and non-HTTPS image payloads. */
export function parsePeerEvent(raw: unknown): PeerEvent | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'leave': return { type: 'leave' };
    case 'typing':
      return typeof raw.isTyping === 'boolean'
        ? { type: 'typing', isTyping: raw.isTyping } : null;
    case 'ack':
      return isUUID(raw.id) ? { type: 'ack', id: raw.id } : null;
    case 'chat': {
      if (!isRecord(raw.message)) return null;
      const message = raw.message;
      if (!isUUID(message.id) || typeof message.timestamp !== 'number' ||
          !Number.isFinite(message.timestamp)) return null;
      const hasText = typeof message.text === 'string' && message.text.length > 0 &&
        message.text.length <= 4000;
      let safeImage: string | null = null;
      if (typeof message.imageUrl === 'string' && message.imageUrl.length <= 2048) {
        try {
          const url = new URL(message.imageUrl);
          if (url.protocol === 'https:') safeImage = url.href;
        } catch { /* invalid URL */ }
      }
      if (!hasText && !safeImage) return null;
      if (hasText && safeImage) return null;
      return {
        type: 'chat',
        message: {
          id: message.id,
          timestamp: message.timestamp,
          ...(hasText ? { text: message.text as string } : { imageUrl: safeImage! }),
        },
      };
    }
    default: return null;
  }
}
