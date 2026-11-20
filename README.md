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

`main`：測試分支，自動部署到 [GitHub Pages](https://hub-google.github.io/Chat/)；不會導向 Cloudflare。  
`release`：正式分支，只有更新此分支才觸發 [Cloudflare Pages](https://chat.monsterport.com/) 正式部署。  
`master`：舊分支，已不再作為 Cloudflare 正式部署來源；不要再將變更部署到此分支。  
這兩個網站都是 Next.js 靜態輸出，不使用 Cloudflare Workers。

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

- 使用者封鎖由 `tunnel_admin_ban_user` 原子 RPC 執行；封鎖時同步關閉進行中的對話與等待佇列。**2026-11-20 起改為私有帳號隱性限制表，不再把 `profiles.status='banned'` 當成封鎖依據，請以最新章節為準。**
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
- IP 封鎖由 `expires_at > now()` 即時判定，到期自動失效；配對被限制時仍顯示正常等待頁，不出現入口拒絕畫面。聊天室每 5 秒檢查連線狀態，必要時以一般連線中斷訊息關閉 P2P。

**網站入口限制：** 原 Cloudflare CHAT 專用封鎖 WAF 規則已停用（2026-11-20 透過 Cloudflare API 再次確認 `enabled=false`）；現行限制由 Supabase 後端配對 RPC 執行，網頁入口不因 CHAT 帳號／IP 封鎖而拒絕存取。

## HTTP 控制流量優化與驗證

- `tunnel_room_control` 在單次資料庫 RPC 中檢查 IP 封鎖及房間狀態，不需每 5 秒發出兩筆 HTTP 請求；使用 SECURITY INVOKER 維持原有 RLS。
- `fn_match_user` 在查找配對對象前先鎖定自己的等待池紀錄，避免並發配對重複取走同一人。
- 新環境的 `supabase_init.sql` 已包含 IP／常見文字管理與聊天室控制 RPC；既有環境透過個別 migration 更新。
- 資料庫已完成 20 組配對、訊號交換、第三人拒絕讀取、P2P 失敗後的 HTTP 訊息備援、離開後補傳等回滾式驗證；尚未視為跨網路雙裝置壓測。
- 取消配對改由 `tunnel_cancel_matching` RPC 在同一交易中鎖定等待者、取消排隊及結束剛好同時成立的房間，避免產生孤立的聊天室。



## CHAT Cloudflare 靜態站與入口 WAF（2026-11-18）

- 正式域名：`https://chat.monsterport.com`；DNS 是橘雲代理 CNAME `monsterport-chat.pages.dev`，Pages 專案 `monsterport-chat` 只由 GitHub `hub-google/Chat` 的 `release` 正式分支建置（Next.js `output: export`，無 Cloudflare Workers、Pages Functions）。
- WAF（歷史設計）：`(http.host eq "chat.monsterport.com" and ip.src in $chat_blocked_ips)` 規則已停用，避免顯示 CHAT 專用封鎖頁。
- `scripts/tunnel_waf_sync.sql` 僅保留為歷史紀錄；2026-11-19 的 `scripts/tunnel_shadow_ip_matching.sql` 已移除 WAF 同步觸發器並停用對應 pg_cron。**不得重新啟動入口硬封鎖。**
- 現行隱性配對限制不需要 Cloudflare WAF API Token；管理員在 CHAT 後台封鎖 IP 即由資料庫立即生效。
- 如需恢復傳統入口封鎖，須先重新審查產品規格；**目前禁止為 CHAT 重新啟用硬封鎖**。
- Cloudflare Pages 由獨立環境建置；圖片上傳使用的公開 ImgBB API key 如未設定到此 Pages 專案，該站圖片上傳會不可用。不要把此欄位誤當成私有 API Token。
- IP 限制到期由 PostgreSQL 即時判定，不受 Cloudflare 同步狀態影響。


## 2026-11-18 部署規範（以此為準）

- 只更新 `main`：GitHub Pages 測試站 `https://hub-google.github.io/Chat/`，不會變更 Cloudflare 正式站。
- 只有合併至 `release` 才會更新 `https://chat.monsterport.com/`，Cloudflare 專案的 production branch 已調為 `release`，preview deployments 關閉。
- GitHub Actions `.github/workflows/deploy.yml` 僅在 `main` push 觸發，並在部署後測試管理後台路由；`.github/workflows/verify.yml` 驗證 `main` 及要合併進 `release` 的 PR。
- `main` 已移除從 GitHub Pages 強制跳轉 Cloudflare 的程式，測試站可以直接瀏覽。


## 2026-11-19 IP 隱性配對限制（取代舊的入口硬封鎖）

- 管理員的「IP 封鎖」現在是 **隱性配對限制**：被限制者可以進入網站、操作配對、看到正常等待畫面，但 `fn_match_user` 只回傳一般等待結果，不會建立配對，也不會進入可被其他人選中的等待池。
- 伺服器以 Supabase 請求來源 IP 判定，並維護私有的配對來源 IP 記錄；已被限制的等待名單會在管理員封鎖時清理。若使用者變更網路 IP，須另行封鎖新 IP。
- 此封鎖不發送「已封鎖」錯誤或通知；已在聊天中的連線中斷只顯示一般網路訊息。直接使用 API 的技術性探測仍可能觀察到限制，不能承諾絕對無法察覺。
- 既有 Cloudflare CHAT 專用 IP 拒絕規則已停用，WAF 同步觸發器及排程停止，避免被封鎖者在網站入口看到明確阻擋。一般 Cloudflare 安全防護不受影響。
- 已有 Supabase 專案套用 `scripts/tunnel_shadow_ip_matching.sql`；新環境請先執行 `supabase_init.sql` 再套用該 migration。
- 此規則只在指定期限內生效；到期或管理員解封後恢復正常配對。測試分支 main 與 release 仍須按既定流程分別發布。


## Google reCAPTCHA v3 - CHAT 配對驗證（2026-11-20）

這個專案沿用 Google reCAPTCHA，不使用 Cloudflare Turnstile。Supabase Auth 並不原生支援 Google reCAPTCHA，所以 CHAT 透過獨立的 Supabase Edge Function 驗證 Google Token，再由 `fn_match_user` **後端**檢查是否具有有效憑證。此限制只影響 CHAT 配對，不改變其他共用 Supabase 網站的登入流程。

1. 在 Google reCAPTCHA v3 控制台找到既有網站金鑰／私密金鑰，確認授權的網域包括 `hub-google.github.io` 與 `chat.monsterport.com`。僅 v3 分數型金鑰可直接使用此版本（不支援 v2 或 Enterprise-only API 格式）。
2. **公開網站金鑰**：直接存放在 `private.tunnel_recaptcha_config.site_key`，前端從登入後的 `tunnel_chat_recaptcha_status` 取得，**不需要再設定 GitHub Secrets 或 Cloudflare Pages 環境變數**。
3. **Google 私密金鑰**：透過已授權的 Supabase SQL 工具使用 `vault.create_secret(..., 'chat_recaptcha_secret_key', ...)` 直接寫入加密 Vault；Edge Function 透過限定 `service_role` 才能執行的 `tunnel_chat_recaptcha_get_secret` 讀取，不公開、不提交 GitHub。舊有 Edge Function 環境變數仍可作為備援。
4. **驗收後才開啟**：在 Supabase SQL Editor 執行 `UPDATE private.tunnel_recaptcha_config SET enabled=true WHERE singleton;`。未設定金鑰或未驗收時請保持 `enabled=false`，否則會阻斷所有正常使用者配對。要停用只改成 `enabled=false`，不須更動其他專案。
5. `scripts/tunnel_lock_down_direct_queue_writes.sql` 將一般使用者對 `matching_pool` 的直接 INSERT／UPDATE 權限關閉，只有後端原子配對 RPC 能寫入等待名單，避免腳本繞過 CAPTCHA。一般使用者仍可查詢或取消自己的等待紀錄。
6. 初次配對背景執行 Google 驗證，成功後通行 12 小時；短時間快速換人不會每次重新做人機驗證。配對 API 對缺少有效後端憑證者直接拒絕，繞過網頁也無法配對。

安全界限：原生匿名帳號建立仍由 Supabase Auth 執行，**這項 Google 防護保護 CHAT 配對，不阻止直接建立匿名帳號**。如果後續需要限制匿名註冊量，要另採共享 Auth 專案相容的防護機制，不應直接全域啟用或覆蓋 Supabase Auth Hook。已有 IP 隱性封鎖優先於 reCAPTCHA 檢查，仍回傳普通等待結果，避免暴露封鎖狀態。

### Vault 設定方式

對現有 Supabase 套用 `scripts/tunnel_recaptcha_vault_configuration.sql`（已套用）。已授權工具可將 Google v3 金鑰直接安全寫入 Supabase Vault，無需 GitHub Actions Secret 寫入權限。Google reCAPTCHA 管理台必須確認金鑰類型為 v3（若為 Enterprise-only 金鑰，必須另行改用 Enterprise Assessments API）。

2026-11-20 已確認 Google 網站金鑰存在、私密金鑰儲存在 Supabase Vault、`chat-recaptcha-verify` Edge Function 已部署；全站 `enabled=false`，測試帳號需先通過實際驗收才能全面啟用。絕不可顯示或提交私密金鑰。


## 2026-11-20 帳號／IP 一致的隱性配對限制（最新規則）

- **一律 Shadow Ban**：遭帳號限制、手動 IP 限制、或重複文字批次 IP 限制者均可正常進入網站、編輯大廳資料並按「開始配對」，只看到一般等待畫面；後端 `fn_match_user` 回傳普通無配對結果，且不建立有效等待池紀錄，其他真人也不會選到受限制者。使用者沒有「封鎖」通知或入口封鎖頁。
- **帳號限制已改用後端私有表** `private.tunnel_account_bans`，不再依賴可被用戶端更新的 `profiles.status`。管理員 `tunnel_admin_ban_user` 將帳號寫入私有表，清除等待池並以普通 `user_left` 原因終止進行中的聊天室；對外個人狀態不顯示 `banned`。解除帳號限制可使用管理員 RPC `tunnel_admin_unban_user`，不能由一般使用者直接呼叫。
- `public.is_banned()` 現在會同時判定私有帳號限制及 IP 限制，保留既有 RLS 與聊天連線管制。被限制者 `tunnel_chat_recaptcha_status` 不會要求額外 Google CAPTCHA，以免先出現可辨識的驗證失敗訊息。
- **套用紀錄**：`scripts/tunnel_shadow_account_bans.sql` 已套用至現有 CHAT 使用的共用 Supabase 專案；資料表封鎖紀錄不開放 `anon` 或 `authenticated` 存取。新安裝環境須先套用既有配對/IP/reCAPTCHA migration 再套用本檔。
- **測試**：已在正式共用資料庫執行交易式回滾測試，涵蓋管理員封鎖／解封、帳號遭封後修改 `profiles.status` 仍無法解封、IP 封鎖、無配對結果、等待池未寫入、受限者不出現 CAPTCHA 要求。測試資料已回滾。
- **安全界限**：雖不提供前端提示，高技術使用者仍可能透過 API 差異或長時間無配對推測受限制；不能承諾無法以任何技術手段察覺。此規則只影響 CHAT 既有帳號/IP；裝置指紋目前只記錄，尚未實作裝置級封鎖。
