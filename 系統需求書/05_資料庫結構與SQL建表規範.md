# 05. 資料庫結構與 SQL 建表規範

本文件定義系統（Tunnel 匿名聊天）的完整 Supabase (PostgreSQL) 資料庫結構、欄位規範、Row Level Security (RLS) 權限原則、索引優化與自動化清理觸發器。

---

## 一、 資料庫整體架構 (Database Architecture)

本系統採用 **冷熱分離架構 (Cold-Hot Storage Architecture)** 與 **單對話視窗場次控制 (Single-Active-Session Control)**：
- **單一對話視窗控制**：每個使用者同時只允許開啟一個 1 對 1 對話房間（`matching_pool.user_id` 為 `UNIQUE`；`profiles.status = 'chatting'` 時禁止進入配對佇列）。使用者必須主動或被動「退出/離開對話」（即將 `matches.is_active` 改為 `FALSE`）後，方可進行下一次配對。
- **對話場次 UUID 追蹤**：每一場 1 對 1 配對成功皆生成專屬的場次 UUID (`matches.id`)。訊息表 `messages` 全數透過 `match_id` (FK) 關聯至該場次，明確記載「這場對話是誰與誰聊 (`participants`)、何時聊、聊了什麼內容」。
- **管理員對話接管機制**：管理員 (`role = 'admin'`) 可觸發 `admin_takeover_session` 替換被接管使用者並踢除其房間存取權，接管對話並記錄至 `admin_takeovers` 稽核表。
- **話題卡題庫架構**：提供 `topic_categories` 與 `topic_cards` 兩層結構，存放破冰話題與分類。
- **熱資料庫 (Supabase PostgreSQL)**：維護活躍使用者 Profile、即時配對池、當前對話房間與 7 天滾動歷史對話紀錄（容量永久維持在 < 200MB）。
- **冷資料庫 (Google Drive Archive)**：每日凌晨 00:00 自動將 Supabase 未歸檔之過期 `messages` 打包 JSON 上傳至 Google Drive 備份，驗證後標記軟刪除 (`is_archived = TRUE, archived_at = NOW()`)。物理刪除延至每日 04:00 非尖峰時間執行 (`DELETE FROM messages WHERE is_archived = TRUE AND archived_at < NOW() - INTERVAL '7 days'`)，保留 7 天緩衝期防範備份失效，並徹底杜絕 `TRUNCATE` 強制鎖表引發高併發崩潰。

```
[使用者 / 瀏覽器] 
       │ (單對話視窗：一次僅限 1 房)
       ├─► (信令/配對) ──► Supabase PostgreSQL (熱資料層: match_id 場次 UUID)
       │                        │
       │                   (每日 00:00 Cron 歸檔)
       │                        ▼
       ├─► (即時對話) ──► Google Drive (冷資料層 2TB)
       │  (WebRTC P2P)
```

---

## 二、 核心 Table 定義與欄位規格

系統包含 8 大核心資料表：

### 1. `profiles` - 使用者個人檔案表
儲存使用者基本資訊、身分權限、數位指紋與即時狀態。與 Supabase `auth.users` 綁定。

| 欄位名稱 | 資料型態 | 預設值 / 限制 | 說明 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY, REFERENCES auth.users(id) ON DELETE CASCADE` | 使用者唯一識別碼 (與 Auth 同步) |
| `nickname` | `VARCHAR(50)` | `NULL` | 暱稱（全匿名模式，預設不使用與不顯示） |
| `gender` | `VARCHAR(10)` | `NULL CHECK (gender IS NULL OR gender IN ('male', 'female'))` | 性別 (選填) |
| `age` | `INTEGER` | `NULL CHECK (age IS NULL OR (age >= 18 AND age <= 99))` | 年齡 (選填) |
| `city` | `VARCHAR(20)` | `NULL` | 居住城市 (選填) |
| `job` | `VARCHAR(50)` | `NULL` | 職業或身份 (選填) |
| `bio` | `TEXT` | `NULL` | 個人簡介 (選填) |
| `opening_message` | `VARCHAR(100)` | `NULL` | 配對成功時的自動開場喊話 (選填) |
| `lat` | `DOUBLE PRECISION` | `NULL` | 用戶 GPS 緯度 (僅用於內部距離計算，絕不對外透露) |
| `lng` | `DOUBLE PRECISION` | `NULL` | 用戶 GPS 經度 (僅用於內部距離計算，絕不對外透露) |
| `location_updated_at` | `TIMESTAMPTZ` | `NULL` | GPS 位置最後更新時間 |
| `device_fingerprint` | `VARCHAR(64)` | `NULL` | 前端瀏覽器硬體數位指紋 (加鹽 SHA-256) |
| `last_ip` | `VARCHAR(45)` | `NULL` | 最後連線/登入 IP 位址 (風控與 Bot Farm 防護) |
| `reputation_score` | `INTEGER` | `DEFAULT 100 CHECK (reputation_score >= 0 AND reputation_score <= 100)` | 使用者誠信分 (影響檢舉有效性與配對權重) |
| `role` | `VARCHAR(20)` | `DEFAULT 'user' CHECK (role IN ('user', 'admin'))` | 使用者權限角色 (`user` 一般用戶, `admin` 管理員) |
| `status` | `VARCHAR(20)` | `DEFAULT 'offline' CHECK (status IN ('online', 'matching', 'chatting', 'offline'))` | 線上狀態 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 建立時間 |
| `updated_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 更新時間 |

