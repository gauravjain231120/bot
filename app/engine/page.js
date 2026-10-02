'use client';

import { useEffect, useState } from 'react';
import { useDashboard } from '../../lib/DashboardContext';

// Hardcoded start date of when the logging feature was built
const TRACKING_START = new Date('2026-10-02T00:00:00');

export default function EngineStatusPage() {
  const { status, isOwner } = useDashboard();
  const [hostname, setHostname] = useState('Loading...');
  const [history, setHistory] = useState([]);
  const [selectedDay, setSelectedDay] = useState({ platform: null, dateStr: null });

  useEffect(() => {
    setHostname(window.location.hostname);
    fetch('/api/engine-history').then(res => res.json()).then(data => {
      if (data.logs) setHistory(data.logs);
    }).catch(console.error);
  }, []);

  if (!status) {
    return (
      <main className="dashboard-content">
        <div className="card loading-state">Loading Engine Status...</div>
      </main>
    );
  }

  const {
    myntraScrapeMode,
    amazonScrapeMode,
    myntraLastProxyCheck,
    amazonLastProxyCheck,
    myntraProxyInterval,
    amazonProxyInterval,
    running
  } = status;

  function renderStatus(platform, mode, lastCheck, intervalMinutes) {
    const isLocal = mode === 'local';
    const hasCheck = !!lastCheck;
    const timeAgo = hasCheck ? Math.floor((new Date() - new Date(lastCheck)) / 1000 / 60) : null;
    const isHealthy = hasCheck && timeAgo < (intervalMinutes || 5) * 3;

    const platLogs = history.filter(l => l.marketplace === platform.toLowerCase());
    const lastDown = platLogs.find(l => l.type === 'downtime');
    const lastCloud = platLogs.find(l => l.message.includes('Switched to Cloud'));

    const days = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      days.push(d);
    }

    const isSelected = selectedDay.platform === platform && selectedDay.dateStr;

    return (
      <div className="card" style={{ marginBottom: '20px' }}>
        <h3>{platform} Engine</h3>
        <p><strong>Mode:</strong> {isLocal ? '💻 Local (Extension)' : '☁️ Cloud (Cron/API)'}</p>
        <p>
          <strong>Status:</strong>{' '}
          {isLocal ? (
            isHealthy ? <span style={{ color: 'var(--success-color)' }}>✅ Active & Feeding</span> : <span style={{ color: 'var(--danger-color)' }}>❌ Extension Offline (Stale)</span>
          ) : (
            running ? <span style={{ color: 'var(--success-color)' }}>✅ Cloud Polling Active</span> : <span style={{ color: 'var(--danger-color)' }}>⏸️ Cloud Engine Paused</span>
          )}
        </p>
        <p><strong>Last Data Received:</strong> {hasCheck ? new Date(lastCheck).toLocaleString() : 'Never'} {timeAgo !== null ? `(${timeAgo} mins ago)` : ''}</p>
        {isLocal && <p><strong>Expected Interval:</strong> Every {intervalMinutes} minutes</p>}
        
        <div style={{ marginTop: 25 }}>
          <h4 style={{ marginBottom: 10, fontSize: '0.9rem', opacity: 0.9 }}>30-Day Uptime History <span style={{ fontWeight: 'normal', opacity: 0.7 }}>(Click a day for insight)</span></h4>
          <div style={{ display: 'flex', gap: '4px', height: '35px' }}>
            {days.map((date, i) => {
              const dateStr = date.toDateString();
              const dayLogs = platLogs.filter(l => new Date(l.createdAt).toDateString() === dateStr);
              const beforeTracking = date < TRACKING_START && date.toDateString() !== TRACKING_START.toDateString();
              
              let color = '#28a745'; // Green
              let title = `${dateStr}: No issues (100% Uptime)`;
              
              if (beforeTracking) {
                color = 'var(--border-color, #444)';
                title = `${dateStr}: No data (Logger installed Oct 2, 2026)`;
              } else if (dayLogs.some(l => l.type === 'downtime')) {
                color = '#dc3545'; // Red
                title = `${dateStr}: Downtime recorded`;
              } else if (dayLogs.some(l => l.message.includes('Cloud'))) {
                color = '#f5a623'; // Yellow
                title = `${dateStr}: Switched to Cloud backup`;
              }
  
              return (
                <div 
                  key={i} 
                  title={title}
                  onClick={() => setSelectedDay({ platform, dateStr })}
                  style={{ 
                    flex: 1, 
                    backgroundColor: color, 
                    borderRadius: '3px',
                    cursor: beforeTracking ? 'not-allowed' : 'pointer',
                    boxShadow: selectedDay.platform === platform && selectedDay.dateStr === dateStr ? '0 0 0 2px #fff' : 'none',
                    border: '1px solid rgba(0,0,0,0.2)'
                  }} 
                />
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '0.75rem', opacity: 0.6 }}>
            <span>30 days ago</span>
            <span>Today</span>
          </div>
        </div>

        {isSelected && (
          <div style={{ marginTop: 15, padding: 15, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)' }}>
             <h4 style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
               <span>Insight: {selectedDay.dateStr}</span>
               <button onClick={() => setSelectedDay({ platform: null, dateStr: null })} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}>✕</button>
             </h4>
             {(() => {
               const dayObj = new Date(selectedDay.dateStr);
               if (dayObj < TRACKING_START && dayObj.toDateString() !== TRACKING_START.toDateString()) {
                 return <p className="muted">No data available before the logger was installed on Oct 2, 2026.</p>;
               }

               const startOfDay = new Date(dayObj); startOfDay.setHours(0,0,0,0);
               const endOfDay = new Date(dayObj); endOfDay.setHours(23,59,59,999);
               const dayLogsAsc = platLogs.filter(l => new Date(l.createdAt).toDateString() === selectedDay.dateStr).slice().reverse();
               
               // Find initial state by checking the most recent log BEFORE startOfDay
               const previousLogs = platLogs.filter(l => new Date(l.createdAt) < startOfDay);
               let currentState = previousLogs[0]?.message.includes('Cloud') ? 'cloud' : 'local';
               
               let cloudMs = 0, localMs = 0;
               let lastEventTime = startOfDay.getTime();
               
               dayLogsAsc.forEach(log => {
                 const eventTime = new Date(log.createdAt).getTime();
                 const duration = eventTime - lastEventTime;
                 if (currentState === 'cloud') cloudMs += duration; else localMs += duration;
                 
                 if (log.message.includes('Cloud')) currentState = 'cloud';
                 else if (log.message.includes('Local')) currentState = 'local';
                 lastEventTime = eventTime;
               });
               
               const endTime = Math.min(endOfDay.getTime(), Date.now());
               const finalDuration = endTime - lastEventTime;
               if (finalDuration > 0) {
                 if (currentState === 'cloud') cloudMs += finalDuration; else localMs += finalDuration;
               }
               
               const formatMs = (ms) => {
                 if (ms <= 0) return '0h 0m';
                 const h = Math.floor(ms / 3600000);
                 const m = Math.floor((ms % 3600000) / 60000);
                 return `${h}h ${m}m`;
               };

               return (
                 <>
                   <div style={{ display: 'flex', gap: '20px', marginBottom: '15px' }}>
                     <div>
                       <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', opacity: 0.7 }}>Time on Local (Laptop)</div>
                       <div style={{ fontSize: '1.2rem', color: 'var(--success-color)' }}>{formatMs(localMs)}</div>
                     </div>
                     <div>
                       <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', opacity: 0.7 }}>Time on Cloud (Backup)</div>
                       <div style={{ fontSize: '1.2rem', color: '#f5a623' }}>{formatMs(cloudMs)}</div>
                     </div>
                   </div>
                   
                   <div style={{ fontSize: '0.85rem' }}>
                     <strong style={{ opacity: 0.8 }}>Events Timeline:</strong>
                     {dayLogsAsc.length === 0 ? (
                       <div style={{ marginTop: '5px', opacity: 0.6 }}>No disruptions recorded today. Ran 100% on {currentState === 'cloud' ? 'Cloud' : 'Local'}.</div>
                     ) : (
                       <ul style={{ listStyleType: 'none', padding: 0, margin: '8px 0 0 0' }}>
                         {dayLogsAsc.map((l, idx) => (
                           <li key={idx} style={{ padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                             <span style={{ opacity: 0.6, marginRight: '10px' }}>{new Date(l.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                             <span>{l.message}</span>
                           </li>
                         ))}
                       </ul>
                     )}
                   </div>
                 </>
               );
             })()}
          </div>
        )}

        <div style={{ marginTop: 20, paddingTop: 15, borderTop: '1px solid var(--border-color)', fontSize: '0.85rem' }}>
           <p className="muted" style={{ marginBottom: 4 }}><strong>Last Cloud Fallback:</strong> {lastCloud ? new Date(lastCloud.createdAt).toLocaleString() : 'No recent fallbacks'}</p>
           <p className="muted"><strong>Last Complete Downtime:</strong> {lastDown ? `${new Date(lastDown.createdAt).toLocaleString()} - ${lastDown.message}` : 'No recent downtime recorded'}</p>
        </div>
      </div>
    );
  }

  return (
    <main className="dashboard-content">
      <header className="page-header">
        <h1>Engine Status</h1>
        <p className="muted">Live diagnostic view of the hybrid fallback engine.</p>
      </header>

      <div className="card" style={{ marginBottom: '20px' }}>
        <h3>Server Identity</h3>
        <p><strong>Active Host:</strong> <code>{hostname}</code></p>
        <p className="muted" style={{ marginTop: '5px' }}>This is the exact Vercel server you are currently logged into.</p>
      </div>

      <div className="dashboard-grid">
        {renderStatus('Myntra', myntraScrapeMode, myntraLastProxyCheck, myntraProxyInterval || 1)}
        {renderStatus('Amazon', amazonScrapeMode, amazonLastProxyCheck, amazonProxyInterval || 5)}
      </div>
    </main>
  );
}
