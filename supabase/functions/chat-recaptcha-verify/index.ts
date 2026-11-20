import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.111.0";

const allowedOrigins = new Set([
  "https://hub-google.github.io",
  "https://chat.monsterport.com",
]);
const allowedHosts = new Set(["hub-google.github.io", "chat.monsterport.com"]);
const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function respond(status: number, payload: unknown, origin: string | null): Response {
  const headers: Record<string, string> = {
    ...jsonHeaders,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return new Response(JSON.stringify(payload), { status, headers });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return respond(403, { error: "Invalid origin" }, origin);
  if (req.method === "OPTIONS") return respond(200, {}, origin);
  if (req.method !== "POST") return respond(405, { error: "Method not allowed" }, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !serviceKey) {
    return respond(503, { error: "Google reCAPTCHA server configuration incomplete" }, origin);
  }
  const bearer = req.headers.get("authorization") ?? "";
  if (!bearer.startsWith("Bearer ")) return respond(401, { error: "Authentication required" }, origin);
  const jwt = bearer.slice(7);
  const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: userError } = await userClient.auth.getUser(jwt);
  if (userError || !user) return respond(401, { error: "Invalid user session" }, origin);

  let body: { token?: unknown };
  try { body = await req.json(); }
  catch { return respond(400, { error: "Invalid request body" }, origin); }
  if (typeof body.token !== "string" || body.token.length < 10 || body.token.length > 8192) {
    return respond(400, { error: "Invalid captcha token" }, origin);
  }

  try {
    // Fetch the encrypted Google secret from Supabase Vault, via a
    // service_role-only RPC. Never send the secret back to a browser.
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: storedSecret, error: vaultError } =
      await admin.rpc("tunnel_chat_recaptcha_get_secret");
    const recaptchaSecret = typeof storedSecret === "string" ? storedSecret
      : Deno.env.get("CHAT_RECAPTCHA_SECRET_KEY");
    if (vaultError || !recaptchaSecret) {
      return respond(503, { error: "Google reCAPTCHA server configuration incomplete" }, origin);
    }
    const result = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: recaptchaSecret, response: body.token }),
      signal: AbortSignal.timeout(7000),
    });
    if (!result.ok) return respond(502, { error: "Google verification unavailable" }, origin);
    const verification = await result.json() as {
      success?: boolean;
      score?: number;
      action?: string;
      hostname?: string;
    };

    // reCAPTCHA v3 requires an action, score and a Google-verified hostname.
    // A valid token for another website or action cannot be used for CHAT.
    if (!verification.success ||
        verification.action !== "chat_match" ||
        typeof verification.score !== "number" ||
        verification.score < 0.5 ||
        !verification.hostname ||
        !allowedHosts.has(verification.hostname)) {
      return respond(403, { error: "Human verification failed" }, origin);
    }

    const { error: saveError } = await admin.rpc("tunnel_chat_recaptcha_mark_verified", {
      p_user_id: user.id,
      p_score: verification.score,
      p_hostname: verification.hostname,
    });
    if (saveError) {
      console.error("CHAT reCAPTCHA proof storage failed", saveError.code ?? "database");
      return respond(503, { error: "Unable to save verification" }, origin);
    }
    return respond(200, { verified: true }, origin);
  } catch {
    return respond(502, { error: "Google verification temporarily unavailable" }, origin);
  }
});
