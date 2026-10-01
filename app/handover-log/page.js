'use client';

import { useState, useEffect } from 'react';
import Script from 'next/script';

export default function HandoverLogPage() {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  
  const [date, setDate] = useState(() => {
    // Current IST date
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return d.toISOString().split('T')[0];
  });
  const [mysDevice, setMysDevice] = useState('');
  const [mysReceived, setMysReceived] = useState('');
  const [myeDevice, setMyeDevice] = useState('');
  const [myeReceived, setMyeReceived] = useState('');
  const [notes, setNotes] = useState('');

  // Expand the Telegram Web App to full height if available
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
          mysDevice: Number(mysDevice) || 0,
          mysReceived: Number(mysReceived) || 0,
          myeDevice: Number(myeDevice) || 0,
          myeReceived: Number(myeReceived) || 0,
          notes
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');

      setSuccess(true);

      // Close the web app after a brief success message
      setTimeout(() => {
        if (window.Telegram && window.Telegram.WebApp) {
          // Tell the bot to send the success message via answerWebAppQuery if we want,
          // but we already send a message from the API. Just close it.
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
        <p>Handover log recorded. You can close this window.</p>
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
      
      <h2 style={{ margin: '0 0 20px 0', fontSize: '1.2rem' }}>📝 Courier Return Handover</h2>
      
      {error && <div style={{ padding: 10, background: '#fee2e2', color: '#b91c1c', borderRadius: 8, marginBottom: 15 }}>{error}</div>}
      
      <form onSubmit={handleSubmit}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: 5 }}>Date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required style={inputStyle} />

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 5 }}>MYS Device</label>
            <input type="number" min="0" value={mysDevice} onChange={(e) => setMysDevice(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 5, color: mysDevice && mysReceived !== mysDevice ? '#b91c1c' : 'inherit' }}>MYS Received</label>
            <input type="number" min="0" value={mysReceived} onChange={(e) => setMysReceived(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 5 }}>MYE Device</label>
            <input type="number" min="0" value={myeDevice} onChange={(e) => setMyeDevice(e.target.value)} placeholder="0" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 5, color: myeDevice && myeReceived !== myeDevice ? '#b91c1c' : 'inherit' }}>MYE Received</label>
            <input type="number" min="0" value={myeReceived} onChange={(e) => setMyeReceived(e.target.value)} placeholder="0" style={inputStyle} />
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
            opacity: loading ? 0.7 : 1
          }}
        >
          {loading ? 'Saving...' : 'Save Log'}
        </button>
      </form>
    </div>
  );
}
