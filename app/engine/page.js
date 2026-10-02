'use client';

import { useEffect, useState } from 'react';
import { useDashboard } from '../../lib/DashboardContext';

export default function EngineStatusPage() {
  const { status, isOwner } = useDashboard();
  const [hostname, setHostname] = useState('Loading...');

  const [history, setHistory] = useState([]);

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
        
        <div style={{ marginTop: 15, paddingTop: 15, borderTop: '1px solid var(--border-color)', fontSize: '0.9rem' }}>
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
