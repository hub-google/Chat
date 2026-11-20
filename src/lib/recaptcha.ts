import { env } from './env';
import { supabase } from './supabase';

type CaptchaApi = {
  ready: (callback: () => void) => void;
  execute: (siteKey: string, params: { action: string }) => Promise<string>;
};
declare global {
  interface Window { grecaptcha?: CaptchaApi }
}

const ACTION = 'chat_match';
let loadPromise: Promise<CaptchaApi> | null = null;
let loadedSiteKey: string | null = null;
let passedUser: string | null = null;
let passedUntil = 0;

function googleCaptcha(siteKey: string): Promise<CaptchaApi> {
  // The public site key can be rotated in Supabase without rebuilding the site.
  // Never reuse an in-memory token loader for a different configured key.
  if (loadPromise && loadedSiteKey === siteKey) return loadPromise;
  loadedSiteKey = siteKey;
  loadPromise = new Promise<CaptchaApi>((resolve, reject) => {
    function ready() {
      const api = window.grecaptcha;
      if (!api) { reject(new Error('無法初始化 Google 人機驗證。')); return; }
      api.ready(() => resolve(api));
    }
    if (window.grecaptcha) { ready(); return; }
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
    script.async = true;
    script.defer = true;
    script.onload = ready;
    script.onerror = () => reject(new Error('Google 人機驗證載入失敗，請確認網路或廣告阻擋設定。'));
    document.head.appendChild(script);
  }).catch((error) => {
    loadPromise = null; // Allow retry after a temporary network outage.
    throw error;
  });
  return loadPromise;
}

// No human check on every rapid re-match: one verification is valid for twelve hours.
// The server, not this client cache, enforces validity and blocks direct RPC bypasses.
export async function ensureChatRecaptcha(userId: string): Promise<void> {
  if (passedUser === userId && Date.now() < passedUntil) return;

  const { data: state, error: statusError } = await supabase.rpc('tunnel_chat_recaptcha_status');
  if (statusError) throw new Error(`人機驗證狀態查詢失敗：${statusError.message}`);
  if (!state?.required) return;

  if (state.verified === true) {
    passedUser = userId;
    passedUntil = Date.now() + 10 * 60 * 1000; // Later confirm freshness with the server.
    return;
  }

  // Site keys are public; read from CHAT-only Supabase config, not GitHub Secrets.
  const siteKey = (typeof state.site_key === 'string' ? state.site_key : '') || env.RECAPTCHA_SITE_KEY;
  if (!siteKey) throw new Error('Google reCAPTCHA 尚未設定網站金鑰，暫時無法開始配對。');

  const api = await googleCaptcha(siteKey);
  const token = await api.execute(siteKey, { action: ACTION });
  if (!token) throw new Error('Google 人機驗證未完成，請重試。');

  // Supabase attaches the signed-in anonymous user's JWT; the Edge Function
  // independently verifies it and validates the one-use Google token.
  const { data, error } = await supabase.functions.invoke('chat-recaptcha-verify', {
    body: { token },
  });
  if (error || data?.verified !== true) {
    throw new Error('Google 人機驗證未通過，請稍後重試。');
  }
  passedUser = userId;
  passedUntil = Date.now() + 10 * 60 * 1000;
}
