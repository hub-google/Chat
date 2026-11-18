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
    content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
    type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'image', 'system')),
    is_archived BOOLEAN DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    backup_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS backup_verified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tunnel_messages_pending_backup
  ON public.messages (created_at, id)
  WHERE backup_verified_at IS NULL;

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

-- Tunnel profiles are created only by the Tunnel frontend's ensureUser()
-- on entry, not for every new auth.users user in this shared Supabase project.
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users manage own queue row" ON public.matching_pool;
DROP POLICY IF EXISTS "Participants or admins can view matches" ON public.matches;
DROP POLICY IF EXISTS "Messages read policy with takeover isolation" ON public.messages;
DROP POLICY IF EXISTS "Current participants can insert room messages" ON public.messages;
DROP POLICY IF EXISTS "Tunnel sender inserts current or recently ended messages" ON public.messages;
DROP POLICY IF EXISTS "Users can create chat_reports" ON public.chat_reports;
DROP POLICY IF EXISTS "Admins can review chat_reports" ON public.chat_reports;
DROP POLICY IF EXISTS "Everyone can read active topic categories" ON public.topic_categories;
DROP POLICY IF EXISTS "Everyone can read active topic cards" ON public.topic_cards;
DROP POLICY IF EXISTS "Admins can manage topic categories" ON public.topic_categories;
DROP POLICY IF EXISTS "Admins can manage topic cards" ON public.topic_cards;
DROP POLICY IF EXISTS "Admins can access takeover logs" ON public.admin_takeovers;

CREATE POLICY "Everyone can view profiles"
ON public.profiles FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = id OR (SELECT public.is_admin()));

CREATE POLICY "Users can update own profile"
ON public.profiles FOR UPDATE TO authenticated
USING (((SELECT auth.uid()) = id AND NOT (SELECT public.is_banned())) OR (SELECT public.is_admin()))
WITH CHECK (((SELECT auth.uid()) = id AND role = 'user') OR (SELECT public.is_admin()));

CREATE POLICY "Users can insert own profile"
ON public.profiles FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) = id AND role = 'user');

CREATE POLICY "Users manage own queue row"
ON public.matching_pool FOR ALL TO authenticated
USING (((SELECT auth.uid()) = user_id AND NOT (SELECT public.is_banned())) OR (SELECT public.is_admin()))
WITH CHECK (((SELECT auth.uid()) = user_id AND NOT (SELECT public.is_banned())) OR (SELECT public.is_admin()));

CREATE POLICY "Participants or admins can view matches"
ON public.matches FOR SELECT TO authenticated
USING ((((SELECT auth.uid()) = ANY(participants) OR (SELECT auth.uid()) = takeover_target) AND NOT (SELECT public.is_banned())) OR (SELECT public.is_admin()));

CREATE POLICY "Messages read policy with takeover isolation"
ON public.messages FOR SELECT TO authenticated
USING (
    NOT (SELECT public.is_banned()) AND (
        (SELECT public.is_admin())
        OR EXISTS (
            SELECT 1 FROM public.matches
            WHERE id = messages.match_id AND (SELECT auth.uid()) = ANY(participants)
        )
        OR EXISTS (
            SELECT 1 FROM public.matches
            WHERE id = messages.match_id
              AND takeover_target = (SELECT auth.uid())
              AND messages.created_at <= takeover_at
        )
    )
);

CREATE POLICY "Tunnel sender inserts current or recently ended messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  NOT (SELECT public.is_banned())
  AND sender_id = (SELECT auth.uid())
  AND (type IN ('text', 'image') OR ((SELECT public.is_admin()) AND type = 'system'))
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = messages.match_id
      AND (
        (m.is_active = TRUE AND (
          (SELECT public.is_admin())
          OR ((SELECT auth.uid()) = ANY(m.participants)
             AND (NOT COALESCE(m.is_taken_over,FALSE) OR m.takeover_target IS DISTINCT FROM (SELECT auth.uid())))
        ))
        OR (
          m.is_active = FALSE AND m.ended_reason = 'user_left'
          AND COALESCE(m.is_taken_over,FALSE) = FALSE
          AND m.ended_at > NOW() - INTERVAL '24 hours'
          AND (SELECT auth.uid()) = ANY(m.participants)
        )
      )
  )
);

