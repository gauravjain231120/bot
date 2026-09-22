'use client';

import { useState } from 'react';
import { useDashboard } from '../../lib/DashboardContext';

export default function SessionsPage() {
  const { saveSession } = useDashboard();
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

  return (
    <>
      <div className="page-header">
        <h1>Sessions</h1>
        <p className="muted">Refresh a marketplace session.</p>
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
    </>
  );
}
