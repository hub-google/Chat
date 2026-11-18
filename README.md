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
`master`：正式網站 [chat.monsterport.com](https://chat.monsterport.com/)（Cloudflare Pages 靜態站）；既有 [GitHub Pages](https://hub-google.github.io/Chat/) 保留為舊入口，使用者會被導向正式網址。只在 `main` 驗證通過後更新。

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
- 資料庫封鎖由 `expires_at > now()` 即時判定，到期自動失效；Cloudflare 網站入口封鎖另使用每分鐘一筆 Supabase pg_cron 同步，沒有 Cloudflare Workers。被封鎖者的配對、訊息寫入和訊號交換受 RLS／RPC 阻擋；首頁有拒絕畫面，聊天中每 5 秒檢查權限並關閉 P2P 通道。

**網站入口限制：** 已在 Cloudflare 上建立 `chat.monsterport.com` 及專屬 WAF 規則，規則只影響 CHAT 網域。同步清單的 Postgres 函式與 1 分鐘 pg_cron 已設定，但**Cloudflare API Token 未提供前 WAF IP 清單不會隨後台變更更新**，後台會顯示同步狀態。GitHub Pages 與 Pages 原始 `*.pages.dev` 靜態 HTML 仍可取得；已加入客戶端導向正式網域，且 Supabase 後端持續阻止遭封鎖 IP 操作。不能以此宣稱原始靜態資產完全不可繞過。

## HTTP 控制流量優化與驗證

- `tunnel_room_control` 在單次資料庫 RPC 中檢查 IP 封鎖及房間狀態，不需每 5 秒發出兩筆 HTTP 請求；使用 SECURITY INVOKER 維持原有 RLS。
- `fn_match_user` 在查找配對對象前先鎖定自己的等待池紀錄，避免並發配對重複取走同一人。
- 新環境的 `supabase_init.sql` 已包含 IP／常見文字管理與聊天室控制 RPC；既有環境透過個別 migration 更新。
- 資料庫已完成 20 組配對、訊號交換、第三人拒絕讀取、P2P 失敗後的 HTTP 訊息備援、離開後補傳等回滾式驗證；尚未視為跨網路雙裝置壓測。
- 取消配對改由 `tunnel_cancel_matching` RPC 在同一交易中鎖定等待者、取消排隊及結束剛好同時成立的房間，避免產生孤立的聊天室。



## CHAT Cloudflare 靜態站與入口 WAF（2026-11-18）

- 正式域名：`https://chat.monsterport.com`；DNS 是橘雲代理 CNAME `monsterport-chat.pages.dev`，Pages 專案 `monsterport-chat` 由 GitHub `hub-google/Chat` 的 `master` 建置（Next.js `output: export`，無 Cloudflare Workers、Pages Functions）。
- WAF：Cloudflare 區域 `monsterport.com` 的 `http_request_firewall_custom`，只有一條 `(http.host eq "chat.monsterport.com" and ip.src in $chat_blocked_ips)` 規則；Cloudflare 帳戶的免費 IP list `chat_blocked_ips` 最多 10,000 筆。其他子網域不受影響。
- 私有同步：`scripts/tunnel_waf_sync.sql` 將 PostgreSQL `http` extension 安裝於 `private` schema；BAN／解 BAN 觸發 `private.tunnel_waf_sync()`，`tunnel-waf-expiry-sync` 每分鐘核對一次到期名單；使用 HTTPS 呼叫 Cloudflare List API。原始憑證只從 Supabase Vault 讀取，絕不交給瀏覽器。
- **尚待憑證啟用：** 在 Cloudflare 建立僅對本帳戶授權 **Account / Account Filter Lists / Edit** 的 API Token，登入 `https://chat.monsterport.com/admin/moderation/`，在後台的「Cloudflare API Token」密碼欄貼上並按「設定並驗證金鑰」。只有成功呼叫 Cloudflare IP List API 的 Token 才會被保留在 Supabase Vault，使用 `tunnel_admin_configure_waf_token` 守護；**不要把 Token 提交 GitHub、貼入聊天或放入前端建置環境**。缺金鑰時資料庫 BAN 仍生效，但 WAF 不會跟著更新。
- API Token 對應帳戶 ID `2374fd4a241005b20563b35af3bdc320`、清單 ID `debd9fd18dda49219c2b11cc56773c53`；只有 Cloudflare Account Filter Lists 的寫入權限是必要的，不需管理其他 WAF 規則或整個帳戶。
- Cloudflare Pages 由獨立環境建置；圖片上傳使用的公開 ImgBB API key 如未設定到此 Pages 專案，該站圖片上傳會不可用。不要把此欄位誤當成私有 API Token。
- 封鎖到期精度：Postgres RLS 即刻依到期時間放行；Cloudflare WAF 每分鐘更新，通常落後不到 1 分鐘，但網路失敗會造成更久延遲。管理後台顯示最後成功提交時間及錯誤。
