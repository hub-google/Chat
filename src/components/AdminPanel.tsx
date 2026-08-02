'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, BarChart3, ChevronRight, Eye, Flag,
  MessageCircle, RefreshCw, Send, ShieldCheck, StopCircle, UserRound, X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ensureUser } from '../lib/user';
import styles from './AdminPanel.module.css';

type AdminView = 'sessions' | 'reports' | 'analytics';
type AnalyticsRange = 'today' | '7d' | '30d' | 'all';

interface ActiveSession {
  id: string;
  participants: string[];
  created_at: string;
  is_active: boolean;
  takeover_target?: string | null;
}

interface Profile {
  id: string;
  nickname: string | null;
  gender: string | null;
  age: number | null;
  city: string | null;
  bio: string | null;
  opening_message: string | null;
  status: string | null;
}

interface Report {
  id: string;
  reporter_id: string;
  target_id: string;
  match_id: string | null;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
  context_snapshot?: Array<{ sender?: string; text?: string; imageUrl?: string }>;
}

interface MessageRow {
  id: string;
  sender_id: string;
  content: string;
  type: string;
  created_at?: string;
}

const viewMeta = {
  sessions: { eyebrow: '即時營運', title: '連線監控', description: '查看目前與近期配對、雙方公開資料及對話狀態。' },
  reports: { eyebrow: '安全中心', title: '檢舉審核', description: '處理使用者檢舉、查看對話快照，並決定封鎖或略過。' },
  analytics: { eyebrow: '營運洞察', title: '數據分析', description: '獨立檢視平台配對量、線上人數與檢舉趨勢。' },
} satisfies Record<AdminView, { eyebrow: string; title: string; description: string }>;

const genderLabel = (gender: string | null) => gender === 'male' ? '男性' : gender === 'female' ? '女性' : '未填寫';
const shortId = (id?: string | null) => id ? id.slice(0, 8) : '—';
const dateTime = (value?: string | null) => value ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

