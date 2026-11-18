import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './env';
import { uploadImageBlob } from './imageUpload';

const blob = new Blob(['fake-image'], { type: 'image/jpeg' });
const mockReply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => typeof body === 'string' ? body : JSON.stringify(body),
});

describe('ImgBB upload contract', () => {
  const originalKey = env.IMGBB_API_KEY;
  beforeEach(() => {
    env.IMGBB_API_KEY = 'test-public-key';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    env.IMGBB_API_KEY = originalKey;
    vi.unstubAllGlobals();
  });

  it('uploads a JPEG filename and accepts only an HTTPS image URL', async () => {
    vi.mocked(fetch).mockResolvedValue(mockReply(200, { success: true, data: { url: 'https://i.ibb.co/image.jpg' } }) as Response);
    const url = await uploadImageBlob(blob, 'original.heic');
    expect(url).toBe('https://i.ibb.co/image.jpg');
    const [endpoint, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(endpoint)).toContain('key=test-public-key');
    expect((init?.body as FormData).get('image')).toBeInstanceOf(File);
    expect(((init?.body as FormData).get('image') as File).name).toBe('original.jpg');
  });

  it('reports missing keys without attempting an upload', async () => {
    env.IMGBB_API_KEY = '';
    await expect(uploadImageBlob(blob, 'test.png')).rejects.toThrow('金鑰');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads, failed responses and insecure image URLs', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockReply(200, '<html>error</html>') as Response)
      .mockResolvedValueOnce(mockReply(403, { success: false, error: { message: 'invalid key' } }) as Response)
      .mockResolvedValueOnce(mockReply(200, { success: true, data: { url: 'http://example.com/test.jpg' } }) as Response);
    await expect(uploadImageBlob(blob, 'x.png')).rejects.toThrow('非 JSON');
    await expect(uploadImageBlob(blob, 'x.png')).rejects.toThrow('invalid key');
    await expect(uploadImageBlob(blob, 'x.png')).rejects.toThrow('不安全');
  });
});