CREATE POLICY "Users can create chat_reports"
ON public.chat_reports FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) = reporter_id AND NOT (SELECT public.is_banned()));

CREATE POLICY "Admins can review chat_reports"
ON public.chat_reports FOR ALL TO authenticated
USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY "Everyone can read active topic categories"
ON public.topic_categories FOR SELECT TO authenticated
USING (is_active = TRUE OR (SELECT public.is_admin()));

CREATE POLICY "Everyone can read active topic cards"
ON public.topic_cards FOR SELECT TO authenticated
USING (is_active = TRUE OR (SELECT public.is_admin()));

CREATE POLICY "Admins can manage topic categories"
ON public.topic_categories FOR ALL TO authenticated
USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY "Admins can manage topic cards"
ON public.topic_cards FOR ALL TO authenticated
USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

CREATE POLICY "Admins can access takeover logs"
ON public.admin_takeovers FOR ALL TO authenticated
USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

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
CREATE OR REPLACE FUNCTION public.fn_match_user(p_user_id uuid, p_intent character varying, p_gender character varying DEFAULT NULL::character varying, p_target_gender character varying DEFAULT 'any'::character varying, p_city character varying DEFAULT NULL::character varying, p_age integer DEFAULT NULL::integer, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_max_distance_km integer DEFAULT NULL::integer, p_distance_mode character varying DEFAULT 'nearest'::character varying)
 RETURNS TABLE(match_id uuid, matched_user_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_target_row RECORD; v_new_match_id UUID; v_existing public.matches%ROWTYPE; v_my_queue_id UUID;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id OR public.is_banned() THEN
    RAISE EXCEPTION 'Not authorized to match this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  -- A simultaneous attempt may otherwise match this user while another
  -- transaction claims them as a target. Lock the caller's own queue row
  -- before checking active matches or searching for another candidate.
  -- SKIP LOCKED on target selection then excludes this user until commit.
  SELECT id INTO v_my_queue_id
  FROM public.matching_pool
  WHERE user_id = p_user_id
  FOR UPDATE;
  SELECT * INTO v_existing FROM public.matches
    WHERE p_user_id = ANY(participants) AND is_active
    ORDER BY created_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing.id, (SELECT u FROM unnest(v_existing.participants) u WHERE u <> p_user_id LIMIT 1);
    RETURN;
  END IF;
  SELECT * INTO v_target_row FROM public.matching_pool
   WHERE status='waiting' AND user_id<>p_user_id AND intent=p_intent
     AND (p_target_gender='any' OR p_target_gender IS NULL OR gender IS NULL OR gender=p_target_gender)
     AND (target_gender='any' OR target_gender IS NULL OR p_gender IS NULL OR target_gender=p_gender)
     AND (p_max_distance_km IS NULL OR (p_lat IS NOT NULL AND p_lng IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL AND public.haversine_distance(p_lat,p_lng,lat,lng)<=p_max_distance_km))
     AND (max_distance_km IS NULL OR (p_lat IS NOT NULL AND p_lng IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL AND public.haversine_distance(p_lat,p_lng,lat,lng)<=max_distance_km))
     AND (p_distance_mode<>'farthest' OR (p_lat IS NOT NULL AND p_lng IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL AND public.haversine_distance(p_lat,p_lng,lat,lng)>=50))
     AND (distance_mode<>'farthest' OR (p_lat IS NOT NULL AND p_lng IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL AND public.haversine_distance(p_lat,p_lng,lat,lng)>=50))
     AND last_ping_at>NOW()-INTERVAL '10 seconds'
   ORDER BY CASE WHEN p_distance_mode='farthest' THEN public.haversine_distance(p_lat,p_lng,lat,lng) END DESC NULLS LAST, created_at ASC
   FOR UPDATE SKIP LOCKED LIMIT 1;

  IF v_target_row.id IS NOT NULL THEN
    INSERT INTO public.matches(participants,intent,is_active,distance_km)
    VALUES (ARRAY[p_user_id,v_target_row.user_id],p_intent,TRUE,
      CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL AND v_target_row.lat IS NOT NULL AND v_target_row.lng IS NOT NULL
           THEN public.haversine_distance(p_lat,p_lng,v_target_row.lat,v_target_row.lng) ELSE NULL END)
    RETURNING id INTO v_new_match_id;
    DELETE FROM public.matching_pool WHERE user_id IN (p_user_id,v_target_row.user_id);
    UPDATE public.profiles SET status='chatting' WHERE id IN (p_user_id,v_target_row.user_id);
    RETURN QUERY SELECT v_new_match_id,v_target_row.user_id;
  ELSE
    INSERT INTO public.matching_pool(user_id,gender,target_gender,intent,city,age,lat,lng,max_distance_km,distance_mode,status,last_ping_at)
    VALUES(p_user_id,p_gender,p_target_gender,p_intent,p_city,p_age,p_lat,p_lng,p_max_distance_km,p_distance_mode,'waiting',NOW())
    ON CONFLICT(user_id) DO UPDATE SET gender=EXCLUDED.gender,target_gender=EXCLUDED.target_gender,intent=EXCLUDED.intent,
      city=EXCLUDED.city,age=EXCLUDED.age,lat=EXCLUDED.lat,lng=EXCLUDED.lng,max_distance_km=EXCLUDED.max_distance_km,
      distance_mode=EXCLUDED.distance_mode,last_ping_at=NOW(),status='waiting';
    RETURN QUERY SELECT NULL::UUID,NULL::UUID;
  END IF;
END;
$function$;

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
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only administrators can execute takeover.';
    END IF;

    SELECT participants INTO v_participants
    FROM public.matches
    WHERE id = p_match_id AND is_active = TRUE;

    IF v_participants IS NULL OR NOT (p_target_user_id = ANY(v_participants)) THEN
        RAISE EXCEPTION 'Target user is not an active participant in this room.';
    END IF;

    v_participants := array_replace(v_participants, p_target_user_id, v_admin_id);

    UPDATE public.matches
    SET participants = v_participants,
        is_taken_over = TRUE,
        is_takeover = TRUE,
        takeover_by = v_admin_id,
        takeover_target = p_target_user_id,
        takeover_at = v_now
    WHERE id = p_match_id;

    UPDATE public.profiles SET status = 'online' WHERE id = p_target_user_id;

    -- Deliberately do not create a system message. The remaining user must
    -- experience an uninterrupted conversation with the administrator.
    INSERT INTO public.admin_takeovers (match_id, admin_id, target_user_id, reason)
    VALUES (p_match_id, v_admin_id, p_target_user_id, p_reason);

    RETURN TRUE;
END;
$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
-- 5. Minimal safe HTTP signaling and peer-profile access
-- ========================================================
CREATE SCHEMA IF NOT EXISTS chat_api_private;
REVOKE ALL ON SCHEMA chat_api_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA chat_api_private TO authenticated;
CREATE OR REPLACE FUNCTION chat_api_private.get_peer_profile(p_match_id uuid)
RETURNS TABLE(gender varchar, age integer, city varchar, bio text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.gender, p.age, p.city, p.bio
  FROM public.matches m JOIN public.profiles p ON p.id = ANY(m.participants)
  WHERE m.id = p_match_id AND auth.uid() IS NOT NULL
    AND auth.uid() = ANY(m.participants) AND p.id <> auth.uid()
    AND NOT public.is_banned()
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION chat_api_private.get_peer_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat_api_private.get_peer_profile(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.get_peer_profile(p_match_id uuid)
RETURNS TABLE(gender varchar, age integer, city varchar, bio text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM chat_api_private.get_peer_profile(p_match_id); $$;
REVOKE ALL ON FUNCTION public.get_peer_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_peer_profile(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';

-- Tunnel-only signaling. Does not modify other Supabase project tables.
-- Only the two active members can exchange their SDP descriptions.
CREATE TABLE IF NOT EXISTS public.tunnel_webrtc_signals (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('offer', 'answer')),
  sdp jsonb NOT NULL,
  negotiation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, sender_id)
);

ALTER TABLE public.tunnel_webrtc_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tunnel_webrtc_signals FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tunnel_webrtc_signals TO authenticated;

DROP POLICY IF EXISTS "Tunnel participants read signals" ON public.tunnel_webrtc_signals;
CREATE POLICY "Tunnel participants read signals"
ON public.tunnel_webrtc_signals FOR SELECT TO authenticated
USING (
  NOT (SELECT public.is_banned())
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND (SELECT auth.uid()) = ANY(m.participants)
  )
);

DROP POLICY IF EXISTS "Tunnel participants create own signals" ON public.tunnel_webrtc_signals;
CREATE POLICY "Tunnel participants create own signals"
ON public.tunnel_webrtc_signals FOR INSERT TO authenticated
WITH CHECK (
  NOT (SELECT public.is_banned())
  AND sender_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND (SELECT auth.uid()) = ANY(m.participants)
  )
);

DROP POLICY IF EXISTS "Tunnel participants replace own signals" ON public.tunnel_webrtc_signals;
CREATE POLICY "Tunnel participants replace own signals"
ON public.tunnel_webrtc_signals FOR UPDATE TO authenticated
USING (
  sender_id = (SELECT auth.uid())
  AND NOT (SELECT public.is_banned())
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND (SELECT auth.uid()) = ANY(m.participants)
  )
)
WITH CHECK (
  sender_id = (SELECT auth.uid())
  AND NOT (SELECT public.is_banned())
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND (SELECT auth.uid()) = ANY(m.participants)
  )
);