---

### 2. `matching_pool` - 即時配對池表
維護正在佇列中等待配對的使用者。

| 欄位名稱 | 資料型態 | 預設值 / 限制 | 說明 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY, DEFAULT gen_random_uuid()` | 配對單號 ID |
| `user_id` | `UUID` | `UNIQUE, NOT NULL, REFERENCES profiles(id) ON DELETE CASCADE` | 等待配對的使用者 ID |
| `gender` | `VARCHAR(10)` | `NULL` | 本人性別 (選填) |
| `target_gender` | `VARCHAR(10)` | `DEFAULT 'any'` | 目標性別 (`male`, `female`, `any`) |
| `intent` | `VARCHAR(20)` | `NOT NULL CHECK (intent IN ('venting', 'stimulation', 'chill'))` | 聊天意圖 |
| `city` | `VARCHAR(20)` | `NULL` | 所在縣市 (選填) |
| `age` | `INTEGER` | `NULL` | 本人年齡 (選填) |
| `lat` | `DOUBLE PRECISION` | `NULL` | 當前配對點 GPS 緯度 |
| `lng` | `DOUBLE PRECISION` | `NULL` | 當前配對點 GPS 經度 |
| `max_distance_km` | `INTEGER` | `DEFAULT NULL` | 最大配對距離 (公里，NULL 表示不限) |
| `distance_mode` | `VARCHAR(20)` | `DEFAULT 'nearest'` | 距離模式：`nearest` (近距離優先), `farthest` (越遠越好避開熟人), `unlimited` (不限) |
| `status` | `VARCHAR(20)` | `DEFAULT 'waiting' CHECK (status IN ('waiting', 'matched', 'cancelled'))` | 配對佇列狀態 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 入隊時間（降級時間判斷依據） |
| `last_seen_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 心跳時間 (超時 60 秒自動清除殭屍) |
| `last_ping_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 短週期心跳時間戳 (超過 10 秒即視為離線殭屍退列) |

---

### 3. `matches` - 配對房間紀錄表
紀錄成功建立的聊天房間與參與者關係，支援管理員對話接管狀態標記。

| 欄位名稱 | 資料型態 | 預設值 / 限制 | 說明 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY, DEFAULT gen_random_uuid()` | 房間 ID (`match_id`) |
| `participants` | `UUID[]` | `NOT NULL` | 雙方使用者 UUID 陣列 `[user_a, user_b]` |
| `intent` | `VARCHAR(20)` | `NOT NULL` | 共同採用的聊天意圖 |
| `is_active` | `BOOLEAN` | `DEFAULT TRUE` | 房間是否活躍（任一方離開或管理員強制斷線設為 FALSE） |
| `ended_reason` | `VARCHAR(50)` | `NULL` | 結束原因 (`user_left`, `timeout`, `reported`, `admin_takeover`, `admin_terminated`) |
| `is_taken_over` | `BOOLEAN` | `DEFAULT FALSE` | 是否正處於管理員接管狀態（為 TRUE 時強制阻斷被接管者 API 寫入） |
| `takeover_by` | `UUID` | `NULL, REFERENCES profiles(id)` | 執行接管的管理員 ID |
| `takeover_target` | `UUID` | `NULL, REFERENCES profiles(id)` | 被接管踢出的使用者 ID |
| `takeover_at` | `TIMESTAMPTZ` | `NULL` | 執行接管的時間點 (作為 RLS 時序切分關鍵) |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 建立時間 |
| `ended_at` | `TIMESTAMPTZ` | `NULL` | 結束時間 |

---

### 4. `messages` - 熱資料對話訊息快取表 (7天滾動 + 軟刪除標記)
暫存對話內文，配合每日 00:00 歸檔腳本軟刪除標記與 04:00 7 天緩衝期實體清理。

