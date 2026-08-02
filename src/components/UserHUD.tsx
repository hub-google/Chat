'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useMatchStore } from '../store/matchStore';
import { DistanceSlider } from './DistanceSlider';
import { Search } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { generateDeviceFingerprint } from '../lib/fingerprint';
import { getUserId } from '../lib/user';
import { getIpLocation } from '../lib/ipLocation';

export function UserHUD() {
  const { status, setStatus, setMatch, intent, setIntent, distanceMode, distanceKm, openingMessage, setOpeningMessage } = useMatchStore();
  const [panicMode, setPanicMode] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('尋找配對中...');
  const [errorMsg, setErrorMsg] = useState('');
  
  const [profile, setProfile] = useState({ gender: '', age: '', city: '', bio: '' });
  
  const pingInterval = useRef<NodeJS.Timeout | null>(null);
  const userIdRef = useRef<string | null>(null);
  const matchingStartedAt = useRef(0);
  const matchingParams = useRef<{
    userId: string;
    intent: string;
    lat: number | null;
    lng: number | null;
    distanceMode: string;
    distanceKm: number;
  } | null>(null);
  const matchingAttemptRunning = useRef(false);

  useEffect(() => {
    void getUserId()
      .then(async id => { 
        userIdRef.current = id;
        const { data } = await supabase.from('profiles').select('gender, age, city, bio, opening_message').eq('id', id).single();
        if (data) {
          setProfile({
            gender: data.gender || '',
            age: data.age?.toString() || '',
            city: data.city || '',
            bio: data.bio || ''
          });
          if (data.opening_message) setOpeningMessage(data.opening_message);
        }
      })
      // Home owns the visible authentication error state. Avoid an unhandled
      // rejection if this background warm-up happens to share that failure.
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handlePageHide = () => {
       if (userIdRef.current && status === 'waiting') {
         // This app is statically exported, so it cannot provide a POST Route
         // Handler. Start the RLS-protected Supabase cleanup while the page is
         // still alive; stale rows are also excluded by the heartbeat timeout.
         void supabase.from('matching_pool').delete().eq('user_id', userIdRef.current);
       }
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [status]);

  useEffect(() => {
    const handleTouch = (e: TouchEvent) => {
      if (e.touches.length >= 2) window.location.replace('https://www.google.com');
    };
    const handleMotion = (e: DeviceMotionEvent) => {
      const acc = e.acceleration;
      if (acc && acc.x && acc.y && acc.z) {
        const shake = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
        if (shake > 15) window.location.replace('https://www.google.com');
      }
    };
    window.addEventListener('touchstart', handleTouch);
    window.addEventListener('devicemotion', handleMotion);
    return () => {
      window.removeEventListener('touchstart', handleTouch);
      window.removeEventListener('devicemotion', handleMotion);
    };
  }, []);

  useEffect(() => {
    let escCount = 0;
    let escTimeout: NodeJS.Timeout;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        escCount++;
        if (escCount >= 2) setPanicMode(true);
        clearTimeout(escTimeout);
        escTimeout = setTimeout(() => { escCount = 0; }, 500);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    // Watch for match assignment by another user
    if (status === 'waiting') {
      let isSubscribed = true;
      const watchMatch = async () => {
        let userId: string;
        try {
          userId = await getUserId();
        } catch (error) {
          if (isSubscribed) {
            setStatus('idle');
            setErrorMsg(error instanceof Error ? error.message : '匿名連線失敗。');
          }
          return;
        }
        
        const channel = supabase.channel('matching')
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'matches' },
            (payload) => {
              const participants = payload.new.participants as string[];
              if (participants.includes(userId)) {
                if (isSubscribed) setMatch(payload.new.id);
              }
            }
          )
          .subscribe();

        // Re-run the atomic matcher every heartbeat. Merely updating the row
        // cannot discover users who joined after the first RPC call.
        pingInterval.current = setInterval(async () => {
           const params = matchingParams.current;
           if (params && !matchingAttemptRunning.current) {
             matchingAttemptRunning.current = true;
             const elapsed = Date.now() - matchingStartedAt.current;
             const isUnlimited = elapsed >= 30000 || params.distanceMode === 'unlimited';
             const effectiveMode = isUnlimited ? 'unlimited' : params.distanceMode;
             const effectiveKm = isUnlimited || params.distanceMode === 'farthest'
               ? null
               : elapsed >= 10000 ? params.distanceKm * 2 : params.distanceKm;
             const { data, error } = await supabase.rpc('fn_match_user', {
               p_user_id: params.userId,
               p_intent: params.intent,
               p_lat: params.lat,
               p_lng: params.lng,
               p_max_distance_km: effectiveKm,
               p_distance_mode: effectiveMode,
             });
             matchingAttemptRunning.current = false;
             if (error && isSubscribed) setErrorMsg(`配對連線中斷：${error.message}`);
             const matched = data?.[0];
             if (matched?.match_id && isSubscribed) setMatch(matched.match_id);
           }
           
           // 2. Fallback check: in case we missed the Realtime INSERT event
           if (isSubscribed) {
             const { data: activeMatch } = await supabase
               .from('matches')
               .select('id')
               .contains('participants', [userId])
               .eq('is_active', true)
               .order('created_at', { ascending: false })
               .limit(1)
               .maybeSingle();
               
             if (activeMatch && activeMatch.id) {
               setMatch(activeMatch.id);
             }
           }
        }, 4000);

        return () => {
          isSubscribed = false;
          supabase.removeChannel(channel);
          if (pingInterval.current) clearInterval(pingInterval.current);
          // Delete from pool when unmounting/leaving waiting
          void supabase.from('matching_pool').delete().eq('user_id', userId);
        };
      };
      
      const cleanupPromise = watchMatch();
      
      return () => {
        cleanupPromise.then(cleanup => cleanup && cleanup());
      };
    }
  }, [status, setMatch, setStatus]);

  const handleStartMatching = async () => {
    const lastMatchTime = localStorage.getItem('last_match_time');
    if (lastMatchTime && Date.now() - parseInt(lastMatchTime, 10) < 5000) {
      setErrorMsg('配對頻率過高（安全防護限制），請等候 5 秒再試。');
      return;
    }
    setStatus('waiting');
    setErrorMsg('');
    setLoadingMsg('獲取定位與安全指紋中...');
    
    try {
      const fingerprint = await generateDeviceFingerprint();
      const userId = await getUserId();
      userIdRef.current = userId;
      const ipLocation = await getIpLocation();

      let lat = null;
      let lng = null;
      let preciseLocationGranted = false;

      try {
        if (!navigator.geolocation) throw new Error('No geolocation object');
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 3000 });
        });
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
        preciseLocationGranted = true;
      } catch (geoErr) {
        lat = ipLocation?.latitude ?? null;
        lng = ipLocation?.longitude ?? null;
        console.warn('Geolocation permission unavailable; using approximate IP location');
      }

      // 防禦性檢查：如果使用者在取得定位期間按下了「取消搜尋」，則終止後續配對流程
      if (useMatchStore.getState().status !== 'waiting') {
        return;
      }

      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          device_fingerprint: fingerprint,
          ...(ipLocation ? {
            last_ip: ipLocation.ip,
            last_ip_location_zh: ipLocation.locationZh,
          } : {}),
          lat: lat === null ? null : Number(lat.toFixed(2)),
          lng: lng === null ? null : Number(lng.toFixed(2)),
          location_updated_at: new Date().toISOString(),
          status: 'matching',
          gender: profile.gender || null,
          age: profile.age ? parseInt(profile.age, 10) : null,
          city: profile.city || null,
          bio: profile.bio || null,
          opening_message: openingMessage || null
        })
        .eq('id', userId);
      if (profileError) throw new Error(`匿名資料初始化失敗：${profileError.message}`);

      setLoadingMsg('尋找配對中...');
      // Only throttle requests that actually reached the matching operation.
      // Authentication/geolocation setup failures should remain immediately retryable.
      localStorage.setItem('last_match_time', Date.now().toString());
      matchingStartedAt.current = Date.now();
      matchingParams.current = { userId, intent, lat, lng, distanceMode, distanceKm };
      setLoadingMsg(preciseLocationGranted ? '尋找配對中...' : '使用大略位置尋找配對中...');
      
      const { data, error } = await supabase.rpc('fn_match_user', {
        p_user_id: userId,
        p_intent: intent,
        p_lat: lat,
        p_lng: lng,
        p_max_distance_km: distanceMode === 'unlimited' || distanceMode === 'farthest' ? null : distanceKm,
        p_distance_mode: distanceMode
      });

      if (error) {
        console.error('Match error', error);
        throw new Error(`配對發生錯誤: ${error.message}`);
      }

      const matchData = data?.[0];
      if (matchData && matchData.match_id) {
        setMatch(matchData.match_id); // Instant match!
      }
    } catch (err: any) {
      console.error(err);
      setStatus('idle');
      setErrorMsg(err.message || '發生未知錯誤，請稍後再試。');
    }
  };

  const cancelMatching = async () => {
    matchingParams.current = null;
    setStatus('idle');
    setErrorMsg('');
    try {
      const userId = await getUserId();
      const { error } = await supabase.from('matching_pool').delete().eq('user_id', userId);
      if (error) setErrorMsg(`取消配對失敗：${error.message}`);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : '取消配對失敗。');
    }
  };

  if (panicMode) {
    return (
      <div style={{ padding: 40, fontFamily: 'serif', background: '#fff', color: '#000', height: '100vh', width: '100vw', position: 'fixed', top: 0, left: 0, zIndex: 9999 }}>
        <h1>The Daily News</h1>
        <p>Market hits record highs today...</p>
      </div>
    );
  }

  if (status !== 'idle' && status !== 'waiting') return null;

  const getIntentBackground = () => {
    switch (intent) {
      case 'venting': return 'radial-gradient(circle at 80% 20%, rgba(239, 68, 68, 0.15), transparent 50%)';
      case 'stimulation': return 'radial-gradient(circle at 20% 20%, rgba(234, 179, 8, 0.15), transparent 50%)';
      case 'chill': default: return 'radial-gradient(circle at 50% 50%, rgba(59, 130, 246, 0.15), transparent 60%)';
    }
  };

  return (
    <>
    <div className="tunnel-atmosphere" style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
      background: getIntentBackground(), 
      transition: 'background 0.8s ease', 
      zIndex: -1 
    }} />
    <div className="match-lobby" style={{ maxWidth: '600px', margin: '40px auto', padding: '20px', position: 'relative' }}>
      <div className="tunnel-brand" style={{ textAlign: 'center', marginBottom: '30px' }} onDoubleClick={() => setPanicMode(true)}>
        <h1 style={{ fontSize: '2.5rem', background: 'var(--gradient-primary)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', cursor: 'pointer' }}>
          Tunnel
        </h1>
        <p style={{ color: 'var(--text-secondary)' }}>純粹匿名，拋開標籤，找回對話的本質。</p>
      </div>

      <DistanceSlider />

      <div className="match-action" style={{ display: 'flex', justifyContent: 'center', marginTop: '40px' }}>
        <button
          onClick={status === 'waiting' ? cancelMatching : handleStartMatching}
          style={{
            background: status === 'waiting' ? '#ff4d4f' : 'var(--color-primary)',
            color: 'white',
            border: 'none',
            padding: '16px 40px',
            borderRadius: '30px',
            fontSize: '18px',
            fontWeight: 'bold',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            boxShadow: '0 8px 20px rgba(59, 130, 246, 0.3)',
            transition: 'transform 0.2s',
          }}
        >
          {status === 'waiting' ? (
            <>
              <div className="spinner" style={{ width: 20, height: 20, border: '3px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
              取消搜尋
            </>
          ) : (
            <>
              <Search size={22} />
              開始匿名配對
            </>
          )}
        </button>
      </div>
      {status === 'waiting' && <div style={{ textAlign: 'center', marginTop: 16, color: 'var(--text-secondary)' }}>{loadingMsg}</div>}
      {errorMsg && <div style={{ textAlign: 'center', marginTop: 16, color: '#ff4d4f', background: 'rgba(255, 77, 79, 0.1)', padding: '12px', borderRadius: '8px', border: '1px solid #ff4d4f' }}>🚨 錯誤：{errorMsg}</div>}
      
      <div className="profile-sheet" style={{ background: 'white', padding: '24px', borderRadius: '16px', marginTop: '40px', marginBottom: '24px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
        <h3 style={{ marginTop: 0, marginBottom: '16px', color: 'var(--text-primary)', fontSize: '16px' }}>個人資料 (選填)</h3>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: 'var(--text-secondary)' }}>性別</label>
            <select value={profile.gender} onChange={e => setProfile({...profile, gender: e.target.value})} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', color: 'black', background: '#f8fafc' }} disabled={status === 'waiting'}>
              <option value="">不公開</option>
              <option value="male">男性</option>
              <option value="female">女性</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: 'var(--text-secondary)' }}>年齡</label>
            <input type="number" min="18" max="99" value={profile.age} onChange={e => setProfile({...profile, age: e.target.value})} placeholder="例如: 24" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', color: 'black', background: '#f8fafc' }} disabled={status === 'waiting'} />
          </div>
        </div>
        
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: 'var(--text-secondary)' }}>居住城市</label>
          <input type="text" maxLength={20} value={profile.city} onChange={e => setProfile({...profile, city: e.target.value})} placeholder="例如: 台北市" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', color: 'black', background: '#f8fafc' }} disabled={status === 'waiting'} />
        </div>
        
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: 'var(--text-secondary)' }}>想聊什麼 / 自介標籤</label>
          <input type="text" maxLength={50} value={profile.bio} onChange={e => setProfile({...profile, bio: e.target.value})} placeholder="例如: 想聊點輕鬆的、喜歡電影" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ddd', color: 'black', background: '#f8fafc' }} disabled={status === 'waiting'} />
        </div>

        <div style={{ marginBottom: '8px' }}>
          <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: 'var(--color-primary)', fontWeight: 600 }}>開場喊話 (配對成功後自動發送)</label>
          <input type="text" maxLength={100} value={openingMessage} onChange={e => setOpeningMessage(e.target.value)} placeholder="第一句話想說什麼呢？" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--color-primary)', color: 'black', background: '#eff6ff' }} disabled={status === 'waiting'} />
        </div>
      </div>
      
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes spin { 100% { transform: rotate(360deg); } }
      `}} />
    </div>
    </>
  );
}
