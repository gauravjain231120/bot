'use client';

import { useState, useEffect } from 'react';

export default function HandoverLogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Editing state
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  
  // Adding state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState(getEmptyForm());

  function getEmptyForm() {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return {
      date: d.toISOString().split('T')[0],
      mysDevice: '', mysReceived: '', mysNotes: '',
      myeDevice: '', myeReceived: '', myeNotes: ''
    };
  }

  useEffect(() => {
    fetchLogs();
  }, []);

  async function fetchLogs() {
    setLoading(true);
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

  function handleEditClick(log) {
    setEditingId(log.date);
    setEditForm({
      mysDevice: log.mysDevice ?? '',
      mysReceived: log.mysReceived ?? '',
      mysNotes: log.mysNotes || '',
      myeDevice: log.myeDevice ?? '',
      myeReceived: log.myeReceived ?? '',
      myeNotes: log.myeNotes || '',
    });
  }

  async function handleSaveClick(date, formData, isNew = false) {
    const pwd = prompt('Enter admin password to save changes:');
    if (!pwd) return;

    try {
      const res = await fetch('/api/handover-logs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          password: pwd,
          ...formData
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      
      if (isNew) {
        setShowAddForm(false);
        setAddForm(getEmptyForm());
      } else {
        setEditingId(null);
      }
      
      fetchLogs(); // refresh
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleDeleteClick(date) {
    const pwd = prompt(`Enter admin password to permanently delete log for ${date}:`);
    if (!pwd) return;

    try {
      const res = await fetch('/api/handover-logs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, password: pwd })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      
      fetchLogs(); // refresh
    } catch (err) {
      alert(err.message);
    }
  }

  const btnStyle = { padding: '4px 8px', fontSize: '0.8rem', cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', borderRadius: 4, marginLeft: 5, color: 'var(--text)' };
  const addBtnStyle = { padding: '8px 16px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' };

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Handover Logs</h1>
          <p className="muted">Courier device count vs physically received count.</p>
        </div>
        <button style={addBtnStyle} onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? 'Cancel' : '➕ Add Log'}
        </button>
      </div>

      <div className="card">
        {error && <div style={{ color: 'var(--bad)', marginBottom: 20 }}>{error}</div>}
        
        {loading && !logs.length ? (
          <div className="muted">Loading logs...</div>
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
                  <th style={{ padding: '10px 5px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {/* New Record Form Row */}
                {showAddForm && (
                  <tr style={{ borderBottom: '2px solid #3b82f6', background: 'var(--bg-hover)' }}>
                    <td style={{ padding: '12px 5px' }}>
                      <input type="date" style={{ width: 120 }} value={addForm.date} onChange={e => setAddForm({...addForm, date: e.target.value})} />
                    </td>
                    <td style={{ padding: '12px 5px', textAlign: 'center' }}>
                      <input type="number" style={{ width: 40 }} value={addForm.mysReceived} onChange={e => setAddForm({...addForm, mysReceived: e.target.value})} placeholder="R" /> / 
                      <input type="number" style={{ width: 40, marginLeft: 5 }} value={addForm.mysDevice} onChange={e => setAddForm({...addForm, mysDevice: e.target.value})} placeholder="D" />
                    </td>
                    <td style={{ padding: '12px 5px', textAlign: 'center' }}>
                      <input type="number" style={{ width: 40 }} value={addForm.myeReceived} onChange={e => setAddForm({...addForm, myeReceived: e.target.value})} placeholder="R" /> / 
                      <input type="number" style={{ width: 40, marginLeft: 5 }} value={addForm.myeDevice} onChange={e => setAddForm({...addForm, myeDevice: e.target.value})} placeholder="D" />
                    </td>
                    <td style={{ padding: '12px 5px' }}>
                      <input type="text" style={{ width: 80, marginBottom: 2 }} placeholder="MYS notes" value={addForm.mysNotes} onChange={e => setAddForm({...addForm, mysNotes: e.target.value})} /><br/>
                      <input type="text" style={{ width: 80 }} placeholder="MYE notes" value={addForm.myeNotes} onChange={e => setAddForm({...addForm, myeNotes: e.target.value})} />
                    </td>
                    <td style={{ padding: '12px 5px' }}>
                      <span style={{ color: '#3b82f6', fontWeight: 600 }}>New Entry</span>
                    </td>
                    <td style={{ padding: '12px 5px', textAlign: 'right' }}>
                      <button style={{...btnStyle, color: 'white', background: '#3b82f6', borderColor: '#3b82f6'}} onClick={() => handleSaveClick(addForm.date, addForm, true)}>Save</button>
                    </td>
                  </tr>
                )}

                {logs.length === 0 && !showAddForm && (
                  <tr>
                    <td colSpan="6" style={{ padding: 20, textAlign: 'center' }} className="muted">No handover logs recorded yet.</td>
                  </tr>
                )}

                {logs.map((log) => {
                  const isEditing = editingId === log.date;

                  const mysRec = log.mysReceived ?? '-';
                  const mysDev = log.mysDevice ?? '-';
                  const myeRec = log.myeReceived ?? '-';
                  const myeDev = log.myeDevice ?? '-';
                  
                  const mysOk = log.mysReceived === log.mysDevice;
                  const myeOk = log.myeReceived === log.myeDevice;
                  const discrepancy = (log.mysDevice != null && !mysOk) || (log.myeDevice != null && !myeOk);

                  const colorStyle = (ok, isNull) => ({
                    color: isNull ? 'var(--text-dim)' : (ok ? 'var(--text)' : 'var(--bad)'),
                    fontWeight: isNull ? 'normal' : (ok ? 'normal' : 'bold')
                  });

                  const notesArray = [];
                  if (log.mysNotes) notesArray.push(`MYS: ${log.mysNotes}`);
                  if (log.myeNotes) notesArray.push(`MYE: ${log.myeNotes}`);
                  if (log.notes) notesArray.push(`Gen: ${log.notes}`);

                  if (isEditing) {
                    return (
                      <tr key={log.date} style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-hover)' }}>
                        <td style={{ padding: '12px 5px', fontWeight: 600 }}>{log.date}</td>
                        <td style={{ padding: '12px 5px', textAlign: 'center' }}>
                          <input type="number" style={{ width: 40 }} value={editForm.mysReceived} onChange={e => setEditForm({...editForm, mysReceived: e.target.value})} placeholder="R" /> / 
                          <input type="number" style={{ width: 40, marginLeft: 5 }} value={editForm.mysDevice} onChange={e => setEditForm({...editForm, mysDevice: e.target.value})} placeholder="D" />
                        </td>
                        <td style={{ padding: '12px 5px', textAlign: 'center' }}>
                          <input type="number" style={{ width: 40 }} value={editForm.myeReceived} onChange={e => setEditForm({...editForm, myeReceived: e.target.value})} placeholder="R" /> / 
                          <input type="number" style={{ width: 40, marginLeft: 5 }} value={editForm.myeDevice} onChange={e => setEditForm({...editForm, myeDevice: e.target.value})} placeholder="D" />
                        </td>
                        <td style={{ padding: '12px 5px' }}>
                          <input type="text" style={{ width: 80, marginBottom: 2 }} placeholder="MYS notes" value={editForm.mysNotes} onChange={e => setEditForm({...editForm, mysNotes: e.target.value})} /><br/>
                          <input type="text" style={{ width: 80 }} placeholder="MYE notes" value={editForm.myeNotes} onChange={e => setEditForm({...editForm, myeNotes: e.target.value})} />
                        </td>
                        <td style={{ padding: '12px 5px' }}>—</td>
                        <td style={{ padding: '12px 5px', textAlign: 'right' }}>
                          <button style={{...btnStyle, color: 'white', background: '#3b82f6', borderColor: '#3b82f6'}} onClick={() => handleSaveClick(log.date, editForm)}>Save</button>
                          <button style={btnStyle} onClick={() => setEditingId(null)}>Cancel</button>
                        </td>
                      </tr>
                    );
                  }
                  
                  return (
                    <tr key={log.date} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '12px 5px', fontWeight: 600 }}>{log.date}</td>
                      <td style={{ padding: '12px 5px', textAlign: 'center', ...colorStyle(mysOk, log.mysDevice == null) }}>
                        {mysRec} / {mysDev}
                      </td>
                      <td style={{ padding: '12px 5px', textAlign: 'center', ...colorStyle(myeOk, log.myeDevice == null) }}>
                        {myeRec} / {myeDev}
                      </td>
                      <td style={{ padding: '12px 5px', color: 'var(--text-dim)' }}>
                        {notesArray.join(' | ') || '—'}
                      </td>
                      <td style={{ padding: '12px 5px' }}>
                        {discrepancy ? (
                          <span style={{ color: 'var(--bad)', fontWeight: 600, fontSize: '0.8rem', padding: '2px 6px', background: 'var(--bad-soft, rgba(239, 68, 68, 0.1))', borderRadius: 4 }}>Discrepancy</span>
                        ) : (
                          <span style={{ color: 'var(--good)', fontWeight: 600, fontSize: '0.8rem' }}>Matched</span>
                        )}
                      </td>
                      <td style={{ padding: '12px 5px', textAlign: 'right' }}>
                        <button style={btnStyle} onClick={() => handleEditClick(log)}>Edit</button>
                        <button style={{...btnStyle, color: 'var(--bad)', borderColor: 'var(--bad-soft, rgba(239, 68, 68, 0.2))'}} onClick={() => handleDeleteClick(log.date)}>Delete</button>
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
