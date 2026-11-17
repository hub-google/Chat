# Tunnel 匿名聊天

匿名一對一聊天：Next.js 靜態網站、Supabase Auth + 原子配對 RPC、WebRTC P2P 和 PostgreSQL 訊息保存。

## 架構

- 前端：GitHub Pages 靜態匯出。**不使用 Cloudflare Worker，也不使用 Supabase Realtime。**
- 配對：只有等待中的訪客使用 `fn_match_user` RPC 輪詢；每次能處理多組，成功配對者退出等待池。這不是固定每輪 200 組的排程。
- 訊號：`tunnel_webrtc_signals` 有 RLS 保護；以 `negotiation_id` 區分 WebRTC Offer/Answer，連線成功後清掉自己的訊號，避免重連時讀到舊資料。
- 聊天：連線成功後，訊息由 WebRTC DataChannel 直接傳給對方。無 TURN，因此部分網路環境可能無法直接連線。
- 備援：P2P 尚未建立或失敗時，已授權的聊天室透過 HTTP 查詢已保存訊息。
- **可靠保存：先完成 IndexedDB 交易，再傳給對方並立即非同步 INSERT Supabase。** 一則訊息使用固定 UUID；7 秒超時後保留本機資料並每 4 秒嘗試補傳。全站回復器在離開聊天室／重新開啟網站後仍會補傳相同匿名帳號的訊息。
- 離開聊天室：只有自願離開後 24 小時內，原本參與者才能補寫該聊天室訊息；被管理員終止或被接管者沒有此權限。若裝置清除瀏覽器資料、匿名身分丟失、網路長期故障或已超過權限期限，**不能保證回復所有訊息**。
- 管理員：可查詢資料庫對話、檢舉與進行接管；管理訊息由真正的管理員帳號寫入，禁止假冒一般使用者的 sender ID。
- 容量：不受 Supabase Realtime 200 條連線上限影響，但資料庫 CPU、I/O、免費額度與 P2P 成功率仍需經實際併發測試。

## 開發和部署

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

`main`：開發測試分支，僅跑驗證工作流程。  
`master`：正式網站 [GitHub Pages](https://hub-google.github.io/Chat/)，在 `main` 驗證後才更新。

Supabase 設定：開啟 Anonymous Sign-Ins，將 `NEXT_PUBLIC_SUPABASE_URL` 與 `NEXT_PUBLIC_SUPABASE_ANON_KEY` 設於環境變數。圖片功能需要 `NEXT_PUBLIC_IMGBB_API_KEY`，這是**公開前端金鑰**，請勿視為保密憑證，應注意服務配額與濫用風險。詳細設定參考 `.github/workflows/deploy.yml`。

### 資料庫

- 新專案只執行 `supabase_init.sql`（包含目前安全的配對、隱私政策、HTTP 訊號和訊息 Outbox 權限）。
- 已存在的 Tunnel 專案按部署歷史使用 `scripts/tunnel_http_signaling.sql`、`scripts/tunnel_durable_outbox.sql`；正式資料庫已套用相關變更。
- 既有專案另套用過 `scripts/tunnel_webrtc_negotiation.sql` 與 `scripts/tunnel_housekeeping.sql`（各有正式 migration 紀錄）。新安裝的主 SQL 已包含對應資料結構與清理函式；`pg_cron` 排程是選用的獨立設定。
- `scripts/legacy/` 僅保留早期修復紀錄供追溯，**不可把舊 SQL 當成當前建置步驟重新執行**。
- `scripts/smoke_chat.mjs` 可用於授權測試環境建立短暫帳號並驗證資料隔離，需 service role key；不應在正式環境隨意執行。

### 備份限制

`.github/workflows/backup.yml` 需設定 `SUPABASE_SERVICE_KEY`、`GDRIVE_CREDENTIALS`、`GDRIVE_FOLDER_ID`。目前歷史執行紀錄有因憑證缺失而失敗的情況；**未確認備份成功前不得視為有遠端備份**。該流程只在 Drive 校驗完成後才清理對應的資料庫訊息。管理後台不具備直接從 Drive 讀取已清理的歷史訊息功能。

目前程式與安全測試不能代替實際的雙裝置連線、網路斷線和大量同時在線壓力測試。
