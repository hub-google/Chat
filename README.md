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
- 管理員：可查詢資料庫對話、檢舉與進行接管；管理訊息由真正的管理員帳號寫入，禁止假冒一般使用者的 sender ID。一般使用者不能自行修改 `role`、`admin_until`、`reputation_score`。
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
- 既有專案另套用過 `scripts/tunnel_webrtc_negotiation.sql`、`scripts/tunnel_housekeeping.sql`、`scripts/tunnel_profile_column_privileges.sql`（各有正式 migration 紀錄）。新安裝的主 SQL 已包含對應資料結構與清理函式；`pg_cron` 排程是選用的獨立設定。
- `scripts/legacy/` 僅保留早期修復紀錄供追溯，**不可把舊 SQL 當成當前建置步驟重新執行**。
- `scripts/smoke_chat.mjs` 可用於授權測試環境建立短暫帳號並驗證資料隔離，需 service role key；不應在正式環境隨意執行。

### 備份限制

`.github/workflows/backup.yml` 需設定 `SUPABASE_SERVICE_KEY`、`GDRIVE_CREDENTIALS`、`GDRIVE_FOLDER_ID`。目前歷史執行紀錄有因憑證缺失而失敗的情況；**未確認備份成功前不得視為有遠端備份**。流程改為**校驗 Drive 檔案後，只更新 Supabase 訊息的 `backup_verified_at` 欄位，不刪除任何原始訊息**，確保管理後台仍能讀取原對話。每輪最多備份 500 則尚未完成備份的舊訊息；未設定憑證時保留資料並明確報錯。

目前程式與安全測試不能代替實際的雙裝置連線、網路斷線和大量同時在線壓力測試。

## 2026-11-17 進一步修正

- 使用者封鎖由 `tunnel_admin_ban_user` 原子 RPC 執行；封鎖時同步關閉進行中的對話與等待佇列。既有正式資料庫的 `profiles_status_check` 已納入 `banned`，與主 SQL 定義一致。
- 管理員「結束接管」改為實際終止聊天室，避免後台畫面結束但資料庫仍保持接管狀態。
- 重整配對頁不會還原不可恢復的 `waiting` 狀態；進行中聊天室依既有 ID 驗證後恢復。
- 管理後台的檢舉數現在依統計期間篩選。

## 2026-11-17 回歸檢查（追加）

- 升級檢查只在使用者回到閒置大廳時讀取 ETag，絕不因站台部署強制刷新正在配對或聊天的使用者；更新前先記錄新版 ETag，避免無限刷新。
- 為同一 GitHub Pages 主機上的不同專案隔離瀏覽器儲存鍵名；舊版 `match-storage` 內符合 Tunnel 格式的會話會自動轉存到 `tunnel-match-storage`，保留進行中的聊天室。
- WebRTC DataChannel 接收器只接受驗證過的聊天、輸入中、回執與離開事件，不處理未定義的訊息結構或非 HTTPS 圖片網址。
- 管理員封鎖帳號與終止場次已在資料庫交易中測試；拒絕非管理員執行，測試資料全數回滾。
- GitHub Actions 自動執行型別檢查、單元測試、Lint 與 Next.js 靜態建置；此驗收不等於大量真實使用者壓測。


## 管理後台：重複文字與 IP 管制（2026-11-17）

- 網頁入口：`/admin/moderation`，登入後可使用（僅 `public.is_admin()` 授權的管理員）。
- 最常見的文字：依最近 1、6、24 小時統計，合併連續空白與首尾空白，列出前 100 名、訊息數、發言人數、已知 IP 數。
- 點開文字：查看當時來源 IP、國家、行政區／城市、裝置及瀏覽器、發言次數；也可單獨輸入 IPv4／IPv6。
- 封鎖：單一 IP 或該句話所有已知來源 IP。可選 5 分鐘、30 分鐘、1／6／24 小時、7／30 天、1 年、10 年。管理員自己的目前來源 IP 不會被批次封鎖。封鎖延長或提早解除皆在私有資料表留下紀錄。
- 資料庫部署：執行 `scripts/tunnel_phrase_ip_moderation.sql`（已套用到現有 Supabase 專案，請勿重複套用於其他共用專案）。只有受權限保護的 RPC 可以查詢與修改 IP 黑名單。
- 每則新訊息由 PostgreSQL trigger 記錄 PostgREST 轉送的來源 IP 快照；早期訊息因沒有快照，僅能使用個人資料中最近一次 IP 推估。IP 地點可能不精準到區，裝置／瀏覽器可被用戶端偽造，勿作為唯一處罰證據。
- 期限由資料庫 `expires_at > now()` 判定，自動失效，不用 Workers、Cron 或額外輪詢。被封鎖者的配對、訊息寫入和訊號交換受 RLS／RPC 阻擋；首頁有拒絕畫面，聊天中每 5 秒檢查權限並關閉 P2P 通道。

**網站入口限制：** 目前正式網站為 GitHub Pages，並非 Cloudflare 代理的 CHAT 網域，因此 SQL 封鎖**不能**在 HTTP 入口拒絕訪客取得靜態 HTML，也無法封鎖訪客直接存取 `github.io`。要達成真正的網路層封鎖，必須先將正式 CHAT 網址連至 Cloudflare 代理，再透過安全後端將封鎖清單同步到限定 CHAT 網域的 WAF 自訂規則；絕不可把 Cloudflare API token 放在前端。此部分**尚未啟用**，後台會明示目前是資料庫封鎖。
