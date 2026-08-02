export const env = {
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  IMGBB_UPLOAD_URL: process.env.NEXT_PUBLIC_IMGBB_UPLOAD_URL || 'https://api.imgbb.com/1/upload',
  IMGBB_API_KEY: process.env.NEXT_PUBLIC_IMGBB_API_KEY || '',
  RECAPTCHA_SITE_KEY: process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || '',
};

export function getPublicEnvError(): string | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return '缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY。';
  }

  try {
    const url = new URL(env.SUPABASE_URL);
    if (url.protocol !== 'https:') return 'Supabase URL 必須使用 HTTPS。';
  } catch {
    return 'NEXT_PUBLIC_SUPABASE_URL 格式不正確。';
  }

  return null;
}
