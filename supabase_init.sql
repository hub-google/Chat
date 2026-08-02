-- ========================================================
-- Tunnel 匿名聊天系統 - Supabase PostgreSQL 初始化 SQL 腳本
-- 版本: 1.2.0 (含管理員即時監控、強制斷線、對話接管與話題卡系統)
-- 架構: 1000 人 CCU 冷熱分離資料庫設計
-- ========================================================

-- 0. 開啟必要擴充套件
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 管理員密碼設定只存在私有 schema，API 角色不可直接讀取。
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.admin_config (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS private.admin_login_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL,
    succeeded BOOLEAN NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;

-- ========================================================
-- 1. 建立資料表 (TABLES)
-- ========================================================

-- 1.1 使用者個人檔案表 (profiles)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    nickname VARCHAR(50),
    gender VARCHAR(10) CHECK (gender IS NULL OR gender IN ('male', 'female')),
    age INTEGER CHECK (age IS NULL OR (age >= 18 AND age <= 99)),
    city VARCHAR(20),
    job VARCHAR(50),
    bio TEXT,
    opening_message VARCHAR(100),
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    location_updated_at TIMESTAMPTZ,
    device_fingerprint VARCHAR(64),
    last_ip VARCHAR(45),
    last_ip_location_zh VARCHAR(255),
    reputation_score INTEGER DEFAULT 100 CHECK (reputation_score >= 0 AND reputation_score <= 100),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    admin_until TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'offline' CHECK (status IN ('online', 'matching', 'chatting', 'offline', 'banned')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS admin_until TIMESTAMPTZ;

-- 1.2 即時配對池表 (matching_pool)
CREATE TABLE IF NOT EXISTS public.matching_pool (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    gender VARCHAR(10) CHECK (gender IS NULL OR gender IN ('male', 'female')),
    target_gender VARCHAR(10) DEFAULT 'any' CHECK (target_gender IN ('male', 'female', 'any')),
    intent VARCHAR(20) NOT NULL CHECK (intent IN ('venting', 'stimulation', 'chill')),
    city VARCHAR(20),
    age INTEGER,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    max_distance_km INTEGER DEFAULT NULL,
    distance_mode VARCHAR(20) DEFAULT 'nearest' CHECK (distance_mode IN ('nearest', 'farthest', 'unlimited')),
    status VARCHAR(20) DEFAULT 'waiting' CHECK (status IN ('waiting', 'matched', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_ping_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1.3 配對房間紀錄表 (matches)
CREATE TABLE IF NOT EXISTS public.matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participants UUID[] NOT NULL,
    intent VARCHAR(20) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    ended_reason VARCHAR(50),
    is_taken_over BOOLEAN DEFAULT FALSE,
    is_takeover BOOLEAN DEFAULT FALSE,
    takeover_by UUID REFERENCES public.profiles(id),
    takeover_target UUID REFERENCES public.profiles(id),
    takeover_at TIMESTAMPTZ,
    distance_km DOUBLE PRECISION,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

-- 1.4 熱資料對話訊息快取表 (messages)
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    type VARCHAR(20) DEFAULT 'text' CHECK (type IN ('text', 'image', 'system', 'icebreaker', 'topic_card')),
    is_archived BOOLEAN DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1.5 風控與舉報審核表 (chat_reports)
CREATE TABLE IF NOT EXISTS public.chat_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    match_id UUID REFERENCES public.matches(id),
    reason VARCHAR(50) NOT NULL,
    details TEXT,
    context_snapshot JSONB,
    reporter_fingerprint VARCHAR(64),
    reporter_ip VARCHAR(45),
    is_valid BOOLEAN DEFAULT TRUE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'banned', 'dismissed')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1.6 話題卡分類表 (topic_categories)
CREATE TABLE IF NOT EXISTS public.topic_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    icon VARCHAR(50),
    description TEXT,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE
);

-- 1.7 話題卡題庫表 (topic_cards)
CREATE TABLE IF NOT EXISTS public.topic_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES public.topic_categories(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Curated product content. These rows are not analytics and are intentionally
-- seeded; user activity tables must only contain data created by real usage.
INSERT INTO public.topic_categories (id, name, icon, description, display_order, is_active) VALUES
('10000000-0000-4000-8000-000000000001', '破冰閒聊', '💬', '輕鬆開啟話題的日常問題', 1, TRUE),
('10000000-0000-4000-8000-000000000002', '深度交流', '🌙', '聊聊價值觀、感受與人生經驗', 2, TRUE),
('10000000-0000-4000-8000-000000000003', '趣味假設', '✨', '用天馬行空的情境認識彼此', 3, TRUE)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, icon=EXCLUDED.icon, description=EXCLUDED.description, display_order=EXCLUDED.display_order, is_active=TRUE;

INSERT INTO public.topic_cards (id, category_id, content, is_active) VALUES
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','最近有哪件小事讓你心情變好？',TRUE),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','你最近最常聽哪一首歌？為什麼喜歡它？',TRUE),
('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','如果明天完全不用工作或上課，你最想怎麼過？',TRUE),
('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','最近看過最值得推薦的一部作品是什麼？',TRUE),
('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','你是哪一種早起派，還是熬夜派？',TRUE),
('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','你最近學到最意外的一件事是什麼？',TRUE),
('20000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000002','你目前最想改變生活中的哪一件事？',TRUE),
('20000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000002','什麼樣的時刻最容易讓你感到被理解？',TRUE),
('20000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000002','你做過哪個決定，後來最感謝當時的自己？',TRUE),
('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002','對你來說，理想的人際關係最重要的是什麼？',TRUE),
('20000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000002','如果可以對五年前的自己說一句話，你會說什麼？',TRUE),
('20000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000002','什麼事情會讓你覺得今天過得很值得？',TRUE),
('20000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000003','如果能立刻精通一項技能，你會選什麼？',TRUE),
('20000000-0000-4000-8000-000000000014','10000000-0000-4000-8000-000000000003','如果能在任何城市住一個月，你會選哪裡？',TRUE),
('20000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000003','如果你的生活是一部電影，現在會是什麼類型？',TRUE),
('20000000-0000-4000-8000-000000000016','10000000-0000-4000-8000-000000000003','如果可以和一種動物對話，你會選哪一種？',TRUE),
('20000000-0000-4000-8000-000000000017','10000000-0000-4000-8000-000000000003','如果今天多出三個小時，你會拿來做什麼？',TRUE),
('20000000-0000-4000-8000-000000000018','10000000-0000-4000-8000-000000000003','如果能重來一次，你最想重新體驗哪一天？',TRUE)
ON CONFLICT (id) DO UPDATE SET category_id=EXCLUDED.category_id, content=EXCLUDED.content, is_active=TRUE;

-- 1.8 管理員對話接管稽核日誌表 (admin_takeovers)
CREATE TABLE IF NOT EXISTS public.admin_takeovers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID NOT NULL REFERENCES public.matches(id),
    admin_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    target_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Existing installations do not pick up new columns from CREATE TABLE IF NOT EXISTS.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_ip_location_zh VARCHAR(255);

-- ========================================================
-- 2. 高效能索引設計 (INDEXES)
-- ========================================================

CREATE INDEX IF NOT EXISTS idx_matching_pool_search 
ON public.matching_pool(intent, target_gender, gender, last_ping_at DESC) 
WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_matching_pool_heartbeat 
ON public.matching_pool(last_ping_at) 
WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_matches_participants_gin 
ON public.matches USING gin (participants);

CREATE INDEX IF NOT EXISTS idx_messages_match_created 
ON public.messages(match_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_archive_purge 
ON public.messages(is_archived, archived_at) 
WHERE is_archived = TRUE;

CREATE INDEX IF NOT EXISTS idx_topic_cards_category 
ON public.topic_cards(category_id) 
WHERE is_active = TRUE;

-- ========================================================
-- 3. 行級安全策略 (ROW LEVEL SECURITY - RLS)
-- ========================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matching_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_takeovers ENABLE ROW LEVEL SECURITY;

-- 輔助 Function：判斷當前使用者是否為管理員
CREATE OR REPLACE FUNCTION public.is_admin() 
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE id = auth.uid()
          AND role = 'admin'
          AND (admin_until IS NULL OR admin_until > NOW())
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

-- 輔助 Function：判斷當前使用者是否已被封鎖
CREATE OR REPLACE FUNCTION public.is_banned() 
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE id = auth.uid() AND status = 'banned'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

-- 移除舊版明文密碼權限提升 RPC。
DROP FUNCTION IF EXISTS public.claim_admin_role(TEXT);

-- 密碼只在資料庫內部以 bcrypt hash 驗證，不會回傳給瀏覽器。
CREATE OR REPLACE FUNCTION public.verify_admin_password(p_password TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    v_password_hash TEXT;
    v_failed_attempts INTEGER;
BEGIN
    IF auth.uid() IS NULL OR p_password IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT COUNT(*) INTO v_failed_attempts
    FROM private.admin_login_attempts
    WHERE user_id = auth.uid()
      AND succeeded = FALSE
      AND attempted_at > NOW() - INTERVAL '15 minutes';

    IF v_failed_attempts >= 5 THEN
        RAISE EXCEPTION 'Too many failed attempts. Try again in 15 minutes.';
    END IF;

    SELECT password_hash INTO v_password_hash
    FROM private.admin_config
    WHERE id = 1;

    IF v_password_hash IS NOT NULL
       AND v_password_hash = crypt(p_password, v_password_hash) THEN
        INSERT INTO private.admin_login_attempts (user_id, succeeded)
        VALUES (auth.uid(), TRUE);

        UPDATE public.profiles
        SET role = 'admin', admin_until = NOW() + INTERVAL '8 hours'
        WHERE id = auth.uid();

        RETURN TRUE;
    END IF;

    INSERT INTO private.admin_login_attempts (user_id, succeeded)
    VALUES (auth.uid(), FALSE);
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, extensions;

-- Anonymous Auth 建立帳號後立即補齊 profile，避免配對池與訊息 FK 寫入失敗。
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, status)
    VALUES (NEW.id, 'online')
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- 讓既有 Auth 使用者也能安全補建 profile。
INSERT INTO public.profiles (id, status)
SELECT id, 'offline' FROM auth.users
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users manage own queue row" ON public.matching_pool;
DROP POLICY IF EXISTS "Participants or admins can view matches" ON public.matches;
DROP POLICY IF EXISTS "Messages read policy with takeover isolation" ON public.messages;
DROP POLICY IF EXISTS "Current participants can insert room messages" ON public.messages;
DROP POLICY IF EXISTS "Users can create chat_reports" ON public.chat_reports;
DROP POLICY IF EXISTS "Admins can review chat_reports" ON public.chat_reports;
DROP POLICY IF EXISTS "Everyone can read active topic categories" ON public.topic_categories;
DROP POLICY IF EXISTS "Everyone can read active topic cards" ON public.topic_cards;
DROP POLICY IF EXISTS "Admins can manage topic categories" ON public.topic_categories;
DROP POLICY IF EXISTS "Admins can manage topic cards" ON public.topic_cards;
DROP POLICY IF EXISTS "Admins can access takeover logs" ON public.admin_takeovers;

CREATE POLICY "Everyone can view profiles"
ON public.profiles FOR SELECT TO authenticated
USING (TRUE);

CREATE POLICY "Users can update own profile"
ON public.profiles FOR UPDATE TO authenticated
USING ((auth.uid() = id AND NOT public.is_banned()) OR public.is_admin())
WITH CHECK ((auth.uid() = id AND role = 'user') OR public.is_admin());

CREATE POLICY "Users can insert own profile"
ON public.profiles FOR INSERT TO authenticated
WITH CHECK (auth.uid() = id AND role = 'user');

CREATE POLICY "Users manage own queue row"
ON public.matching_pool FOR ALL TO authenticated
USING ((auth.uid() = user_id AND NOT public.is_banned()) OR public.is_admin())
WITH CHECK ((auth.uid() = user_id AND NOT public.is_banned()) OR public.is_admin());

CREATE POLICY "Participants or admins can view matches"
ON public.matches FOR SELECT TO authenticated
USING (((auth.uid() = ANY(participants) OR auth.uid() = takeover_target) AND NOT public.is_banned()) OR public.is_admin());

CREATE POLICY "Messages read policy with takeover isolation"
ON public.messages FOR SELECT TO authenticated
USING (
    NOT public.is_banned() AND (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.matches
            WHERE id = messages.match_id AND auth.uid() = ANY(participants)
        )
        OR EXISTS (
            SELECT 1 FROM public.matches
            WHERE id = messages.match_id
              AND takeover_target = auth.uid()
              AND messages.created_at <= takeover_at
        )
    )
);

CREATE POLICY "Current participants can insert room messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
    NOT public.is_banned()
    AND EXISTS (
        SELECT 1 FROM public.matches
        WHERE id = messages.match_id AND is_active = TRUE
          AND (
            (auth.uid() = sender_id AND auth.uid() = ANY(participants))
            OR public.is_admin()
          )
    )
);

CREATE POLICY "Users can create chat_reports"
ON public.chat_reports FOR INSERT TO authenticated
WITH CHECK (auth.uid() = reporter_id AND NOT public.is_banned());

CREATE POLICY "Admins can review chat_reports"
ON public.chat_reports FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Everyone can read active topic categories"
ON public.topic_categories FOR SELECT TO authenticated
USING (is_active = TRUE OR public.is_admin());

CREATE POLICY "Everyone can read active topic cards"
ON public.topic_cards FOR SELECT TO authenticated
USING (is_active = TRUE OR public.is_admin());

CREATE POLICY "Admins can manage topic categories"
ON public.topic_categories FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Admins can manage topic cards"
ON public.topic_cards FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Admins can access takeover logs"
ON public.admin_takeovers FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ========================================================
-- 4. 自動化函數與預寫程序 (STORED PROCEDURES & TRIGGERS)
-- ========================================================

-- 4.0 定時清理 10 秒未 Ping 的殭屍配對紀錄
CREATE OR REPLACE FUNCTION public.clean_zombie_matching_pool()
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    DELETE FROM public.matching_pool
    WHERE last_ping_at < NOW() - INTERVAL '10 seconds';
    
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.0.1 球面距離算式函數 (Haversine Formula)
CREATE OR REPLACE FUNCTION public.haversine_distance(
    lat1 DOUBLE PRECISION,
    lng1 DOUBLE PRECISION,
    lat2 DOUBLE PRECISION,
    lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION AS $$
DECLARE
    r DOUBLE PRECISION := 6371.0; -- 地球半徑 (公里)
    dlat DOUBLE PRECISION;
    dlng DOUBLE PRECISION;
    a DOUBLE PRECISION;
    c DOUBLE PRECISION;
BEGIN
    IF lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN
        RETURN NULL;
    END IF;

    dlat := radians(lat2 - lat1);
    dlng := radians(lng2 - lng1);

    a := sin(dlat / 2.0)^2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2.0)^2;
    c := 2.0 * atan2(sqrt(a), sqrt(1.0 - a));

    RETURN r * c;
END;
$$ LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE;

-- 4.1 高併發 RPC 配對預寫程序 (fn_match_user，支援越遠越好、距離過濾與選填欄位)
CREATE OR REPLACE FUNCTION public.fn_match_user(
    p_user_id UUID,
    p_intent VARCHAR(20),
    p_gender VARCHAR(10) DEFAULT NULL,
    p_target_gender VARCHAR(10) DEFAULT 'any',
    p_city VARCHAR(20) DEFAULT NULL,
    p_age INTEGER DEFAULT NULL,
    p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL,
    p_max_distance_km INTEGER DEFAULT NULL,
    p_distance_mode VARCHAR(20) DEFAULT 'nearest'
) RETURNS TABLE (
    match_id UUID,
    matched_user_id UUID
) AS $$
DECLARE
    v_target_row RECORD;
    v_new_match_id UUID;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> p_user_id OR public.is_banned() THEN
        RAISE EXCEPTION 'Not authorized to match this user.';
    END IF;

    -- 尋找符合條件之第一個等待者 (原子鎖定與跳過已鎖定)
    SELECT * INTO v_target_row
    FROM public.matching_pool
    WHERE status = 'waiting'
      AND user_id != p_user_id
      AND intent = p_intent
      -- 性別篩選 (若為 any、NULL 或目標性別吻合)
      AND (p_target_gender = 'any' OR p_target_gender IS NULL OR gender IS NULL OR gender = p_target_gender)
      AND (target_gender = 'any' OR target_gender IS NULL OR p_gender IS NULL OR target_gender = p_gender)
      -- 距離公里數過濾 (若雙方設定 max_distance_km 且均有 GPS，則計算距離小於等於限制)
      AND (
          p_max_distance_km IS NULL 
          OR p_lat IS NULL 
          OR p_lng IS NULL 
          OR lat IS NULL 
          OR lng IS NULL 
          OR public.haversine_distance(p_lat, p_lng, lat, lng) <= p_max_distance_km
      )
      AND (
          max_distance_km IS NULL 
          OR p_lat IS NULL 
          OR p_lng IS NULL 
          OR lat IS NULL 
          OR lng IS NULL 
          OR public.haversine_distance(p_lat, p_lng, lat, lng) <= max_distance_km
      )
      AND (
          p_distance_mode != 'farthest'
          OR p_lat IS NULL 
          OR p_lng IS NULL 
          OR lat IS NULL 
          OR lng IS NULL 
          OR public.haversine_distance(p_lat, p_lng, lat, lng) >= 50
      )
      AND (
          distance_mode != 'farthest'
          OR p_lat IS NULL 
          OR p_lng IS NULL 
          OR lat IS NULL 
          OR lng IS NULL 
          OR public.haversine_distance(p_lat, p_lng, lat, lng) >= 50
      )
      AND last_ping_at > NOW() - INTERVAL '10 seconds'
    ORDER BY 
      CASE WHEN p_distance_mode = 'farthest' THEN public.haversine_distance(p_lat, p_lng, lat, lng) END DESC NULLS LAST,
      created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

    IF v_target_row.id IS NOT NULL THEN
        -- 建立配對房間
        INSERT INTO public.matches (participants, intent, is_active, distance_km)
        VALUES (
          ARRAY[p_user_id, v_target_row.user_id], p_intent, TRUE,
          CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL AND v_target_row.lat IS NOT NULL AND v_target_row.lng IS NOT NULL
               THEN public.haversine_distance(p_lat, p_lng, v_target_row.lat, v_target_row.lng)
               ELSE NULL END
        )
        RETURNING id INTO v_new_match_id;

        -- 從配對池移除對方與自己
        DELETE FROM public.matching_pool WHERE user_id IN (p_user_id, v_target_row.user_id);

        -- 更新 profiles 狀態
        UPDATE public.profiles SET status = 'chatting' WHERE id IN (p_user_id, v_target_row.user_id);

        RETURN QUERY SELECT v_new_match_id, v_target_row.user_id;
    ELSE
        -- 無即時對象，將自己加入或更新配對池
        INSERT INTO public.matching_pool (user_id, gender, target_gender, intent, city, age, lat, lng, max_distance_km, distance_mode, status, last_ping_at)
        VALUES (p_user_id, p_gender, p_target_gender, p_intent, p_city, p_age, p_lat, p_lng, p_max_distance_km, p_distance_mode, 'waiting', NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            gender = EXCLUDED.gender,
            target_gender = EXCLUDED.target_gender,
            intent = EXCLUDED.intent,
            city = EXCLUDED.city,
            age = EXCLUDED.age,
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            max_distance_km = EXCLUDED.max_distance_km,
            distance_mode = EXCLUDED.distance_mode,
            last_ping_at = NOW(),
            status = 'waiting';

        RETURN QUERY SELECT NULL::UUID, NULL::UUID;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.1.1 使用者主動離開，原子結束場次並釋放雙方狀態。
CREATE OR REPLACE FUNCTION public.leave_match(p_match_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_participants UUID[];
BEGIN
    SELECT participants INTO v_participants
    FROM public.matches
    WHERE id = p_match_id
      AND is_active = TRUE
      AND auth.uid() = ANY(participants)
    FOR UPDATE;

    IF v_participants IS NULL THEN
        RETURN FALSE;
    END IF;

    UPDATE public.matches
    SET is_active = FALSE, ended_reason = 'user_left', ended_at = NOW()
    WHERE id = p_match_id;

    UPDATE public.profiles SET status = 'online'
    WHERE id = ANY(v_participants) AND status <> 'banned';
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.2 管理員對話接管預寫程序 (可指定接管 User A 或 User B)
CREATE OR REPLACE FUNCTION public.admin_takeover_session(
    p_match_id UUID,
    p_target_user_id UUID,
    p_reason TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_admin_id UUID := auth.uid();
    v_participants UUID[];
    v_now TIMESTAMPTZ := NOW();
BEGIN
    -- 1. 權限檢查：必須為管理員
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only administrators can execute takeover.';
    END IF;

    -- 2. 取得原房間參與者
    SELECT participants INTO v_participants 
    FROM public.matches 
    WHERE id = p_match_id AND is_active = TRUE;

    IF v_participants IS NULL OR NOT (p_target_user_id = ANY(v_participants)) THEN
        RAISE EXCEPTION 'Target user is not an active participant in this room.';
    END IF;

    -- 3. 將陣列中的 target_user 替換為 admin_id
    v_participants := array_replace(v_participants, p_target_user_id, v_admin_id);

    -- 4. 更新 matches 表紀錄 (設定 is_taken_over = TRUE)
    UPDATE public.matches 
    SET 
        participants = v_participants,
        is_taken_over = TRUE,
        is_takeover = TRUE,
        takeover_by = v_admin_id,
        takeover_target = p_target_user_id,
        takeover_at = v_now
    WHERE id = p_match_id;

    -- 5. 將被接管的使用者狀態還原為 online
    UPDATE public.profiles 
    SET status = 'online' 
    WHERE id = p_target_user_id;

    -- 6. 不寫入任何系統訊息；未被接管的一方必須無感繼續對話。
    -- 7. 記錄至管理員接管稽核日誌表
    INSERT INTO public.admin_takeovers (match_id, admin_id, target_user_id, reason)
    VALUES (p_match_id, v_admin_id, p_target_user_id, p_reason);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4.2 管理員緊急強制斷線預寫程序 (Emergency Kill Switch)
CREATE OR REPLACE FUNCTION public.terminate_match_by_admin(
    p_match_id UUID,
    p_reason TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_admin_id UUID := auth.uid();
    v_participants UUID[];
BEGIN
    -- 1. 權限檢查：必須為管理員
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only administrators can terminate matches.';
    END IF;

    -- 2. 取得原房間參與者
    SELECT participants INTO v_participants 
    FROM public.matches 
    WHERE id = p_match_id AND is_active = TRUE;

    IF v_participants IS NULL THEN
        RAISE EXCEPTION 'Match is not active or does not exist.';
    END IF;

    -- 3. 更新房間狀態為不活躍
    UPDATE public.matches 
    SET 
        is_active = FALSE,
        ended_reason = 'admin_terminated',
        ended_at = NOW()
    WHERE id = p_match_id;

    -- 4. 發送系統終止訊息通知雙方
    INSERT INTO public.messages (match_id, sender_id, content, type)
    VALUES (p_match_id, v_admin_id, '[系統警示] 本對話因涉嫌違反平台安全規範，已被管理員強制終止。', 'system');

    -- 5. 還原雙方使用者狀態為 online
    UPDATE public.profiles 
    SET status = 'online' 
    WHERE id = ANY(v_participants);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.fn_match_user(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_match_user(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, VARCHAR) TO authenticated;
REVOKE ALL ON FUNCTION public.leave_match(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_match(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_takeover_session(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_takeover_session(UUID, UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.terminate_match_by_admin(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.terminate_match_by_admin(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.clean_zombie_matching_pool() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_admin_password(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_password(TEXT) TO authenticated;

-- 4.3 每日 04:00 軟刪除 7 天過期訊息物理清理程序
CREATE OR REPLACE FUNCTION public.purge_archived_messages()
RETURNS INTEGER AS $$
DECLARE
    v_deleted_count INTEGER;
BEGIN
    DELETE FROM public.messages 
    WHERE is_archived = TRUE 
    AND archived_at < NOW() - INTERVAL '7 days';

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.purge_archived_messages() FROM PUBLIC, anon, authenticated;

-- ========================================================
-- 5. 開啟 Realtime 即時推播 (Realtime Publication)
-- ========================================================
-- 必須將需要即時更新的表加入 publication，否則前端 channel 聽不到 postgres_changes
ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
