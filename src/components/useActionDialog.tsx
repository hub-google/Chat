'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useActionDialog() {
  const [request, setRequest] = useState<{ title: string; reason: boolean } | null>(null);
  const [value, setValue] = useState('');
  const resolve = useRef<((value: string | null) => void) | null>(null);
  const ask = useCallback((title: string, reason = false) => {
    resolve.current?.(null);
    setValue('');
    setRequest({ title, reason });
    return new Promise<string | null>(done => { resolve.current = done; });
  }, []);
  useEffect(() => () => { resolve.current?.(null); }, []);
  const finish = (result: string | null) => {
    resolve.current?.(result);
    resolve.current = null;
    setRequest(null);
  };
  const dialog = request && <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#0009', display: 'grid', placeItems: 'center', padding: 20 }}>
    <form role="dialog" aria-modal="true" aria-label={request.title} onKeyDown={event => { if (event.key === 'Escape') finish(null); }} onSubmit={event => { event.preventDefault(); finish(request.reason ? value.trim() : 'confirmed'); }} style={{ width: 'min(420px,100%)', padding: 24, borderRadius: 16, background: 'white', color: '#172033', display: 'grid', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 20 }}>{request.title}</h2>
      {request.reason && <label>操作原因<input autoFocus required value={value} onChange={event => setValue(event.target.value)} style={{ display: 'block', width: '100%', padding: 10, marginTop: 8 }} /></label>}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}><button type="button" onClick={() => finish(null)}>取消</button><button type="submit" autoFocus={!request.reason} disabled={request.reason && !value.trim()}>確認</button></div>
    </form>
  </div>;
  return { ask, dialog };
}
