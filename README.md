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

## 正式環境修正與驗證

既有安裝依序執行 `scripts/profile_privacy_fix.sql`、`scripts/matching_distance_fix.sql`、`scripts/chat_privilege_hardening.sql`。2026-11-02 已套用到正式專案；不需要重設管理員密碼。新安裝在初始化後也需套用這三份修正。

管理登入使用頁面表單，密碼由 `verify_admin_password` 在資料庫驗證。不要將密碼或 service role key 放進前端設定。

距離由雙方的約略座標計算。沒有定位時只允許「不限」配對；有限距離不會因等待時間而自動放寬。任一方未提供座標時顯示原因，不會編造公里數。IP 定位可能因 VPN 或服務狀況失準。

如需驗證正式資料庫，可在可信任環境執行 `node --env-file=.env scripts/smoke_chat.mjs`。此腳本建立三個臨時帳號，測試距離篩選、資料隔離、訊息與離開，再清理本次測試建立的資料；需要本機的 service role key，請勿把 `.env` 提交或上傳。