-- Prevent anonymous API access to private Tunnel data.
REVOKE ALL ON public.profiles, public.matches, public.messages,
 public.matching_pool, public.chat_reports, public.admin_takeovers,
 public.topic_cards, public.topic_categories FROM anon;

-- Browser users receive only the operations the current frontend needs.
-- In particular, RLS does NOT protect against TRUNCATE.
REVOKE ALL ON TABLE
  public.matches, public.messages, public.profiles, public.matching_pool,
  public.chat_reports, public.admin_takeovers, public.topic_categories,
  public.topic_cards, public.tunnel_webrtc_signals
FROM authenticated;
GRANT SELECT ON public.matches, public.admin_takeovers TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;
-- Protect role, admin_until, reputation_score from browser-controlled updates.
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;
GRANT INSERT (id) ON public.profiles TO authenticated;
GRANT UPDATE (
 nickname, gender, age, city, job, bio, opening_message, lat, lng,
 location_updated_at, device_fingerprint, last_ip, last_ip_location_zh,
 status, updated_at
) ON public.profiles TO authenticated;
GRANT SELECT, DELETE ON public.matching_pool TO authenticated;
GRANT SELECT ON public.messages TO authenticated;
GRANT INSERT (id, match_id, sender_id, content, type) ON public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.chat_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.topic_categories, public.topic_cards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tunnel_webrtc_signals TO authenticated;

