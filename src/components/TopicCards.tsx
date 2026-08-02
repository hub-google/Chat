'use client';

import React, { useEffect, useState } from 'react';
import { Sparkles, X, ChevronLeft } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface TopicCategory {
  id: string;
  name: string;
  icon?: string;
  description?: string;
}

interface TopicCard {
  id: string;
  category_id: string;
  content: string;
}

interface TopicCardsProps {
  onSelectTopic: (topic: string) => void;
  onClose: () => void;
}

export function TopicCards({ onSelectTopic, onClose }: TopicCardsProps) {
  const [categories, setCategories] = useState<TopicCategory[]>([]);
  const [cards, setCards] = useState<TopicCard[]>([]);
  
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [drawnTopic, setDrawnTopic] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    const fetchData = async () => {
      const [catRes, cardRes] = await Promise.all([
        supabase.from('topic_categories').select('*').eq('is_active', true).order('display_order', { ascending: true }),
        supabase.from('topic_cards').select('*').eq('is_active', true)
      ]);
      
      if (!active) return;

      if (!catRes.error && !cardRes.error && catRes.data && catRes.data.length > 0) {
        setCategories(catRes.data);
        setCards(cardRes.data || []);
      } else {
        setLoadError(catRes.error?.message || cardRes.error?.message || '話題資料庫目前沒有可用內容');
      }
    };
    void fetchData();
    return () => { active = false; };
  }, []);

  const drawCard = (categoryId: string) => {
    const categoryCards = cards.filter(c => c.category_id === categoryId);
    if (categoryCards.length === 0) {
      setDrawnTopic('這個分類還沒有話題卡喔！');
      return;
    }
    const randomCard = categoryCards[Math.floor(Math.random() * categoryCards.length)];
    setDrawnTopic(randomCard.content);
  };

  const handleSelectCategory = (categoryId: string) => {
    setSelectedCategoryId(categoryId);
    drawCard(categoryId);
  };

  const shareTopic = () => {
    if (drawnTopic && drawnTopic !== '這個分類還沒有話題卡喔！') {
      onSelectTopic(drawnTopic);
      onClose();
    }
  };

  const handleBack = () => {
    setSelectedCategoryId(null);
    setDrawnTopic(null);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 400, overflow: 'hidden', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {selectedCategoryId && (
              <button onClick={handleBack} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#666', display: 'flex', alignItems: 'center' }}>
                <ChevronLeft size={20} />
              </button>
            )}
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Sparkles size={20} color="var(--color-primary)" /> 破冰話題卡</h3>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#888' }}><X size={20} /></button>
        </div>
        
        {!selectedCategoryId ? (
          <div style={{ padding: 20 }}>
            <p style={{ margin: '0 0 16px 0', color: '#666', fontSize: 14 }}>請選擇一個話題分類來抽取卡片：</p>
            {loadError && <div role="alert" style={{ padding: 14, borderRadius: 10, background: '#fff1f2', color: '#be123c', fontSize: 13 }}>{loadError}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {categories.map(cat => (
                <button 
                  key={cat.id} 
                  onClick={() => handleSelectCategory(cat.id)}
                  style={{ padding: 16, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 12, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4, transition: 'all 0.2s' }}
                >
                  <span style={{ fontWeight: 'bold', color: 'var(--text-primary)', fontSize: 16 }}>{cat.icon} {cat.name}</span>
                  {cat.description && <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{cat.description}</span>}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding: 30, textAlign: 'center' }}>
              <div style={{ background: 'var(--gradient-primary)', color: 'white', padding: 24, borderRadius: 12, fontSize: 18, fontWeight: 'bold', minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {drawnTopic}
              </div>
            </div>
            <div style={{ padding: '20px', background: '#fafafa', borderTop: '1px solid #eee', display: 'flex', gap: 12 }}>
              <button onClick={() => drawCard(selectedCategoryId)} style={{ flex: 1, padding: 12, background: 'transparent', border: '1px solid #ddd', borderRadius: 8, cursor: 'pointer', fontWeight: 'bold', color: '#666' }}>重抽一張</button>
              <button onClick={shareTopic} disabled={drawnTopic === '這個分類還沒有話題卡喔！'} style={{ flex: 1, padding: 12, background: drawnTopic === '這個分類還沒有話題卡喔！' ? '#ccc' : 'var(--color-primary)', border: 'none', borderRadius: 8, cursor: drawnTopic === '這個分類還沒有話題卡喔！' ? 'not-allowed' : 'pointer', fontWeight: 'bold', color: 'white' }}>傳送話題</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
