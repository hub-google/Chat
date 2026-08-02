'use client';

import React from 'react';
import { MapPin } from 'lucide-react';
import { useMatchStore } from '../store/matchStore';

const STOPS = [
  { label: '1 km', mode: 'nearest', km: 1 },
  { label: '5 km', mode: 'nearest', km: 5 },
  { label: '10 km', mode: 'nearest', km: 10 },
  { label: '20 km', mode: 'nearest', km: 20 },
  { label: '50 km', mode: 'nearest', km: 50 },
  { label: '100 km', mode: 'nearest', km: 100 },
  { label: '不限距離', mode: 'unlimited', km: 100 },
  { label: '越遠越好', mode: 'farthest', km: 100 },
] as const;

export function DistanceSlider() {
  const { distanceMode, distanceKm, setDistanceMode, setDistanceKm } = useMatchStore();

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const stop = STOPS[Number(e.target.value)] ?? STOPS[1];
    setDistanceMode(stop.mode);
    setDistanceKm(stop.km);
  };

  const getLabel = () => {
    if (distanceMode === 'farthest') return '🚀 越遠越好 (避開熟人)';
    if (distanceMode === 'unlimited') return '不限距離';
    return `${distanceKm} km 內`;
  };

  const getValue = () => {
    const index = STOPS.findIndex((stop) => stop.mode === distanceMode && stop.km === distanceKm);
    return index >= 0 ? index : 1;
  };

  return (
    <div className="distance-card" style={{
      margin: '20px 0', 
      padding: '20px', 
      background: distanceMode === 'farthest' ? 'linear-gradient(135deg, rgba(147,51,234,0.15), rgba(79,70,229,0.15))' : 'rgba(255,255,255,0.7)',
      backdropFilter: 'blur(12px)', 
      borderRadius: '12px',
      border: distanceMode === 'farthest' ? '1px solid rgba(147,51,234,0.3)' : '1px solid transparent',
      transition: 'all 0.3s ease'
    }}>
      <div className="location-tip">
        <MapPin size={17} aria-hidden="true" />
        <span><strong>開啟定位，配對更快</strong><small>位置只用來計算大略距離，不會向對方透露您的具體位置。</small></span>
      </div>
      <label style={{ display: 'block', marginBottom: '10px', fontWeight: 'bold', color: distanceMode === 'farthest' ? '#6b21a8' : 'var(--text-primary)' }}>
        配對距離設定：{getLabel()}
      </label>
      <input 
        type="range" 
        min="0"
        max={STOPS.length - 1}
        step="1"
        value={getValue()} 
        onChange={handleSliderChange}
        style={{ width: '100%', cursor: 'pointer' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)' }}>
        <span>近距離</span>
        <span>不限</span>
        <span>越遠越好</span>
      </div>
    </div>
  );
}