-- Participants may remove only their own active-room signaling records.
DROP POLICY IF EXISTS "Tunnel participants remove own signal" ON public.tunnel_webrtc_signals;
CREATE POLICY "Tunnel participants remove own signal"
ON public.tunnel_webrtc_signals FOR DELETE TO authenticated
USING (
  sender_id = (SELECT auth.uid())
  AND NOT (SELECT public.is_banned())
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND (SELECT auth.uid()) = ANY(m.participants)
  )
);

-- Housekeeping: call public.tunnel_housekeeping() periodically via pg_cron
-- if your Supabase installation has pg_cron enabled. Do not schedule the job
-- against the shared project without confirming existing cron task names.
CREATE INDEX IF NOT EXISTS idx_tunnel_signals_cleanup ON public.tunnel_webrtc_signals(created_at);
CREATE OR REPLACE FUNCTION public.tunnel_housekeeping()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 DELETE FROM public.matching_pool WHERE last_ping_at < now() - interval '20 seconds';
 DELETE FROM public.tunnel_webrtc_signals s
 WHERE s.created_at < now() - interval '3 hours'
    OR NOT EXISTS (SELECT 1 FROM public.matches m WHERE m.id = s.match_id AND m.is_active = true);
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_housekeeping() FROM PUBLIC, anon, authenticated;

