'use client';

import { useState } from 'react';
import { useDashboard } from '../../lib/DashboardContext';
import { formatDuration } from '../../lib/format';

export default function SessionsPage() {
  const { sessionHistory, saveSession } = useDashboard();
  const [curlText, setCurlText] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [amazonCurlText, setAmazonCurlText] = useState('');
  const [amazonSaveMsg, setAmazonSaveMsg] = useState('');

  async function submitSession({ curl, marketplace, setText, setMsg }) {
    setMsg('Saving...');
    try {
      const data = await saveSession({ curl, marketplace });
      setMsg(`Saved ${data.headerCount} headers.`);
      setText('');
    } catch (err) {
      setMsg(`Error: ${err.message}`);
    }
  }

  // Group session-history entries by calendar day (browser-local, i.e. IST for
  // this seller) so the history reads as one section per date.
  const historyGroups = [];
  for (const entry of sessionHistory || []) {
    const dateKey = new Date(entry.capturedAt).toLocaleDateString();
    const last = historyGroups[historyGroups.length - 1];
    if (last && last.dateKey === dateKey) last.entries.push(entry);
    else historyGroups.push({ dateKey, entries: [entry] });
  }

  return (
    <>
      <div className="page-header">
        <h1>Sessions</h1>
        <p className="muted">Refresh a marketplace session and see the capture/expiry history.</p>
      </div>

      <div className="card">
        <h2>Refresh Myntra session</h2>
        <p>
          DevTools → Network → right-click a partnersapi.myntrainfo.com/api/mdirect/orders request →
          Copy → Copy as cURL (or just copy the Headers panel). Paste the whole thing below.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitSession({ curl: curlText, marketplace: 'myntra', setText: setCurlText, setMsg: setSaveMsg });
          }}
        >
          <textarea
            rows={6}
            value={curlText}
            onChange={(e) => setCurlText(e.target.value)}
            placeholder="curl --url 'https://partnersapi.myntrainfo.com/...' -H '...' -b '...' ..."
          />
          <button type="submit">Save Myntra session</button>
        </form>
        {saveMsg && <p>{saveMsg}</p>}
      </div>

      <div className="card">
        <h2>Refresh Amazon session</h2>
        <p>
          On sellercentral.amazon.in → DevTools → Network → right-click a request to
          orders-api/search or orders-api/countOrders → Copy → Copy as cURL (or copy the Headers
          panel). Paste the whole thing below.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitSession({ curl: amazonCurlText, marketplace: 'amazon', setText: setAmazonCurlText, setMsg: setAmazonSaveMsg });
          }}
        >
          <textarea
            rows={6}
            value={amazonCurlText}
            onChange={(e) => setAmazonCurlText(e.target.value)}
            placeholder="curl --url 'https://sellercentral.amazon.in/orders-api/search?...' -H '...' -b '...' ..."
          />
          <button type="submit">Save Amazon session</button>
        </form>
        {amazonSaveMsg && <p>{amazonSaveMsg}</p>}
      </div>

      <div className="card">
        <h2>Session history</h2>
        {historyGroups.length === 0 ? (
          <p className="muted">No sessions recorded yet — this starts tracking from your next paste.</p>
        ) : (
          historyGroups.map((g) => (
            <div className="history-day" key={g.dateKey}>
              <div className="history-date">{g.dateKey}</div>
              {g.entries.map((entry) => (
                <div className="history-row" key={entry._id}>
                  <span className={`source-tag ${entry.marketplace}`}>
                    {entry.marketplace === 'amazon' ? 'Amazon' : 'Myntra'}
                  </span>
                  <span>{new Date(entry.capturedAt).toLocaleTimeString()}</span>
                  <span className="muted">→</span>
                  {entry.expiredAt ? (
                    <>
                      <span>{new Date(entry.expiredAt).toLocaleTimeString()}</span>
                      <span className="sku-tag">{formatDuration(entry.durationMs)}</span>
                      {entry.endedBy === 'replaced' && <span className="muted">(replaced)</span>}
                    </>
                  ) : (
                    <span className="history-active">Still active</span>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}
