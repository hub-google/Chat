'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useMatchStore } from '../store/matchStore';
import { WebRTCManager } from '../lib/webrtc';
import { supabase } from '../lib/supabase';
import { TopicCards } from './TopicCards';
import { Send, Image as ImageIcon, LogOut, CheckCircle2, CheckCheck, Sparkles, AlertTriangle } from 'lucide-react';
import { saveToIDB, getAllFromIDB, deleteFromIDB } from '../lib/idb';
import { env } from '../lib/env';
import { getUserId } from '../lib/user';
import Image from 'next/image';

interface Message {
  id: string;
  sender: 'me' | 'peer' | 'system';
  text?: string;
  imageUrl?: string;
  timestamp: number;
  status?: 'sending' | 'sent' | 'delivered' | 'saved' | 'failed';
  error?: string;
}

export function ChatWindow() {
  const { matchId, status, reset, openingMessage } = useMatchStore();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);
  const [showTopicCards, setShowTopicCards] = useState(false);
  const [connectionState, setConnectionState] = useState<'connecting' | 'p2p' | 'fallback'>('connecting');
  const [notice, setNotice] = useState('');
  
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState('spam');
  const [reportDetails, setReportDetails] = useState('');
  
  const [peerLeft, setPeerLeft] = useState(false);
  const [panicMode, setPanicMode] = useState(false);
  const [showSuccessMsg, setShowSuccessMsg] = useState(false);
  const [peerProfile, setPeerProfile] = useState<{gender: string | null, age: number | null, city: string | null, bio: string | null} | null>(null);
  const [peerDistanceKm, setPeerDistanceKm] = useState<number | null>(null);
  
  const rtcManager = useRef<WebRTCManager | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeout = useRef<NodeJS.Timeout | null>(null);
  const lastTypingSentAt = useRef(0);
  const myUserId = useRef<string | null>(null);
  const openingMessageSent = useRef(false);
  const takeoverRole = useRef<'target' | 'remaining' | null>(null);

  useEffect(() => {
    void getUserId()
      .then((id) => { myUserId.current = id; })
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, peerTyping]);

  // Reset state when a new match starts
  useEffect(() => {
    if (matchId) {
      setMessages([]);
      setPeerLeft(false);
      setConnectionState('connecting');
      setNotice('');
      setPeerProfile(null);
      takeoverRole.current = null;
      openingMessageSent.current = false;
    }
  }, [matchId]);

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
    const handleOnline = async () => {
      if (status !== 'chatting' || !matchId) return;
      const failed = await getAllFromIDB();
      for (const msg of failed) {
        if (msg.match_id === matchId) {
          const { error } = await supabase.from('messages').insert(msg);
          if (!error) {
            await deleteFromIDB(msg.id);
            setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, status: 'saved', error: undefined } : m));
          }
        }
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [status, matchId]);

  useEffect(() => {
    if (connectionState === 'p2p' || connectionState === 'fallback') {
      setShowSuccessMsg(true);
      const timer = setTimeout(() => setShowSuccessMsg(false), 10000);
      
      if (matchId && openingMessage && !openingMessageSent.current) {
        openingMessageSent.current = true;
        void getUserId().then(async (userId) => {
          const storageKey = `opening-message-sent:${matchId}:${userId}`;
          if (localStorage.getItem(storageKey)) return;

          // A reload/new tab must not resend the opening line. Checking the
          // persisted conversation also covers browsers where storage was cleared.
          const { data, error } = await supabase
            .from('messages')
            .select('id')
            .eq('match_id', matchId)
            .eq('sender_id', userId)
            .limit(1);
          if (error || (data?.length ?? 0) > 0) {
            if (!error) localStorage.setItem(storageKey, '1');
            return;
          }

          localStorage.setItem(storageKey, '1');
          setTimeout(() => handleSendText(openingMessage), 600);
        }).catch(() => {});
      }
      
      return () => clearTimeout(timer);
    }
  }, [connectionState, matchId, openingMessage]);

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
    if (matchId && status === 'chatting') {
      const fetchProfile = async () => {
        const userId = await getUserId();
        const { data: matchData } = await supabase.from('matches').select('participants,distance_km').eq('id', matchId).single();
        if (matchData) {
           setPeerDistanceKm(typeof matchData.distance_km === 'number' ? matchData.distance_km : null);
           const peerId = matchData.participants.find((p: string) => p !== userId);
           if (peerId) {
             const { data: profile } = await supabase.from('profiles').select('gender, age, city, bio').eq('id', peerId).single();
             if (profile) setPeerProfile(profile);
           }
        }
      };
      void fetchProfile();
    }
  }, [matchId, status]);

  useEffect(() => {
    const handleUnload = (e: BeforeUnloadEvent) => {
      const hasUnsaved = messages.some(m => m.sender === 'me' && m.status !== 'saved');
      if (hasUnsaved) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [messages]);

  const handleLeave = useCallback(async (force = false) => {
    if (!force && !window.confirm('確定要離開聊天室嗎？')) return;
    
    rtcManager.current?.sendMessage({ type: 'leave' });
    
    setTimeout(async () => {
      rtcManager.current?.close();
      if (matchId) {
        await supabase.rpc('leave_match', { p_match_id: matchId }).then(({ error }) => {
          if (error) console.error('Failed to close match', error);
        });
      }
      reset();
    }, 500);
  }, [matchId, reset]);

  useEffect(() => {
    if (status === 'chatting' && matchId) {
      const setupRTC = async () => {
         const userId = myUserId.current ?? await getUserId();
         myUserId.current = userId;
         const { data: matchData, error: matchError } = await supabase
           .from('matches')
           .select('participants, is_active, is_taken_over, takeover_target')
           .eq('id', matchId)
           .single();
         const isTakenOverUser = matchData?.is_taken_over && matchData.takeover_target === userId;
         if (matchError || (!matchData?.participants?.includes(userId) && !isTakenOverUser)) {
           setNotice(`無法讀取聊天室：${matchError?.message ?? '您不是此聊天室的成員'}`);
           reset();
           return;
         }
         if (isTakenOverUser) {
           takeoverRole.current = 'target';
           setPeerLeft(true);
           setNotice('對方已離開');
           setConnectionState('fallback');
           return;
         }
         if (matchData.is_active === false) {
           setPeerLeft(true);
           setNotice('對方已離開聊天室。');
           setConnectionState('fallback');
           return;
         }
         const isInitiator = userId === matchData.participants[0];

         rtcManager.current = new WebRTCManager((msg) => {
           if (msg.type === 'leave') {
             setNotice('對方已離開聊天室。');
             setPeerLeft(true);
           } else if (msg.type === 'typing') {
             setPeerTyping(msg.isTyping);
             if (typingTimeout.current) clearTimeout(typingTimeout.current);
             if (msg.isTyping) {
               typingTimeout.current = setTimeout(() => setPeerTyping(false), 3000);
             }
           } else if (msg.type === 'ack') {
             setMessages(prev => prev.map(m => m.id === msg.id && m.status !== 'saved' ? { ...m, status: 'delivered' } : m));
          } else if (msg.type === 'chat') {
             if (takeoverRole.current === 'target') return;
             setMessages((prev) => [...prev, { ...msg.message, sender: 'peer' }]);
             rtcManager.current?.sendMessage({ type: 'ack', id: msg.message.id });
           }
         }, (state) => setConnectionState(state === 'open' ? 'p2p' : 'fallback'));
         await rtcManager.current.initConnection(matchId, isInitiator);
      };
      void setupRTC().catch((error: unknown) => {
        setConnectionState('fallback');
        setNotice(error instanceof Error ? error.message : 'P2P 連線失敗，已切換資料庫通道。');
      });

      void getUserId().then(async (userId) => {
        myUserId.current = userId;
        const { data: currentMatch } = await supabase
          .from('matches')
          .select('is_taken_over,takeover_target,takeover_at')
          .eq('id', matchId)
          .single();
        const isTakeoverTarget = Boolean(currentMatch?.is_taken_over && currentMatch.takeover_target === userId);
        if (isTakeoverTarget) {
          takeoverRole.current = 'target';
          setPeerLeft(true);
        }
        const { data, error } = await supabase
          .from('messages')
          .select('id,sender_id,content,type,created_at')
          .eq('match_id', matchId)
          .lte('created_at', isTakeoverTarget && currentMatch?.takeover_at ? currentMatch.takeover_at : new Date().toISOString())
          .order('created_at', { ascending: true })
          .limit(100);
          if (error) {
            setNotice(`載入歷史訊息失敗：${error.message}`);
            return;
          }
          setMessages((data ?? []).filter((row) => !(row.type === 'system' && row.content?.includes('備用安全通道'))).map((row) => ({
            id: row.id,
            sender: row.sender_id === userId ? 'me' : row.type === 'system' ? 'system' : 'peer',
            ...(row.type === 'image' ? { imageUrl: row.content } : { text: row.content }),
            timestamp: new Date(row.created_at).getTime(),
            status: row.sender_id === userId ? 'saved' : undefined,
          })));
      }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : '無法確認使用者身分'));

      const channel = supabase.channel(`match_db_${matchId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `match_id=eq.${matchId}` }, (payload) => {
           if (takeoverRole.current === 'target') return;
           if (payload.new.type === 'system' && payload.new.content?.includes('備用安全通道')) return;
           if (payload.new.sender_id !== myUserId.current) {
             setMessages(prev => {
                if (prev.find(m => m.id === payload.new.id)) return prev;
                return [...prev, {
                  id: payload.new.id,
                  sender: payload.new.type === 'system' ? 'system' : 'peer',
                  ...(payload.new.type === 'image' ? { imageUrl: payload.new.content } : { text: payload.new.content }),
                  timestamp: new Date(payload.new.created_at).getTime(),
                }];
             });
           } else {
             setMessages(prev => prev.map(m => m.id === payload.new.id ? { ...m, status: 'saved' } : m));
           }
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${matchId}` }, (payload) => {
           if (payload.new.is_taken_over) {
             rtcManager.current?.close();
             setPeerTyping(false);
             setConnectionState('fallback');
             if (payload.new.takeover_target === myUserId.current) {
               takeoverRole.current = 'target';
               setNotice('對方已離開');
               setPeerLeft(true);
             } else {
               takeoverRole.current = 'remaining';
               // The remaining participant silently moves to the database
               // channel. The conversation continues with the administrator.
               setNotice('');
             }
           } else if (payload.new.is_active === false) {
             setNotice('對方已離開聊天室。');
             setPeerLeft(true);
           }
        })
        .subscribe();

      const takeoverChannel = supabase.channel(`takeover_notice_${matchId}`)
        .on('broadcast', { event: 'admin_takeover' }, ({ payload }) => {
          rtcManager.current?.close();
          setPeerTyping(false);
          setConnectionState('fallback');
          if (payload.targetUserId === myUserId.current) {
            takeoverRole.current = 'target';
            setPeerLeft(true);
            setNotice('對方已離開');
          } else {
            takeoverRole.current = 'remaining';
            setNotice('');
          }
        }).subscribe();

      const takeoverPoll = setInterval(async () => {
        const { data } = await supabase.from('matches').select('is_taken_over,takeover_target').eq('id', matchId).single();
        if (!data?.is_taken_over || takeoverRole.current) return;
        rtcManager.current?.close();
        setConnectionState('fallback');
        if (data.takeover_target === myUserId.current) {
          takeoverRole.current = 'target';
          setPeerLeft(true);
          setNotice('對方已離開');
        } else {
          takeoverRole.current = 'remaining';
          setNotice('');
        }
      }, 1000);

      return () => {
        clearInterval(takeoverPoll);
        rtcManager.current?.close();
        supabase.removeChannel(channel);
        supabase.removeChannel(takeoverChannel);
      };
    }
  }, [status, matchId, reset]);

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
    const now = Date.now();
    if (now - lastTypingSentAt.current >= 150 || e.target.value.length === 0) {
      lastTypingSentAt.current = now;
      rtcManager.current?.sendMessage({ type: 'typing', isTyping: e.target.value.length > 0 });
    }
  };

  const saveToDB = async (msg: Message) => {
    if (!matchId || !myUserId.current) {
      setMessages((prev) => prev.map((item) => item.id === msg.id ? { ...item, status: 'failed', error: '聊天室身分尚未就緒' } : item));
      return;
    }
    const payload = {
      id: msg.id,
      match_id: matchId,
      sender_id: myUserId.current,
      content: msg.text || msg.imageUrl,
      type: msg.imageUrl ? 'image' : 'text'
    };
    const { error } = await supabase.from('messages').insert(payload);
    
    if (error) {
      if (error.code === '42501' || error.message.includes('policy')) {
        setMessages(prev => prev.map(item => item.id === msg.id ? { ...item, status: 'saved' } : item));
        return;
      }
      
      await saveToIDB(payload);
      
      setMessages((prev) => prev.map((item) => item.id === msg.id ? { ...item, status: 'failed', error: '連線中斷，已儲存至離線佇列' } : item));
    } else {
      setMessages((prev) => prev.map((item) => item.id === msg.id ? { ...item, status: 'saved', error: undefined } : item));
    }
  };

  const submitReport = async () => {
    if (!matchId || !myUserId.current) return;
    const { data: matchData } = await supabase.from('matches').select('participants').eq('id', matchId).single();
    const targetId = matchData?.participants?.find((p: string) => p !== myUserId.current);
    if (!targetId) return;

    const snapshot = messages.length > 0 ? messages.slice(-10) : [];
    const { error } = await supabase.from('chat_reports').insert({
      reporter_id: myUserId.current,
      target_id: targetId,
      match_id: matchId,
      reason: reportReason,
      details: reportDetails,
      context_snapshot: snapshot
    });
    
    if (error) setNotice(`檢舉失敗：${error.message}`);
    else setNotice('已送出檢舉，管理員將盡快處理。');
    
    setShowReport(false);
    setReportDetails('');
  };

  async function handleSendText(text: string) {
    if (!text) return;

    if (matchId) {
      const { data } = await supabase.from('matches').select('is_taken_over,takeover_target').eq('id', matchId).single();
      if (data?.is_taken_over) {
        takeoverRole.current = data.takeover_target === myUserId.current ? 'target' : 'remaining';
        rtcManager.current?.close();
        setConnectionState('fallback');
      }
    }
    if (takeoverRole.current === 'target') {
      setPeerLeft(true);
      setNotice('對方已離開');
      return;
    }

    const sensitiveWords = /匯款|點數|投資|買賣|詐騙|援交/;
    if (sensitiveWords.test(text)) {
      setNotice('系統警示：系統偵測到敏感字詞，請注意不要匯款或提供個人資料，防範詐騙！');
      void supabase.from('chat_reports').insert({
        reporter_id: 'system',
        target_id: myUserId.current,
        match_id: matchId,
        reason: 'system_alert',
        details: 'System detected sensitive words: ' + text,
      });
    }

    // 防範連點發送訊息的 Race Condition
    const now = Date.now();
    if (now - (window as any)._lastSendTime < 300) return;
    (window as any)._lastSendTime = now;

    const newMsg: Message = {
      id: crypto.randomUUID(),
      sender: 'me',
      text: text,
      timestamp: 0,
      status: 'sent'
    };
    setMessages((prev) => [...prev, newMsg]);
    rtcManager.current?.sendMessage({ type: 'chat', message: newMsg });
    rtcManager.current?.sendMessage({ type: 'typing', isTyping: false });
    void saveToDB(newMsg);
  };

  const handleSend = () => {
    if (!input.trim() && !isUploading) return;
    void handleSendText(input.trim());
    setInput('');
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);

    try {
      const compressedBlob = await new Promise<Blob>((resolve, reject) => {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let { width, height } = img;
          if (width > 1024) {
            height = Math.round((height * 1024) / width);
            width = 1024;
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Canvas toBlob failed'));
          }, 'image/jpeg', 0.8);
        };
        img.onerror = () => reject(new Error('Image load error'));
      });

      const formData = new FormData();
      formData.append('image', compressedBlob, file.name);

      const apiKey = env.IMGBB_API_KEY;
      if (!apiKey) throw new Error('圖片空間金鑰尚未在建置環境中設定');
      const uploadUrl = `${env.IMGBB_UPLOAD_URL || 'https://api.imgbb.com/1/upload'}?key=${encodeURIComponent(apiKey)}`;
      
      const res = await fetch(uploadUrl, { method: 'POST', body: formData });
      const responseText = await res.text();
      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(`圖片服務回傳非 JSON 內容（HTTP ${res.status}），請檢查部署環境與上傳網址`);
      }
      
      if (!res.ok || !data.success) throw new Error(data?.error?.message || `圖片服務回傳 ${res.status}`);
      if (data.success) {
        const newMsg: Message = {
          id: crypto.randomUUID(),
          sender: 'me',
          imageUrl: data.data.url,
          timestamp: 0,
          status: 'sent'
        };
        setMessages((prev) => [...prev, newMsg]);
        rtcManager.current?.sendMessage({ type: 'chat', message: newMsg });
        void saveToDB(newMsg);
      }
    } catch (error) {
      console.error('Image upload failed', error);
      setNotice(error instanceof Error ? `圖片上傳失敗：${error.message}` : '圖片上傳失敗。');
    } finally {
      setIsUploading(false);
    }
  };

  if (status !== 'chatting') return null;

  return (
    <div className="chat-shell" style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: '600px', margin: '0 auto', background: 'var(--color-surface-light)', position: 'relative' }}>
      <div className="chat-topbar" onDoubleClick={() => setPanicMode(true)} style={{ padding: '16px', background: 'var(--gradient-primary)', color: 'white', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-success)', opacity: connectionState === 'connecting' ? 0.5 : 1 }} />
          <span style={{ fontWeight: 500 }}>
            {connectionState === 'connecting' ? '正在建立連線...' : showSuccessMsg ? '🎉 已配對成功' : '聊天中'}
          </span>
        </div>
        
        {peerProfile && (
          <div className="peer-card" style={{ padding: '16px', margin: '12px 16px', background: 'white', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', border: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>對方檔案</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            {[
              peerProfile.gender === 'male' ? '男生' : peerProfile.gender === 'female' ? '女生' : null,
              peerProfile.age ? `${peerProfile.age} 歲` : null,
              peerProfile.city,
              peerDistanceKm === null ? '距離無法估算' : `距離約 ${peerDistanceKm < 1 ? '< 1' : peerDistanceKm.toFixed(1)} km`
            ].filter(Boolean).map((item, i) => (
              <span key={i} style={{ background: '#eff6ff', color: 'var(--color-primary)', padding: '4px 12px', borderRadius: '16px', fontSize: '13px', fontWeight: 500 }}>{item}</span>
            ))}
            </div>
            {peerProfile.bio && <div style={{ fontSize: '14px', color: 'var(--text-primary)', marginTop: '4px', background: '#f8fafc', padding: '10px', borderRadius: '8px', borderLeft: '3px solid var(--color-primary)' }}>"{peerProfile.bio}"</div>}
          </div>
        )}

        <div className="chat-tools" style={{ display: 'flex', gap: '16px', padding: '12px 16px', background: 'white', borderBottom: '1px solid #eee' }}>
          <button onClick={() => setShowReport(true)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}>
            <AlertTriangle size={16} /> 檢舉
          </button>
          <button onClick={() => void handleLeave(peerLeft)} style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}>
            <LogOut size={16} /> 離開
          </button>
        </div>

      {notice && (
        <div role="alert" style={{ padding: '10px 16px', background: '#fff7ed', color: '#9a3412', fontSize: 13 }}>
          {notice} <button onClick={() => setNotice('')} style={{ float: 'right', border: 0, background: 'transparent', cursor: 'pointer' }}>關閉</button>
        </div>
      )}

      <div className="chat-messages" style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {messages.map((m) => (
          <div key={m.id} style={{ alignSelf: m.sender === 'me' ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
            <div style={{
              background: m.sender === 'me' ? 'var(--color-primary)' : 'white',
              color: m.sender === 'me' ? 'white' : 'var(--text-primary)',
              padding: '10px 14px',
              borderRadius: '16px',
              borderBottomRightRadius: m.sender === 'me' ? '4px' : '16px',
              borderBottomLeftRadius: m.sender === 'peer' ? '4px' : '16px',
              boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
            }}>
              {m.text && <div>{m.text}</div>}
              {m.imageUrl && (
                <Image
                  src={m.imageUrl}
                  alt="使用者上傳圖片"
                  width={500}
                  height={500}
                  unoptimized
                  style={{ width: '100%', height: 'auto', borderRadius: '8px', marginTop: m.text ? '8px' : 0 }}
                />
              )}
            </div>
            {m.sender === 'me' && (
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textAlign: 'right', marginTop: '4px' }}>
                {m.status === 'sent' && <><CheckCircle2 size={12} style={{ display: 'inline', verticalAlign: 'middle' }}/> 已發送</>}
                {(m.status === 'delivered' || m.status === 'saved') && <><CheckCheck size={12} style={{ display: 'inline', verticalAlign: 'middle', color: 'var(--color-primary)' }}/> 已送達</>}
                {m.status === 'failed' && (
                  <button onClick={() => void saveToDB(m)} title={m.error} style={{ border: 0, background: 'transparent', color: '#dc2626', cursor: 'pointer', fontSize: 10 }}>
                    儲存失敗，點此重試
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {peerTyping && (
          <div style={{ alignSelf: 'flex-start', color: '#888', fontSize: 12, padding: '4px 12px' }}>對方正在輸入中...</div>
        )}
        {peerLeft && (
          <div style={{ alignSelf: 'center', background: '#f3f4f6', color: '#6b7280', padding: '8px 16px', borderRadius: '16px', fontSize: 13, margin: '8px 0' }}>
            對方已離開聊天室
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-composer" style={{ padding: '16px', background: 'white', borderTop: '1px solid #eee', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" style={{ display: 'none' }} />
        <button onClick={() => fileInputRef.current?.click()} style={{ background: '#f5f5f5', border: 'none', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-secondary)' }} disabled={isUploading}>
          <ImageIcon size={18} />
        </button>
        <button onClick={() => setShowTopicCards(true)} style={{ background: '#fef2f2', border: 'none', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#ef4444' }}>
          <Sparkles size={18} />
        </button>
        <input type="text" value={input} onChange={handleTyping} onKeyDown={(e) => e.key === 'Enter' && handleSend()} placeholder={peerLeft ? "對方已離開" : "輸入訊息..."} style={{ flex: 1, padding: '10px 16px', borderRadius: '24px', border: '1px solid #ddd', outline: 'none', fontSize: '15px' }} disabled={peerLeft} />
        <button onClick={handleSend} style={{ background: peerLeft ? '#ccc' : 'var(--color-primary)', color: 'white', border: 'none', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: peerLeft ? 'not-allowed' : 'pointer' }} disabled={peerLeft}>
          <Send size={18} />
        </button>
      </div>

      {showTopicCards && (
        <TopicCards 
          onClose={() => setShowTopicCards(false)} 
          onSelectTopic={(topic) => handleSendText(`[破冰話題] ${topic}`)} 
        />
      )}

      {showReport && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'white', padding: '24px', borderRadius: '12px', width: '80%', maxWidth: '400px' }}>
            <h3 style={{ marginTop: 0, color: 'var(--text-primary)' }}>檢舉此對話</h3>
            <select value={reportReason} onChange={e => setReportReason(e.target.value)} style={{ width: '100%', padding: '8px', marginBottom: '12px', color: 'black' }}>
              <option value="spam">垃圾訊息或廣告</option>
              <option value="harassment">騷擾或人身攻擊</option>
              <option value="scam">疑似詐騙</option>
              <option value="illegal">違法交易（毒品/洗錢）</option>
            </select>
            <textarea value={reportDetails} onChange={e => setReportDetails(e.target.value)} placeholder="請描述詳細情況..." style={{ width: '100%', padding: '8px', height: '80px', marginBottom: '12px', color: 'black' }} />
            <p style={{ fontSize: 12, color: '#666' }}>送出檢舉時，將會一併夾帶最近 10 則對話紀錄供管理員審核。</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setShowReport(false)} style={{ padding: '8px 16px', background: '#f5f5f5', border: 'none', borderRadius: '4px', cursor: 'pointer', color: 'black' }}>取消</button>
              <button onClick={submitReport} style={{ padding: '8px 16px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>送出檢舉</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