-- Atomic ban is part of the clean schema (no historical patch dependency).
CREATE OR REPLACE FUNCTION public.tunnel_admin_ban_user(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_room record;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only Tunnel administrators can ban a user' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Administrators cannot ban their own account';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF v_role = 'admin' THEN
    RAISE EXCEPTION 'Cannot ban an administrator through this workflow';
  END IF;
  UPDATE public.profiles SET status='banned', updated_at=now() WHERE id=p_user_id;
  DELETE FROM public.matching_pool WHERE user_id=p_user_id;
  FOR v_room IN
    UPDATE public.matches
    SET is_active=false, ended_reason='banned', ended_at=now()
    WHERE is_active=true AND p_user_id=ANY(participants)
    RETURNING participants
  LOOP
    UPDATE public.profiles p SET status='online'
    WHERE p.id=ANY(v_room.participants)
      AND p.id<>p_user_id
      AND p.status='chatting'
      AND NOT EXISTS (SELECT 1 FROM public.matches m WHERE m.is_active=true AND p.id=ANY(m.participants));
  END LOOP;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_admin_ban_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tunnel_admin_ban_user(uuid) TO authenticated;

-- IP abuse moderation included for new installations; legacy script is a
-- one-time upgrade path for existing projects.
-- CHAT IP and phrase moderation. No user-facing access to private source/bans tables.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_device TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_browser TEXT;

CREATE TABLE IF NOT EXISTS private.tunnel_message_sources (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  ip INET,
  ip_source TEXT NOT NULL CHECK (ip_source IN ('gateway','profile_latest','unknown')),
  location_zh TEXT,
  device TEXT,
  browser TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tunnel_message_sources_ip_idx ON private.tunnel_message_sources(ip);
CREATE INDEX IF NOT EXISTS tunnel_messages_recent_text_idx ON public.messages(created_at DESC) WHERE type = 'text';

CREATE TABLE IF NOT EXISTS private.tunnel_ip_bans (
  ip INET PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tunnel_ip_bans_expiry_idx ON private.tunnel_ip_bans(expires_at);
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.tunnel_safe_ip(p_value TEXT)
RETURNS INET LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF NULLIF(btrim(p_value), '') IS NULL THEN RETURN NULL; END IF;
  RETURN btrim(p_value)::inet;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_request_ip()
RETURNS INET LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE v_headers JSONB; v_forwarded TEXT;
BEGIN
  v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  -- Standard Supabase/PostgREST gateway header, never from profile input.
  v_forwarded := NULLIF(btrim(split_part(COALESCE(v_headers->>'x-forwarded-for', ''), ',', 1)), '');
  IF v_forwarded IS NULL THEN RETURN NULL; END IF;
  RETURN v_forwarded::inet;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_request_ip() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tunnel_request_ip() TO authenticated;

CREATE OR REPLACE FUNCTION private.tunnel_capture_message_source()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, private AS $$
DECLARE v_profile RECORD; v_ip INET;
BEGIN
  SELECT last_ip,last_ip_location_zh,last_device,last_browser INTO v_profile
  FROM public.profiles WHERE id = NEW.sender_id;
  v_ip := public.tunnel_request_ip();
  INSERT INTO private.tunnel_message_sources(message_id,ip,ip_source,location_zh,device,browser)
  VALUES (
    NEW.id,
    COALESCE(v_ip, private.tunnel_safe_ip(v_profile.last_ip)),
    CASE WHEN v_ip IS NOT NULL THEN 'gateway'
         WHEN private.tunnel_safe_ip(v_profile.last_ip) IS NOT NULL THEN 'profile_latest'
         ELSE 'unknown' END,
    v_profile.last_ip_location_zh,v_profile.last_device,v_profile.last_browser
  ) ON CONFLICT (message_id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tunnel_message_ip_snapshot ON public.messages;
CREATE TRIGGER tunnel_message_ip_snapshot AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.tunnel_capture_message_source();
REVOKE ALL ON FUNCTION private.tunnel_capture_message_source() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.is_banned()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, private AS $$
DECLARE v_ip INET;
BEGIN
  -- Keep administrators able to revoke accidentally overbroad bans in app.
  IF public.is_admin() THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND status='banned') THEN
    RETURN TRUE;
  END IF;
  v_ip := public.tunnel_request_ip();
  RETURN v_ip IS NOT NULL AND EXISTS (
    SELECT 1 FROM private.tunnel_ip_bans WHERE ip=v_ip AND expires_at > now()
  );
END;
$$;
REVOKE ALL ON FUNCTION public.is_banned() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_banned() TO authenticated;

CREATE OR REPLACE FUNCTION public.tunnel_access_allowed()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public AS $$
  SELECT auth.uid() IS NOT NULL AND NOT public.is_banned();
$$;
REVOKE ALL ON FUNCTION public.tunnel_access_allowed() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_access_allowed() TO authenticated;

CREATE OR REPLACE FUNCTION private.tunnel_ban_period(p_duration TEXT)
RETURNS INTERVAL LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN CASE p_duration
    WHEN '5m' THEN interval '5 minutes'
    WHEN '30m' THEN interval '30 minutes'
    WHEN '1h' THEN interval '1 hour'
    WHEN '6h' THEN interval '6 hours'
    WHEN '24h' THEN interval '24 hours'
    WHEN '7d' THEN interval '7 days'
    WHEN '30d' THEN interval '30 days'
    WHEN '1y' THEN interval '1 year'
    WHEN '10y' THEN interval '10 years'
    ELSE NULL END;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_phrase_ranking(p_hours INTEGER DEFAULT 24)
RETURNS TABLE(phrase TEXT, message_count BIGINT, sender_count BIGINT, ip_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog,public,private AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  IF p_hours NOT IN (1,6,24) THEN RAISE EXCEPTION 'Unsupported time range'; END IF;
  RETURN QUERY
  SELECT regexp_replace(btrim(m.content), '[[:space:]]+', ' ', 'g') AS phrase,
         count(*) AS message_count,
         count(DISTINCT m.sender_id) AS sender_count,
         count(DISTINCT CASE WHEN s.ip_source='gateway' THEN s.ip END) AS ip_count
  FROM public.messages m
  LEFT JOIN private.tunnel_message_sources s ON s.message_id=m.id
  LEFT JOIN public.profiles p ON p.id=m.sender_id
  WHERE m.type='text' AND m.created_at >= now()-make_interval(hours=>p_hours)
    AND length(btrim(m.content))>0
    AND COALESCE(p.role,'user')<>'admin'
  GROUP BY 1 ORDER BY message_count DESC, sender_count DESC, phrase ASC LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_phrase_sources(p_hours INTEGER,p_phrase TEXT)
RETURNS TABLE(ip TEXT, source_quality TEXT, country TEXT, region TEXT, district TEXT, device TEXT, browser TEXT, message_count BIGINT, sender_count BIGINT, last_seen TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog,public,private AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  IF p_hours NOT IN (1,6,24) OR length(p_phrase) > 4000 THEN RAISE EXCEPTION 'Invalid query'; END IF;
  RETURN QUERY
  WITH hits AS (
    SELECT COALESCE(s.ip,private.tunnel_safe_ip(p.last_ip)) AS src_ip,
           CASE WHEN s.ip IS NOT NULL THEN s.ip_source ELSE 'profile_latest' END AS quality,
           COALESCE(s.location_zh,p.last_ip_location_zh,'') AS loc,
           COALESCE(s.device,p.last_device,'') AS dev,
           COALESCE(s.browser,p.last_browser,'') AS brow,
           m.sender_id AS uid,m.created_at AS at
    FROM public.messages m
    LEFT JOIN private.tunnel_message_sources s ON s.message_id=m.id
    LEFT JOIN public.profiles p ON p.id=m.sender_id
    WHERE m.type='text' AND m.created_at >= now()-make_interval(hours=>p_hours)
      AND regexp_replace(btrim(m.content),'[[:space:]]+',' ','g')=p_phrase
      AND COALESCE(p.role,'user')<>'admin'
  )
  SELECT host(h.src_ip),
         CASE WHEN bool_and(h.quality='gateway') THEN 'gateway' ELSE 'estimated' END,
         NULLIF(split_part(max(h.loc),'／',1),''),
         NULLIF(split_part(max(h.loc),'／',2),''),
         NULLIF(split_part(max(h.loc),'／',3),''),
         NULLIF(max(h.dev),''),
         NULLIF(max(h.brow),''),
         count(*),count(DISTINCT h.uid),max(h.at)
  FROM hits h
  GROUP BY h.src_ip
  ORDER BY count(*) DESC, h.src_ip::text NULLS LAST LIMIT 300;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_ban_ip(p_ip TEXT,p_duration TEXT,p_reason TEXT DEFAULT '手動封鎖')
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,private AS $$
DECLARE v_ip INET; v_period INTERVAL; v_until TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  v_ip := private.tunnel_safe_ip(p_ip);
  v_period := private.tunnel_ban_period(p_duration);
  IF v_ip IS NULL OR v_period IS NULL THEN RAISE EXCEPTION 'Invalid IP or duration'; END IF;
  IF v_ip = public.tunnel_request_ip() THEN RAISE EXCEPTION 'Cannot ban your current IP'; END IF;
  v_until := now()+v_period;
  INSERT INTO private.tunnel_ip_bans(ip,expires_at,reason,created_by)
  VALUES (v_ip,v_until,left(coalesce(p_reason,''),400),auth.uid())
  ON CONFLICT(ip) DO UPDATE SET expires_at=EXCLUDED.expires_at,
    reason=EXCLUDED.reason,created_by=EXCLUDED.created_by,created_at=now()
  RETURNING expires_at INTO v_until;
  RETURN v_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_ban_phrase(p_hours INTEGER,p_phrase TEXT,p_duration TEXT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,private AS $$
DECLARE v_period INTERVAL; v_count INTEGER; v_own_ip INET;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  v_period:=private.tunnel_ban_period(p_duration);
  IF p_hours NOT IN (1,6,24) OR v_period IS NULL OR length(p_phrase)>4000 OR length(btrim(p_phrase))=0
     THEN RAISE EXCEPTION 'Invalid moderation request'; END IF;
  v_own_ip:=public.tunnel_request_ip();
  WITH sources AS (
    SELECT DISTINCT s.ip AS ip
    FROM public.messages m
    LEFT JOIN private.tunnel_message_sources s ON s.message_id=m.id
    LEFT JOIN public.profiles p ON p.id=m.sender_id
    WHERE m.type='text' AND m.created_at >= now()-make_interval(hours=>p_hours)
      AND regexp_replace(btrim(m.content),'[[:space:]]+',' ','g')=p_phrase
      AND COALESCE(p.role,'user')<>'admin'
      AND s.ip_source='gateway'
  ), changed AS (
    INSERT INTO private.tunnel_ip_bans(ip,expires_at,reason,created_by)
      SELECT ip,now()+v_period,'常見文字：'||left(p_phrase,300),auth.uid()
      FROM sources WHERE ip IS NOT NULL AND (v_own_ip IS NULL OR ip<>v_own_ip)
    ON CONFLICT(ip) DO UPDATE SET
      expires_at=GREATEST(private.tunnel_ip_bans.expires_at,EXCLUDED.expires_at),
      reason=EXCLUDED.reason,created_by=EXCLUDED.created_by,created_at=now()
    RETURNING ip
  ) SELECT count(*) INTO v_count FROM changed;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_list_ip_bans()
RETURNS TABLE(ip TEXT, expires_at TIMESTAMPTZ, reason TEXT, created_at TIMESTAMPTZ, is_active BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog,public,private AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  RETURN QUERY SELECT host(b.ip),b.expires_at,b.reason,b.created_at,b.expires_at>now()
  FROM private.tunnel_ip_bans b ORDER BY (b.expires_at>now()) DESC,b.created_at DESC LIMIT 300;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_unban_ip(p_ip TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,private AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  DELETE FROM private.tunnel_ip_bans WHERE ip=private.tunnel_safe_ip(p_ip);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION private.tunnel_safe_ip(TEXT),private.tunnel_ban_period(TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.tunnel_admin_phrase_ranking(INTEGER),public.tunnel_admin_phrase_sources(INTEGER,TEXT),
  public.tunnel_admin_ban_ip(TEXT,TEXT,TEXT),public.tunnel_admin_ban_phrase(INTEGER,TEXT,TEXT),
  public.tunnel_admin_list_ip_bans(),public.tunnel_admin_unban_ip(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_admin_phrase_ranking(INTEGER),public.tunnel_admin_phrase_sources(INTEGER,TEXT),
  public.tunnel_admin_ban_ip(TEXT,TEXT,TEXT),public.tunnel_admin_ban_phrase(INTEGER,TEXT,TEXT),
  public.tunnel_admin_list_ip_bans(),public.tunnel_admin_unban_ip(TEXT) TO authenticated;

-- Single RLS-respecting check for moderation + chat room state.
CREATE OR REPLACE FUNCTION public.tunnel_room_control(p_match_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'allowed', public.tunnel_access_allowed(),
    'is_active', room.is_active,
    'is_taken_over', room.is_taken_over,
    'takeover_target', room.takeover_target
  )
  FROM (SELECT 1) driver
  LEFT JOIN LATERAL (
    SELECT m.is_active, m.is_taken_over, m.takeover_target
    FROM public.matches m WHERE m.id = p_match_id
  ) room ON true;
$$;
REVOKE ALL ON FUNCTION public.tunnel_room_control(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tunnel_room_control(uuid) TO authenticated;