| 欄位名稱 | 資料型態 | 預設值 / 限制 | 說明 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY, DEFAULT gen_random_uuid()` | 訊息 ID |
| `match_id` | `UUID` | `NOT NULL, REFERENCES matches(id) ON DELETE CASCADE` | 所屬房間 ID |
| `sender_id` | `UUID` | `NOT NULL, REFERENCES profiles(id)` | 發送者 User ID (包含一般用戶與接管之管理員) |
| `content` | `TEXT` | `NOT NULL` | 訊息文字內文 |
| `type` | `VARCHAR(20)` | `DEFAULT 'text' CHECK (type IN ('text', 'image', 'system', 'icebreaker', 'topic_card'))` | 訊息類型 |
| `is_archived` | `BOOLEAN` | `DEFAULT FALSE` | 是否已上傳 GDrive 備份歸檔 (軟刪除標記) |
| `archived_at` | `TIMESTAMPTZ` | `NULL` | 歸檔軟刪除時間戳 (供 7 天緩衝期算量) |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 發送時間 |

---

### 5. `chat_reports` - 風控與舉報審核表
維護舉報資料與封鎖處置狀態。

| 欄位名稱 | 資料型態 | 預設值 / 限制 | 說明 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY, DEFAULT gen_random_uuid()` | 舉報單號 ID |
| `reporter_id` | `UUID` | `NOT NULL, REFERENCES profiles(id)` | 檢舉人 User ID |
| `target_id` | `UUID` | `NOT NULL, REFERENCES profiles(id)` | 被檢舉對象 User ID |
| `match_id` | `UUID` | `NULL, REFERENCES matches(id)` | 事發房間 ID |
| `reason` | `VARCHAR(50)` | `NOT NULL` | 檢舉理由 |
| `details` | `TEXT` | `NULL` | 補充說明 |
| `context_snapshot` | `JSONB` | `NULL` | 自動打包對話最後 10 條訊息快照（供管理員後台審查實質證據） |
| `reporter_fingerprint` | `VARCHAR(64)` | `NULL` | 舉報發動時之檢舉者數位指紋 |
| `reporter_ip` | `VARCHAR(45)` | `NULL` | 舉報發動時之檢舉者 IP |
| `is_valid` | `BOOLEAN` | `DEFAULT TRUE` | 是否通過風控校驗為有效檢舉 (同指紋/同IP/免洗帳號發起時設為 FALSE) |
| `status` | `VARCHAR(20)` | `DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'banned', 'dismissed'))` | 審核狀態 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 舉報時間 |

---

### 6. `topic_categories` - 話題卡分類表
儲存破冰話題卡片的分類類別。

| 欄位名稱 | 資料型態 | 預設值 / 限制 | 說明 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY, DEFAULT gen_random_uuid()` | 分類 ID |
| `name` | `VARCHAR(50)` | `NOT NULL` | 分類名稱（如：`抒發心情`, `靈魂拷問`, `輕鬆破冰`, `深夜幻想`） |
| `icon` | `VARCHAR(50)` | `NULL` | 圖示名稱或 Emoji |
| `description` | `TEXT` | `NULL` | 分類描述 |
| `display_order` | `INTEGER` | `DEFAULT 0` | 排序權重 |
| `is_active` | `BOOLEAN` | `DEFAULT TRUE` | 是否啟用 |

---

### 7. `topic_cards` - 話題卡題庫表
儲存各分類下的具體話題題目。

| 欄位名稱 | 資料型態 | 預設值 / 限制 | 說明 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY, DEFAULT gen_random_uuid()` | 話題卡 ID |
| `category_id` | `UUID` | `NOT NULL, REFERENCES topic_categories(id) ON DELETE CASCADE` | 所屬分類 ID |
| `content` | `TEXT` | `NOT NULL` | 話題內容（例：「你最近看過最廢但最療癒的影片是什麼？」） |
| `is_active` | `BOOLEAN` | `DEFAULT TRUE` | 是否啟用 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 建立時間 |

---

### 8. `admin_takeovers` - 管理員接管稽核日誌表
專門記錄管理員對話接管操作的日誌，供資安與合規性審計。

