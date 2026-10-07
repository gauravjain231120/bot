'use client';

import { useState, useEffect, Suspense } from 'react';
import Script from 'next/script';
import { useSearchParams } from 'next/navigation';



function HandoverForm() {
  const searchParams = useSearchParams();
  const type = searchParams.get('type') || 'MYS';
  
  const returnOtc = searchParams.get('ro') || '';

  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  
  const [date, setDate] = useState(() => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return d.toISOString().split('T')[0];
  });
  
  // Return fields only
  const [rApp, setRApp] = useState('');
  const [rReceived, setRReceived] = useState('');
  
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (window.Telegram && window.Telegram.WebApp) {
      window.Telegram.WebApp.expand();
      window.Telegram.WebApp.ready();
    }
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/handover-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          type,
          rApp: rApp ? Number(rApp) : null,
          rReceived: rReceived ? Number(rReceived) : null,
          notes
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');

      setSuccess(true);

      setTimeout(() => {
        if (window.Telegram && window.Telegram.WebApp) {
          window.Telegram.WebApp.close();
        }
      }, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div style={{ padding: 20, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <h2 style={{ color: 'var(--good, #10b981)' }}>✅ Saved!</h2>
        <p>{type} Handover log recorded. You can close this window.</p>
      </div>
    );
  }

  const inputStyle = {
    width: '100%', padding: '12px', boxSizing: 'border-box', 
    border: '1px solid #ccc', borderRadius: '8px', 
    fontSize: '16px', marginBottom: '15px'
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, sans-serif', maxWidth: 400, margin: '0 auto', background: 'var(--bg)', color: 'var(--text)' }}>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      
      <h2 style={{ margin: '0 0 20px 0', fontSize: '1.2rem' }}>📝 {type} Return Log</h2>
      
      {error && <div style={{ padding: 10, background: '#fee2e2', color: '#b91c1c', borderRadius: 8, marginBottom: 15 }}>{error}</div>}
      
      <form onSubmit={handleSubmit}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: 5 }}>Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required style={inputStyle} />

        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #ddd', paddingBottom: 5, marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>📥 Returns</h3>
            {returnOtc && <span style={{ background: '#fef3c7', color: '#b45309', padding: '2px 8px', borderRadius: 4, fontWeight: 700, fontSize: '0.9rem' }}>OTC: {returnOtc}</span>}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 5, fontSize: '0.9rem' }}>Courier Device Shows</label>
              <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" value={rApp} onChange={(e) => setRApp(e.target.value)} placeholder="0" style={inputStyle} required />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 5, fontSize: '0.9rem', color: rApp && rReceived !== rApp ? '#b91c1c' : 'inherit' }}>Actual Received</label>
              <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" value={rReceived} onChange={(e) => setRReceived(e.target.value)} placeholder="0" style={inputStyle} required />
            </div>
          </div>
        </div>

        <label style={{ display: 'block', fontWeight: 600, marginBottom: 5 }}>Notes (Optional)</label>
        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any issues?" style={inputStyle} />

        <button 
          type="submit" 
          disabled={loading}
          style={{
            width: '100%', padding: '14px', background: '#3b82f6', 
            color: 'white', border: 'none', borderRadius: '8px', 
            fontSize: '16px', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1, marginTop: 10
          }}
        >
          {loading ? 'Saving...' : 'Save Log'}
        </button>
      </form>
    </div>
  );
}

export default function HandoverLogPage() {
  return (
    <Suspense fallback={<div style={{ padding: 20 }}>Loading...</div>}>
      <HandoverForm />
    </Suspense>
  );
}