export function AdminPanel({ view = 'sessions' }: { view?: AdminView }) {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [reports, setReports] = useState<Report[]>([]);
  const [stats, setStats] = useState({ totalMatches: 0, activeUsers: 0, totalReports: 0 });
  const [authState, setAuthState] = useState<'checking' | 'allowed' | 'denied'>('checking');
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [monitorMatchId, setMonitorMatchId] = useState<string | null>(null);
  const [monitorMessages, setMonitorMessages] = useState<MessageRow[]>([]);
  const [takeover, setTakeover] = useState<{ matchId: string; targetUserId: string } | null>(null);
  const [takeoverMsg, setTakeoverMsg] = useState('');
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>('30d');

  const selectedSession = useMemo(() => sessions.find((item) => item.id === selectedMatchId) ?? null, [sessions, selectedMatchId]);

  async function fetchSessions() {
    setLoading(true);
    setErrorMsg('');
    const { data, error } = await supabase.from('matches').select('*').order('created_at', { ascending: false }).limit(20);
    if (error) {
      setErrorMsg(`無法載入配對紀錄：${error.message}`);
      setLoading(false);
      return;
    }
    const nextSessions = (data ?? []) as ActiveSession[];
    setSessions(nextSessions);
    const ids = [...new Set(nextSessions.flatMap((item) => [...(item.participants ?? []), ...(item.takeover_target ? [item.takeover_target] : [])]))];
    if (ids.length) {
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('id, nickname, gender, age, city, bio, opening_message, status')
        .in('id', ids);
      if (profileError) setErrorMsg(`配對已載入，但個人資料讀取失敗：${profileError.message}`);
      if (profileData) setProfiles(Object.fromEntries((profileData as Profile[]).map((profile) => [profile.id, profile])));
    }
    setLoading(false);
  }

  async function fetchReports() {
    setLoading(true);
    setErrorMsg('');
    const { data, error } = await supabase.from('chat_reports').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) setErrorMsg(`無法載入檢舉：${error.message}`);
    else setReports((data ?? []) as Report[]);
    setLoading(false);
  }

  async function fetchAnalytics() {
    setLoading(true);
    setErrorMsg('');
    const since = analyticsRange === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString() : analyticsRange === '7d' ? new Date(Date.now() - 7 * 86400000).toISOString() : analyticsRange === '30d' ? new Date(Date.now() - 30 * 86400000).toISOString() : null;
    let matchesQuery = supabase.from('matches').select('*', { count: 'exact', head: true });
    if (since) matchesQuery = matchesQuery.gte('created_at', since);
    const [matchesResult, reportsResult] = await Promise.all([
      matchesQuery,
      supabase.from('chat_reports').select('*', { count: 'exact', head: true }),
    ]);
    const firstError = matchesResult.error || reportsResult.error;
    if (firstError) setErrorMsg(`無法載入分析資料：${firstError.message}`);
    setStats((previous) => ({ totalMatches: matchesResult.count ?? 0, activeUsers: previous.activeUsers, totalReports: reportsResult.count ?? 0 }));
    setLoading(false);
  }

  const refresh = () => view === 'sessions' ? fetchSessions() : view === 'reports' ? fetchReports() : fetchAnalytics();

  useEffect(() => {
    void (async () => {
      try {
        const user = await ensureUser();
        const { data, error } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        if (error || data?.role !== 'admin') {
          setAuthState('denied');
          return;
        }
        setAuthState('allowed');
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : '管理員驗證失敗。');
        setAuthState('denied');
      }
    })();
  }, []);

  useEffect(() => { if (authState === 'allowed') void refresh(); }, [authState, view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (authState !== 'allowed') return;
    const currentCount = Number(document.documentElement.dataset.onlineCount ?? 0);
    setStats((previous) => ({ ...previous, activeUsers: currentCount }));
    const updateCount = (event: Event) => setStats((previous) => ({ ...previous, activeUsers: (event as CustomEvent<number>).detail }));
    window.addEventListener('site-online-count', updateCount);
    return () => window.removeEventListener('site-online-count', updateCount);
  }, [authState]);

  useEffect(() => { if (authState === 'allowed' && view === 'analytics') void fetchAnalytics(); }, [analyticsRange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!monitorMatchId) return;
    void supabase.from('messages').select('*').eq('match_id', monitorMatchId).order('created_at', { ascending: true }).limit(50)
      .then(({ data }) => setMonitorMessages((data ?? []) as MessageRow[]));
    const channel = supabase.channel(`admin_monitor_${monitorMatchId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `match_id=eq.${monitorMatchId}` }, (payload) => {
        setMonitorMessages((previous) => [...previous, payload.new as MessageRow]);
      }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [monitorMatchId]);

  async function terminateSession(matchId: string) {
    const reason = window.prompt('請輸入終止原因：');
    if (!reason) return;
    const { error } = await supabase.rpc('terminate_match_by_admin', { p_match_id: matchId, p_reason: reason });
    if (error) setErrorMsg(error.message); else await fetchSessions();
  }

  async function handleTakeover(matchId: string, targetUserId: string) {
    const reason = window.prompt('請輸入接管原因：');
    if (!reason) return;
    const { error } = await supabase.rpc('admin_takeover_session', { p_match_id: matchId, p_target_user_id: targetUserId, p_reason: reason });
    if (error) setErrorMsg(error.message); else {
      const takeoverChannel = supabase.channel(`takeover_notice_${matchId}`);
      await new Promise<void>((resolve) => takeoverChannel.subscribe((status) => { if (status === 'SUBSCRIBED') resolve(); }));
      await takeoverChannel.send({ type: 'broadcast', event: 'admin_takeover', payload: { targetUserId } });
      void supabase.removeChannel(takeoverChannel);
      setTakeover({ matchId, targetUserId });
      setSelectedMatchId(null);
      setMonitorMessages([]);
      setMonitorMatchId(matchId);
      await fetchSessions();
    }
  }

  async function sendTakeoverMessage() {
    if (!takeover || !takeoverMsg.trim()) return;
    const { error } = await supabase.from('messages').insert({ id: crypto.randomUUID(), match_id: takeover.matchId, sender_id: takeover.targetUserId, content: takeoverMsg.trim(), type: 'text' });
    if (error) setErrorMsg(error.message); else setTakeoverMsg('');
  }

  async function banUser(userId: string) {
    if (!window.confirm('確定要封鎖此使用者嗎？')) return;
    const { error } = await supabase.from('profiles').update({ status: 'banned' }).eq('id', userId);
    if (error) setErrorMsg(error.message); else await fetchReports();
  }

  async function dismissReport(reportId: string) {
    const { error } = await supabase.from('chat_reports').update({ status: 'dismissed' }).eq('id', reportId);
    if (error) setErrorMsg(error.message); else await fetchReports();
  }

  if (authState !== 'allowed') {
    return <div className={styles.auth}><ShieldCheck size={52} /><h1>{authState === 'checking' ? '正在驗證管理員身分' : '無法進入管理後台'}</h1><p>{errorMsg || '密碼錯誤或已取消輸入。'}</p></div>;
  }

  const meta = viewMeta[view];
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}><span className={styles.logo}><ShieldCheck size={21} /></span><div><strong>Chat 管理中心</strong><small>營運控制台</small></div></div>
        <nav className={styles.nav} aria-label="管理中心導覽">
          <Link className={view === 'sessions' ? styles.activeNav : ''} href="/admin"><Activity size={19} />連線監控</Link>
          <Link className={view === 'reports' ? styles.activeNav : ''} href="/admin/reports"><Flag size={19} />檢舉審核</Link>
          <Link className={view === 'analytics' ? styles.activeNav : ''} href="/admin/analytics"><BarChart3 size={19} />數據分析</Link>
        </nav>
        <div className={styles.sidebarNote}><ShieldCheck size={16} /><span>管理操作皆受權限控管</span></div>
      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <div><span className={styles.eyebrow}>{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.description}</p></div>
          <button className={styles.refreshButton} onClick={() => void refresh()} disabled={loading}><RefreshCw size={17} className={loading ? styles.spinning : ''} />重新整理</button>
        </header>

        {errorMsg && <div className={styles.error} role="alert"><AlertTriangle size={18} />{errorMsg}</div>}

        {view === 'sessions' && <SessionsView sessions={sessions} profiles={profiles} loading={loading} selectedMatchId={selectedMatchId} onSelect={setSelectedMatchId} onMonitor={(id) => { setMonitorMessages([]); setMonitorMatchId(id); }} onTerminate={terminateSession} />}
        {view === 'reports' && <ReportsView reports={reports} loading={loading} onBan={banUser} onDismiss={dismissReport} />}
        {view === 'analytics' && <><div className="analytics-range"><span>統計區間</span>{([['today','今日'],['7d','近 7 天'],['30d','近 30 天'],['all','全部']] as const).map(([value, label]) => <button className={analyticsRange === value ? 'active' : ''} key={value} onClick={() => setAnalyticsRange(value)}>{label}</button>)}</div><AnalyticsView stats={stats} loading={loading} /></>}
      </main>

      {selectedSession && <ProfileDrawer session={selectedSession} profiles={profiles} onClose={() => setSelectedMatchId(null)} onTakeover={handleTakeover} />}
      {monitorMatchId && <MonitorDrawer matchId={monitorMatchId} messages={monitorMessages} takeover={takeover?.matchId === monitorMatchId ? takeover : null} value={takeoverMsg} onValueChange={setTakeoverMsg} onSend={sendTakeoverMessage} onEndTakeover={() => setTakeover(null)} onClose={() => { setMonitorMatchId(null); setMonitorMessages([]); }} />}
    </div>
  );
}

function SessionsView({ sessions, profiles, loading, selectedMatchId, onSelect, onMonitor, onTerminate }: { sessions: ActiveSession[]; profiles: Record<string, Profile>; loading: boolean; selectedMatchId: string | null; onSelect: (id: string) => void; onMonitor: (id: string) => void; onTerminate: (id: string) => void }) {
  const activeCount = sessions.filter((item) => item.is_active).length;
  return <>
    <section className={styles.summaryRow}><div className={styles.summaryCard}><span>目前連線</span><strong>{loading ? '—' : activeCount}</strong><small><i className={styles.liveDot} /> 即時更新</small></div><div className={styles.summaryCard}><span>近期配對</span><strong>{loading ? '—' : sessions.length}</strong><small>顯示最近 20 筆</small></div></section>
    <section className={styles.panel}><div className={styles.panelHeading}><div><h2>配對場次</h2><p>點選場次即可比較雙方配對時填寫的個人資料</p></div></div>
      {loading ? <div className={styles.empty}>正在載入配對資料…</div> : sessions.length === 0 ? <div className={styles.empty}><MessageCircle size={30} /><strong>目前沒有配對紀錄</strong><span>新配對建立後會顯示在這裡。</span></div> :
        <div className={styles.sessionList}>{sessions.map((session) => <article className={`${styles.sessionRow} ${selectedMatchId === session.id ? styles.selectedRow : ''}`} key={session.id} onClick={() => onSelect(session.id)}>
          <div className={styles.statusCell}><i className={session.is_active ? styles.onlineDot : styles.offlineDot} /><div><strong>{session.is_active ? '連線中' : '已結束'}</strong><span>{dateTime(session.created_at)}</span></div></div>
          <div className={styles.peopleCell}>{session.participants.slice(0, 2).map((id, index) => <div className={styles.personMini} key={id}><span>{profiles[id]?.nickname?.slice(0, 1) || `用${index + 1}`}</span><div><strong>{profiles[id]?.nickname || `匿名使用者 ${shortId(id)}`}</strong><small>{[genderLabel(profiles[id]?.gender ?? null), profiles[id]?.age ? `${profiles[id].age} 歲` : null, profiles[id]?.city].filter(Boolean).join(' · ')}</small></div></div>)}</div>
          <code>{shortId(session.id)}</code>
          <div className={styles.rowActions}><button title="即時查看對話" onClick={(event) => { event.stopPropagation(); onMonitor(session.id); }}><Eye size={18} /></button>{session.is_active && <button className={styles.dangerIcon} title="終止連線" onClick={(event) => { event.stopPropagation(); void onTerminate(session.id); }}><StopCircle size={18} /></button>}<ChevronRight size={18} /></div>
        </article>)}</div>}
    </section>
  </>;
}

function ProfileDrawer({ session, profiles, onClose, onTakeover }: { session: ActiveSession; profiles: Record<string, Profile>; onClose: () => void; onTakeover: (matchId: string, userId: string) => void }) {
  return <div className={styles.drawerBackdrop} onMouseDown={onClose}><aside className={styles.drawer} onMouseDown={(event) => event.stopPropagation()} aria-label="配對雙方資料">
    <div className={styles.drawerHeader}><div><span>場次 {shortId(session.id)}</span><h2>配對雙方資料</h2></div><button onClick={onClose} aria-label="關閉"><X size={20} /></button></div>
    <p className={styles.drawerIntro}>以下是兩位使用者配對時設定的公開資料，可用來協助監控與判斷檢舉。</p>
    <div className={styles.profileCompare}>{session.participants.slice(0, 2).map((id, index) => { const profile = profiles[id]; return <section className={styles.profileCard} key={id}><div className={styles.avatar}><UserRound size={25} /></div><span className={styles.userLabel}>使用者 {index + 1}</span><h3>{profile?.nickname || '匿名使用者'}</h3><code>{id}</code><dl><div><dt>性別</dt><dd>{genderLabel(profile?.gender ?? null)}</dd></div><div><dt>年齡</dt><dd>{profile?.age ? `${profile.age} 歲` : '未填寫'}</dd></div><div><dt>城市</dt><dd>{profile?.city || '未填寫'}</dd></div><div><dt>目前狀態</dt><dd>{profile?.status || '未知'}</dd></div></dl><div className={styles.profileText}><span>自我介紹</span><p>{profile?.bio || '未填寫自我介紹'}</p></div><div className={styles.profileText}><span>開場喊話</span><p>{profile?.opening_message || '未設定開場喊話'}</p></div><button className={styles.outlineButton} onClick={() => void onTakeover(session.id, id)}>接管此使用者</button></section>; })}</div>
  </aside></div>;
}

function ReportsView({ reports, loading, onBan, onDismiss }: { reports: Report[]; loading: boolean; onBan: (id: string) => void; onDismiss: (id: string) => void }) {
  return <section className={styles.panel}><div className={styles.panelHeading}><div><h2>待處理與歷史檢舉</h2><p>「檢舉審核」用來查看被檢舉原因與對話快照，並採取封鎖或略過處置。</p></div><span className={styles.countBadge}>{reports.filter((item) => item.status !== 'dismissed').length} 筆待確認</span></div>
    {loading ? <div className={styles.empty}>正在載入檢舉資料…</div> : reports.length === 0 ? <div className={styles.empty}><ShieldCheck size={32} /><strong>目前沒有檢舉</strong><span>使用者送出檢舉後，案件會出現在此頁。</span></div> : <div className={styles.reportGrid}>{reports.map((report) => <article className={styles.reportCard} key={report.id}><div className={styles.reportTop}><span className={styles.reportReason}><Flag size={15} />{report.reason || '未分類'}</span><time>{dateTime(report.created_at)}</time></div><h3>被檢舉者 {shortId(report.target_id)}</h3><p>{report.details || '檢舉者未提供補充說明。'}</p>{report.context_snapshot?.length ? <div className={styles.snapshot}><strong>對話快照</strong>{report.context_snapshot.map((message, index) => <span key={index}>[{message.sender || '使用者'}] {message.text || (message.imageUrl ? '[圖片]' : '[無內容]')}</span>)}</div> : <div className={styles.noSnapshot}>此檢舉沒有附帶對話快照</div>}<div className={styles.reportFooter}><small>案件 {shortId(report.id)} · 狀態：{report.status || '待處理'}</small><div><button className={styles.dismissButton} onClick={() => void onDismiss(report.id)}>略過案件</button><button className={styles.banButton} onClick={() => void onBan(report.target_id)}>封鎖使用者</button></div></div></article>)}</div>}
  </section>;
}

function AnalyticsView({ stats, loading }: { stats: { totalMatches: number; activeUsers: number; totalReports: number }; loading: boolean }) {
  const cards = [{ label: '累積配對', value: stats.totalMatches, icon: MessageCircle, tone: 'blue' }, { label: '目前線上', value: stats.activeUsers, icon: Activity, tone: 'green' }, { label: '累積檢舉', value: stats.totalReports, icon: Flag, tone: 'orange' }];
  return <><section className={styles.analyticsGrid}>{cards.map((card) => <article className={styles.metricCard} key={card.label}><span className={`${styles.metricIcon} ${styles[card.tone]}`}><card.icon size={21} /></span><div><span>{card.label}</span><strong>{loading ? '—' : card.value.toLocaleString('zh-TW')}</strong></div></article>)}</section><section className={styles.panel}><div className={styles.panelHeading}><div><h2>平台概況</h2><p>此頁只顯示分析資料，不會混入連線場次清單。</p></div></div><div className={styles.insight}><BarChart3 size={40} /><div><strong>即時營運摘要</strong><p>目前平均每個有效配對包含 2 位使用者；檢舉率為 {stats.totalMatches ? ((stats.totalReports / stats.totalMatches) * 100).toFixed(1) : '0.0'}%。</p></div></div></section></>;
}

function MonitorDrawer({ matchId, messages, takeover, value, onValueChange, onSend, onEndTakeover, onClose }: { matchId: string; messages: MessageRow[]; takeover: { matchId: string; targetUserId: string } | null; value: string; onValueChange: (value: string) => void; onSend: () => Promise<void>; onEndTakeover: () => void; onClose: () => void }) {
  const visibleMessages = messages.filter((message) => message.type !== 'system');
  const otherUserId = visibleMessages.find((message) => message.sender_id !== takeover?.targetUserId)?.sender_id;
  return <div className={styles.drawerBackdrop} onMouseDown={onClose}><aside className={`${styles.drawer} ${styles.monitorDrawer} ${takeover ? 'admin-takeover-drawer' : ''}`} onMouseDown={(event) => event.stopPropagation()}><header className="support-header"><div className="support-avatar"><UserRound size={21} /></div><div className="support-contact"><span>{takeover ? '接管對話進行中' : '即時對話監看'}</span><h2>{otherUserId ? `匿名使用者 ${shortId(otherUserId)}` : `場次 ${shortId(matchId)}`}</h2><small><i /> 即時連線 · 場次 {shortId(matchId)}</small></div>{takeover && <div className="support-identity"><span>目前回覆身分</span><strong>{shortId(takeover.targetUserId)}</strong></div>}<button className="support-close" onClick={onClose} aria-label="關閉"><X size={20} /></button></header><div className={`${styles.messages} support-messages`}>{visibleMessages.length === 0 ? <div className={styles.empty}>目前尚無訊息</div> : visibleMessages.map((message) => { const impersonated = takeover?.targetUserId === message.sender_id; return <div className={`${styles.message} ${impersonated ? 'admin-impersonated-message' : ''}`} key={message.id}><strong>{impersonated ? '我方（接管身分）' : `對方 ${shortId(message.sender_id)}`}</strong>{message.type === 'image' ? <img className="admin-message-image" src={message.content} alt="對話圖片" /> : <p>{message.content}</p>}<time>{message.created_at ? new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.created_at)) : ''}</time></div>; })}</div>{takeover && <div className="admin-takeover-composer"><div className="support-compose-label"><span>以 {shortId(takeover.targetUserId)} 身分回覆</span><small>Enter 送出 · Shift + Enter 換行</small></div><textarea value={value} onChange={(event) => onValueChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void onSend(); } }} placeholder="輸入回覆內容…" autoFocus /><button className="admin-send-takeover" onClick={() => void onSend()} aria-label="送出訊息"><Send size={18} /><span>送出</span></button><button className="admin-end-takeover" onClick={onEndTakeover}>結束接管</button></div>}</aside></div>;
}