| 欄位名稱 | 資料型態 | 預設值 / 限制 | 說明 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY, DEFAULT gen_random_uuid()` | 紀錄 ID |
| `match_id` | `UUID` | `NOT NULL, REFERENCES matches(id)` | 被接管的房間 ID |
| `admin_id` | `UUID` | `NOT NULL, REFERENCES profiles(id)` | 執行接管的管理員 ID |
| `target_user_id` | `UUID` | `NOT NULL, REFERENCES profiles(id)` | 被接管踢出的使用者 ID |
| `reason` | `TEXT` | `NOT NULL` | 接管原因（如：異常交易、騷擾檢舉） |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 接管時間 |

---

## 三、 效能優化與索引策略 (Indexing Strategy)

針對 1000 人 CCU 併發場景，建立以下高效能索引：

1. **配對池高效能複合索引 (含短週期心跳)**：
   ```sql
   CREATE INDEX idx_matching_pool_search 
   ON matching_pool(intent, target_gender, gender, last_ping_at DESC) 
   WHERE status = 'waiting';
   ```
2. **房間參與者陣列 GIN 索引 (防止 RLS 檢核引發全表掃描)**：
   ```sql
   CREATE INDEX idx_matches_participants_gin 
   ON matches USING gin (participants);
   ```
   *優化說明*：由於 RLS 權限控制大量依賴 `auth.uid() = ANY(participants)` 進行對話房間歸屬驗證，預設 B-Tree 索引無法處理陣列內部元素檢索。建立 GIN (Generalized Inverted Index) 索引可將權限過濾轉為 Bitmap Index Scan，避免隨對話與場次增加時引發全表掃掃 (Sequential Scan)。

3. **訊息查詢與歷史繪製索引**：
   ```sql
   CREATE INDEX idx_messages_match_created 
   ON messages(match_id, created_at DESC);
   ```
4. **話題卡按分類掃描索引**：
   ```sql
   CREATE INDEX idx_topic_cards_category 
   ON topic_cards(category_id) 
   WHERE is_active = TRUE;
   ```

---

## 四、 Supabase Row Level Security (RLS) 權限規範

所有前端 API 存取強制通過 RLS 驗證：

1. **`profiles` 表**：
   - 使用者得修改與讀取本人的全量資料 (`auth.uid() = id AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_banned = FALSE)`)。
   - 對方資料：僅同房間 (`match_id`) 且活躍者，允許 SELECT 對方的 `nickname`, `gender`, `age`, `city`, `job`。

2. **`matches` 表**：
   - 僅該房間現有參與者或管理員可查看 (`(auth.uid() = ANY(participants) AND is_banned = FALSE) OR is_admin()`)。

3. **`messages` 表 (含接管封鎖與即時封鎖校驗)**：
   - **發言與寫入控制**：僅允許非封禁使用者 (`is_banned = FALSE`) 且當前房間未被接管 (`matches.is_taken_over = FALSE`) 的參與者寫入。
   - **被接管用戶隔離**：若 `matches.is_taken_over = TRUE`，被接管者僅能讀取 `created_at <= matches.takeover_at`（接管發生前）的歷史訊息，物理性封鎖接管後所有訊息。

4. **`topic_categories` 與 `topic_cards` 表**：
   - 全體使用者開放 `SELECT` 唯讀存取；僅 `admin` 角色允許 `INSERT/UPDATE/DELETE` 維護。

5. **`admin_takeovers` 表**：
   - 僅限 `admin` 角色寫入與讀取。

---

## 五、 自動化觸發器與預寫程序 (Stored Procedures)

1. **`clean_zombie_matching_pool()`**：定時刪除 `last_ping_at` 超過 10 秒未更新心跳的殭屍配對紀錄。
2. **`fn_match_user(p_user_id, p_intent, p_gender, p_target_gender, p_city, p_age, p_lat, p_lng, p_max_distance_km, p_distance_mode)`**：高併發 RPC 配對預寫程序。支援距離計算與極端距離(最遠)篩選。使用 `SELECT FOR UPDATE SKIP LOCKED` 原子配對，於 10ms 內完成鎖定、匹配、建立 `matches` 紀錄並刪除配對池紀錄，避免連線數爆滿。
3. **`admin_takeover_session(p_match_id, p_target_user_id, p_reason)`**：管理員接管預寫程序，執行 `is_taken_over = TRUE` 標記、紀錄 `takeover_at` 時間戳、寫入 `admin_takeovers` 稽核日誌與中斷原用戶寫入權限。
4. **`terminate_match_by_admin(p_match_id, p_reason)`**：管理員緊急強制斷線程序，將 `matches.is_active` 改為 `FALSE`，發送系統斷線通知。
5. **`verify_admin_password(p_password)`**：在資料庫內部核對 `private.admin_config` 保存的 bcrypt hash。呼叫端不能讀取密碼表；成功後取得 8 小時管理權限，並受失敗次數限制。

## 六、正式資料與 Seed 規範（2026-08 修訂）

- `topic_categories` 與 `topic_cards` 初始化後至少須有 3 個啟用分類、每類至少 6 張啟用卡片。
- Seed 必須可重複執行，使用固定 UUID 與 `ON CONFLICT DO UPDATE`，不得重複產生資料。
- 前端不得內建假分類或假卡片 fallback；資料表為空或查詢失敗時應顯示錯誤。
- `matches` 新增 `distance_km DOUBLE PRECISION`，由配對 RPC 建立房間時寫入；原始座標不可暴露給對方。
- 所有行為型資料表禁止插入展示用假資料；測試資料應使用獨立環境或具明確標記並於驗收後清除。
- `auth.users` 與 `public.profiles` 必須維持一對一；migration 須補建歷史缺漏 profile，且 RLS 只允許登入者建立自己的 `role='user'` profile。
