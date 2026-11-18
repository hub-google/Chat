import { env } from './env';

type ImgBBResponse = {
  success?: boolean;
  error?: { message?: string };
  data?: { url?: string };
};

/** Single validated path for uploading an image; no secret credentials. */
export async function uploadImageBlob(blob: Blob, fileName: string): Promise<string> {
  if (!env.IMGBB_API_KEY) throw new Error('圖片空間金鑰尚未在建置環境中設定');
  const address = new URL(env.IMGBB_UPLOAD_URL || 'https://api.imgbb.com/1/upload');
  if (address.protocol !== 'https:') throw new Error('圖片上傳網址必須使用 HTTPS');
  address.searchParams.set('key', env.IMGBB_API_KEY);

  const form = new FormData();
  // Canvas always emits JPEG even if the original was HEIC, PNG, or WEBP.
  form.append('image', blob, fileName.replace(/\.[^.]+$/, '') + '.jpg');
  const response = await fetch(address.href, { method: 'POST', body: form });
  let payload: ImgBBResponse;
  try {
    payload = JSON.parse(await response.text()) as ImgBBResponse;
  } catch {
    throw new Error(`圖片服務回傳非 JSON 內容（HTTP ${response.status}）`);
  }
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error?.message || `圖片服務回傳 ${response.status}`);
  }
  if (!payload.data?.url) throw new Error('圖片服務未提供圖片網址');
  let imageUrl: URL;
  try {
    imageUrl = new URL(payload.data.url);
  } catch {
    throw new Error('圖片服務回傳無效圖片網址');
  }
  if (imageUrl.protocol !== 'https:') throw new Error('圖片服務回傳不安全的連結');
  return imageUrl.href;
}
