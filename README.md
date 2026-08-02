# Tunnel 匿名聊天

Next.js 16、Supabase Anonymous Auth / Realtime 與 WebRTC 組成的匿名一對一聊天應用。

## 本機啟動

1. 在 Supabase Dashboard 啟用 **Anonymous Sign-Ins**。
2. 於 SQL Editor 執行 `supabase_init.sql`。
3. 確認 Realtime publication 已包含 `matches` 與 `messages`。
4. 在 `.env` 設定：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_IMGBB_UPLOAD_URL=https://api.imgbb.com/1/upload
NEXT_PUBLIC_IMGBB_API_KEY=
```

5. 安裝依賴並執行：

```bash
npm install
npm run dev
```

管理員不是以前端密碼判定。請先讓管理員瀏覽器建立匿名帳號，再於可信任的 Supabase 管理介面將該使用者的 `profiles.role` 設為 `admin`。

## 驗證

```bash
npm run lint
npm run build
npx vitest run
```

此專案採靜態匯出，可交由 GitHub Pages 發布；發布流程不包含在此儲存庫操作說明中。
