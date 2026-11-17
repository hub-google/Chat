# Tunnel 匿名聊天

Next.js 16、Supabase Anonymous Auth / HTTP RPC、WebRTC DataChannel 與 PostgreSQL 組成的匿名一對一聊天應用。不依賴 Supabase Realtime。

## 本機啟動

1. 在 Supabase Dashboard 啟用 **Anonymous Sign-Ins**。
2. 於 SQL Editor 執行 `supabase_init.sql`。
3. 依序執行既有修復 SQL，最後執行 `scripts/tunnel_http_signaling.sql` 建立具有 RLS 的配對專用 WebRTC 訊號表；現有正式資料庫已套用新訊號表。
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

Google Drive 備份需要 repository secrets：`SUPABASE_SERVICE_KEY`、`GDRIVE_CREDENTIALS`（服務帳戶 JSON）、`GDRIVE_FOLDER_ID`，且目標資料夾須允許服務帳戶寫入。缺少任一項時停止，不刪除資料；只有雲端回傳大小與 checksum 符合的 500 筆以內訊息才會清除，聊天室紀錄保留以避免串聯刪除未備份的新訊息。


## 配對與聊天（無 Realtime）

- 進入配對池：每位等待者使用 `fn_match_user` 原子 RPC 配對，4～6 秒輪詢一次；多組可以同時配對，沒有固定每輪 200 組的人工限制。配對成功後立即退出等待池。
- 建立 P2P：每個新聊天室透過 `tunnel_webrtc_signals` 交換一次 Offer / Answer SDP，採 HTTP 短暫查詢，不占用 Realtime 連線額度。STUN 無法保證所有 NAT / 防火牆環境都能直接連線。
- 雙人聊天：連線成功後由 WebRTC DataChannel 直接傳訊，不經過配對伺服器。配對系統可繼續處理下一組，已開始的聊天室不會因其他人配對而中斷。
- 訊息儲存：每則文字或圖片 URL 發出時立即非同步寫入 Supabase `messages`；瀏覽器端 7 秒超時，失敗先保存在 IndexedDB，聊天期間每 4 秒重試，恢復網路時也會重試。正常網路以 10 秒內寫入為目標，斷網或資料庫故障時不能保證 10 秒。
- 備援：P2P 尚未連好或中斷時，聊天室用 HTTP 每 2 秒讀取新增訊息；P2P 正常時停止這個輪詢。管理接管及對方離開採每 5 秒檢查；管理員檢視對話每 3 秒更新，管理頁在線估計每 20 秒更新。
- 管理：訊息持續保存在 Supabase 供管理員查閱，並遵循既有 Google Drive 備份與清理設定。請確認備份排程與權限已正確設定。
- 容量：移除 Realtime 200 連線的瓶頸，不等於保證能支援 5,000 人同時排隊；大量配對 RPC、HTTP 訊號交換與訊息寫入仍受免費資料庫效能和流量限制，必須做壓測。

正式版由 `master` 部署 GitHub Pages，`main` 為修改測試分支，推送 `main` 時執行型別檢查、單元測試、Lint 與靜態建置。
