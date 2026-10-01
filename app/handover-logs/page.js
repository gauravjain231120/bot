'use client';

import { useState, useEffect } from 'react';

export default function HandoverLogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function fetchLogs() {
      try {
        const res = await fetch('/api/handover-logs');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to fetch logs');
        setLogs(data.logs);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchLogs();
  }, []);

  return (
    <>
      <div className="page-header">
        <h1>Handover Logs</h1>
        <p className="muted">Courier device count vs physically received count.</p>
      </div>

      <div className="card">
        {error ? (
          <div style={{ color: 'var(--bad)', marginBottom: 20 }}>{error}</div>
        ) : loading ? (
          <div className="muted">Loading logs...</div>
        ) : logs.length === 0 ? (
          <div className="muted">No handover logs recorded yet. Use the Telegram button to log one.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)' }}>
                  <th style={{ padding: '10px 5px' }}>Date</th>
                  <th style={{ padding: '10px 5px', textAlign: 'center' }}>MYS (Rec / Dev)</th>
                  <th style={{ padding: '10px 5px', textAlign: 'center' }}>MYE (Rec / Dev)</th>
                  <th style={{ padding: '10px 5px' }}>Notes</th>
                  <th style={{ padding: '10px 5px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const mysOk = log.mysReceived === log.mysDevice;
                  const myeOk = log.myeReceived === log.myeDevice;
                  const discrepancy = !mysOk || !myeOk;

                  const colorStyle = (ok) => ({
                    color: ok ? 'var(--text)' : 'var(--bad)',
                    fontWeight: ok ? 'normal' : 'bold'
                  });

                  return (
                    <tr key={log.date} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '12px 5px', fontWeight: 600 }}>{log.date}</td>
                      <td style={{ padding: '12px 5px', textAlign: 'center', ...colorStyle(mysOk) }}>
                        {log.mysReceived} / {log.mysDevice}
                      </td>
                      <td style={{ padding: '12px 5px', textAlign: 'center', ...colorStyle(myeOk) }}>
                        {log.myeReceived} / {log.myeDevice}
                      </td>
                      <td style={{ padding: '12px 5px', color: 'var(--text-dim)' }}>
                        {log.notes || '—'}
                      </td>
                      <td style={{ padding: '12px 5px' }}>
                        {discrepancy ? (
                          <span style={{ color: 'var(--bad)', fontWeight: 600, fontSize: '0.8rem', padding: '2px 6px', background: 'var(--bad-soft, rgba(239, 68, 68, 0.1))', borderRadius: 4 }}>Discrepancy</span>
                        ) : (
                          <span style={{ color: 'var(--good)', fontWeight: 600, fontSize: '0.8rem' }}>Matched</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
