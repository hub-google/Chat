'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, ChevronDown, ChevronRight, RefreshCw, ShieldOff, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import styles from './ModerationPanel.module.css';

type Hours = 1 | 6 | 24;
type BanDuration = '5m' | '30m' | '1h' | '6h' | '24h' | '7d' | '30d' | '1y' | '10y';
type Phrase = { phrase: string; message_count: number; sender_count: number; ip_count: number };
type Source = {
  ip: string | null; source_quality: 'gateway' | 'estimated'; country: string | null;
  region: string | null; district: string | null; device: string | null; browser: string | null;
  message_count: number; sender_count: number; last_seen: string;
};
type BanRow = { ip: string; expires_at: string; reason: string; created_at: string; is_active: boolean };

const durations: { value: BanDuration; label: string }[] = [
  { value: '5m', label: '5 分鐘' }, { value: '30m', label: '30 分鐘' },
  { value: '1h', label: '1 小時' }, { value: '6h', label: '6 小時' },
  { value: '24h', label: '24 小時' }, { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' }, { value: '1y', label: '1 年' },
  { value: '10y', label: '10 年' },
];

const time = (value: string) => new Date(value).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });

export function ModerationPanel({ refreshToken }: { refreshToken: number }) {
  const [hours, setHours] = useState<Hours>(24);
  const [duration, setDuration] = useState<BanDuration>('24h');
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [bans, setBans] = useState<BanRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [manualIp, setManualIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    const [ranked, active] = await Promise.all([
      supabase.rpc('tunnel_admin_phrase_ranking', { p_hours: hours }),
      supabase.rpc('tunnel_admin_list_ip_bans'),
    ]);
    if (ranked.error || active.error) setError(ranked.error?.message ?? active.error?.message ?? '查詢失敗');
    else { setPhrases((ranked.data ?? []) as Phrase[]); setBans((active.data ?? []) as BanRow[]); }
    setLoading(false);
  }, [hours]);

  // The server request is the effect; state is updated only when it resolves.
  // Range changes clear stale drill-down data directly in their click handler.
  useEffect(() => {
    let active = true;
    void Promise.all([
      supabase.rpc('tunnel_admin_phrase_ranking', { p_hours: hours }),
      supabase.rpc('tunnel_admin_list_ip_bans'),
    ]).then(([ranked, currentBans]) => {
      if (!active) return;
      if (ranked.error || currentBans.error) setError(ranked.error?.message ?? currentBans.error?.message ?? '查詢失敗');
      else {
        setPhrases((ranked.data ?? []) as Phrase[]);
        setBans((currentBans.data ?? []) as BanRow[]);
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [hours, refreshToken]);

  async function showSources(phrase: string) {
    if (selected === phrase) { setSelected(null); setSources([]); return; }
    setSelected(phrase);
    setSources([]);
    setDetailsLoading(true);
    setError('');
    const { data, error: queryError } = await supabase.rpc('tunnel_admin_phrase_sources', { p_hours: hours, p_phrase: phrase });
    if (queryError) setError(queryError.message);
    else setSources((data ?? []) as Source[]);
    setDetailsLoading(false);
  }

  async function banPhrase(phrase: Phrase) {
    if (busy) return;
    if (!window.confirm(`要封鎖最近 ${hours} 小時說過「${phrase.phrase.slice(0, 90)}」的所有已知 IP 嗎？\n預計涉及 ${phrase.ip_count} 個 IP；共用 IP 的其他使用者也會受影響。\n期限：${durations.find(x => x.value === duration)?.label}`)) return;
    setBusy(true); setError(''); setNotice('');
    const { data, error: resultError } = await supabase.rpc('tunnel_admin_ban_phrase', { p_hours: hours, p_phrase: phrase.phrase, p_duration: duration });
    if (resultError) setError(resultError.message);
    else setNotice(`已封鎖 ${data ?? 0} 個 IP，期限 ${durations.find(x => x.value === duration)?.label}；目前生效於 CHAT 資料庫操作，不代表已啟用 Cloudflare 網站入口封鎖。`);
    await refresh();
    setBusy(false);
  }

  async function banIp(ip: string) {
    if (!ip || busy) return;
    if (!window.confirm(`封鎖 IP ${ip} ${durations.find(x => x.value === duration)?.label}？\n同一網路下的其他使用者也可能無法使用聊天室。`)) return;
    setBusy(true); setError(''); setNotice('');
    const { data, error: resultError } = await supabase.rpc('tunnel_admin_ban_ip', { p_ip: ip, p_duration: duration, p_reason: '管理員手動封鎖' });
    if (resultError) setError(resultError.message);
    else { setNotice(`已封鎖 ${ip}，至 ${time(String(data))}（資料庫存取層）。`); setManualIp(''); }
    await refresh(); setBusy(false);
  }

  async function unbanIp(ip: string) {
    if (busy || !window.confirm(`確定解除 ${ip} 的 IP 封鎖？`)) return;
    setBusy(true); setError(''); setNotice('');
    const { error: resultError } = await supabase.rpc('tunnel_admin_unban_ip', { p_ip: ip });
    if (resultError) setError(resultError.message);
    else setNotice(`已解除 ${ip} 的資料庫 IP 封鎖。`);
    await refresh(); setBusy(false);
  }

  return <div className={styles.root}>
    <section className={styles.noticeBox}>
      <AlertTriangle size={19} />
      <div><strong>目前為資料庫層的 IP 封鎖</strong><p>封鎖可防止 IP 使用配對與訊息 API，既有 WebRTC 連線也會檢查封鎖狀態。由於 CHAT 的 GitHub Pages 網址尚未經 Cloudflare 代理，無法阻止對方載入網站靜態首頁。IP 地區為推估、裝置資訊由瀏覽器提供。</p></div>
    </section>
    <section className={styles.panel}>
      <div className={styles.head}><div><h2>最常出現的聊天文字</h2><p>相同文字（忽略首尾空白與連續空格）合併計算，只分析文字訊息，最多列出 100 項。</p></div>
        <button className={styles.subtle} disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={16}/>更新</button>
      </div>
      <div className={styles.controls}>
        <div className={styles.segment}>{([1,6,24] as const).map(h => <button type="button" key={h} onClick={() => { setHours(h); setSelected(null); setSources([]); setLoading(true); }} className={hours===h ? styles.active : ''}>{h} 小時</button>)}</div>
        <label>封鎖期限 <select value={duration} onChange={e => setDuration(e.target.value as BanDuration)}>{durations.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</select></label>
      </div>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.success} role="status">{notice}</div>}
      <div className={styles.tableWrap}><table><thead><tr><th>排名</th><th>重複文字</th><th>訊息數</th><th>發言人數</th><th>已知 IP</th><th>操作</th></tr></thead>
      <tbody>
        {phrases.map((p,i) => <tr key={p.phrase}>
          <td>{i+1}</td>
          <td><button className={styles.phrase} type="button" onClick={() => void showSources(p.phrase)}>{selected===p.phrase ? <ChevronDown size={16}/> : <ChevronRight size={16}/>} <span title={p.phrase}>{p.phrase}</span></button></td>
          <td>{p.message_count}</td><td>{p.sender_count}</td><td>{p.ip_count}</td>
          <td><div className={styles.actions}><button className={styles.subtle} type="button" onClick={() => void showSources(p.phrase)}>查看 IP</button><button className={styles.danger} type="button" disabled={busy || p.ip_count===0} onClick={() => void banPhrase(p)}><Ban size={14}/>全部封鎖</button></div></td>
        </tr>)}
        {!loading && phrases.length===0 && <tr><td colSpan={6} className={styles.empty}>此時間區間沒有文字訊息</td></tr>}
        {loading && <tr><td colSpan={6} className={styles.empty}>讀取中…</td></tr>}
      </tbody></table></div>
    </section>
    {selected !== null && <section className={styles.panel}>
      <div className={styles.head}><div><h2>這句話的發言 IP</h2><p className={styles.selectedText}>「{selected}」</p></div><button className={styles.subtle} type="button" onClick={() => setSelected(null)}>關閉</button></div>
      <div className={styles.tableWrap}><table><thead><tr><th>IP</th><th>國家</th><th>行政區</th><th>城市／區域</th><th>裝置</th><th>瀏覽器</th><th>訊息數</th><th>操作</th></tr></thead><tbody>
        {sources.map((s,i) => <tr key={`${s.ip ?? 'unknown'}-${i}`}>
          <td><span className={styles.mono}>{s.ip ?? '未取得'}</span><small className={styles.quality}>{s.source_quality==='gateway' ? '訊息發送來源' : '最近一次 IP／推估'}</small></td>
          <td>{s.country ?? '未知'}</td><td>{s.region ?? '未知'}</td><td>{s.district ?? '未知'}</td><td>{s.device ?? '未記錄'}</td><td>{s.browser ?? '未記錄'}</td><td>{s.message_count}</td>
          <td><button className={styles.danger} disabled={busy || !s.ip} type="button" onClick={() => void banIp(s.ip!)}><Ban size={14}/>封鎖</button></td>
        </tr>)}
        {!detailsLoading && sources.length===0 && <tr><td colSpan={8} className={styles.empty}>無可識別的 IP 資訊</td></tr>}
        {detailsLoading && <tr><td colSpan={8} className={styles.empty}>讀取 IP 紀錄中…</td></tr>}
      </tbody></table></div>
      <p className={styles.hint}>發送來源 IP 以 Supabase API 閘道轉送資訊為準。較早的訊息僅能用帳號最近一次 IP 推估；VPN、共用網路及地理定位服務都可能造成誤判。</p>
    </section>}
    <section className={styles.panel}>
      <div className={styles.head}><div><h2>手動 IP 封鎖</h2><p>即使尚未出現在熱門文字，也能直接輸入固定 IP。</p></div></div>
      <form className={styles.manual} onSubmit={event => {event.preventDefault();void banIp(manualIp.trim());}}>
        <input aria-label="要封鎖的 IP" placeholder="輸入 IPv4 或 IPv6，例如 203.0.113.1" value={manualIp} onChange={e => setManualIp(e.target.value)} />
        <button className={styles.danger} disabled={busy || !manualIp.trim()} type="submit"><ShieldOff size={16}/>封鎖此 IP</button>
      </form>
    </section>
    <section className={styles.panel}>
      <div className={styles.head}><div><h2>IP 黑名單</h2><p>封鎖到期自動失效，不需要 Worker 或排程；最多顯示最近 300 筆紀錄。</p></div></div>
      <div className={styles.tableWrap}><table><thead><tr><th>IP</th><th>原因</th><th>封鎖至</th><th>狀態</th><th>操作</th></tr></thead><tbody>
        {bans.map(b => <tr key={b.ip}><td className={styles.mono}>{b.ip}</td><td>{b.reason}</td><td>{time(b.expires_at)}</td><td>{b.is_active ? '封鎖中' : '已到期'}</td><td><div className={styles.actions}><button type="button" className={styles.subtle} disabled={busy} onClick={() => void banIp(b.ip)}>更新期限</button><button type="button" className={styles.subtle} disabled={busy} onClick={() => void unbanIp(b.ip)}><Trash2 size={14}/>解除</button></div></td></tr>)}
        {!loading && bans.length===0 && <tr><td colSpan={5} className={styles.empty}>目前沒有 IP 封鎖紀錄</td></tr>}
      </tbody></table></div>
    </section>
  </div>;
}
