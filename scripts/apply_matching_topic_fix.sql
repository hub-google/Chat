ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS distance_km DOUBLE PRECISION;

INSERT INTO public.profiles (id, status)
SELECT id, 'offline' FROM auth.users
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile"
ON public.profiles FOR INSERT TO authenticated
WITH CHECK (auth.uid() = id AND role = 'user');

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

CREATE OR REPLACE FUNCTION public.fn_match_user(
    p_user_id UUID, p_intent VARCHAR(20), p_gender VARCHAR(10) DEFAULT NULL,
    p_target_gender VARCHAR(10) DEFAULT 'any', p_city VARCHAR(20) DEFAULT NULL,
    p_age INTEGER DEFAULT NULL, p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL, p_max_distance_km INTEGER DEFAULT NULL,
    p_distance_mode VARCHAR(20) DEFAULT 'nearest'
) RETURNS TABLE (match_id UUID, matched_user_id UUID) AS $$
DECLARE v_target_row RECORD; v_new_match_id UUID;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id OR public.is_banned() THEN
    RAISE EXCEPTION 'Not authorized to match this user.';
  END IF;

  SELECT * INTO v_target_row FROM public.matching_pool
   WHERE status='waiting' AND user_id<>p_user_id AND intent=p_intent
     AND (p_target_gender='any' OR p_target_gender IS NULL OR gender IS NULL OR gender=p_target_gender)
     AND (target_gender='any' OR target_gender IS NULL OR p_gender IS NULL OR target_gender=p_gender)
     AND (p_max_distance_km IS NULL OR p_lat IS NULL OR p_lng IS NULL OR lat IS NULL OR lng IS NULL OR public.haversine_distance(p_lat,p_lng,lat,lng)<=p_max_distance_km)
     AND (max_distance_km IS NULL OR p_lat IS NULL OR p_lng IS NULL OR lat IS NULL OR lng IS NULL OR public.haversine_distance(p_lat,p_lng,lat,lng)<=max_distance_km)
     AND (p_distance_mode<>'farthest' OR p_lat IS NULL OR p_lng IS NULL OR lat IS NULL OR lng IS NULL OR public.haversine_distance(p_lat,p_lng,lat,lng)>=50)
     AND (distance_mode<>'farthest' OR p_lat IS NULL OR p_lng IS NULL OR lat IS NULL OR lng IS NULL OR public.haversine_distance(p_lat,p_lng,lat,lng)>=50)
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
