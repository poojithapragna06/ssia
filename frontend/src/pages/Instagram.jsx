import React, { useCallback, useEffect, useState } from 'react';
import { instagramApi } from '../services/api';

export default function Instagram() {
  const [status, setStatus] = useState(null);
  const [media, setMedia] = useState([]);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, m, h] = await Promise.all([instagramApi.status(), instagramApi.media(), instagramApi.history()]);
      setStatus(s.data.data); setMedia(m.data.data.media); setRuns(h.data.data.runs);
    } catch (e) { setError(e.response?.data?.message || 'Could not load Instagram settings'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    if (oauthError) setError(oauthError);
    if (oauthError || params.has('connected')) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function save(patch) {
    setBusy(true); setError('');
    try { await instagramApi.update(patch); await load(); }
    catch (e) { setError(e.response?.data?.message || 'Could not save settings'); }
    finally { setBusy(false); }
  }
  async function connect() {
    setBusy(true); setError('');
    try { const response = await instagramApi.connect(); window.location.assign(response.data.data.url); }
    catch (e) { setError(e.response?.data?.message || 'Could not start Meta authorization'); setBusy(false); }
  }
  async function sync(job) {
    setBusy(true); setError('');
    try { await instagramApi.sync(job); await load(); }
    catch (e) { setError(e.response?.data?.message || 'Sync failed'); }
    finally { setBusy(false); }
  }
  async function approve(item) {
    const date = window.prompt('Confirmed event end date (YYYY-MM-DD). Registration deadlines are not event end dates.');
    if (!date) return;
    setBusy(true);
    try { await instagramApi.review(item._id, { eventEndDate: date, insertToPlaylist: status.autoInsert }); await load(); }
    catch (e) { setError(e.response?.data?.message || 'Could not approve date'); }
    finally { setBusy(false); }
  }

  if (!status) return <div className="page-loading">Loading Instagram automation…</div>;
  return <section className="page">
    <header className="page-header"><div><h1>Instagram Automation</h1><p>Official Meta Graph API integration · timezone {status.timezone}</p></div></header>
    {error && <div className="form-error">{error}</div>}
    <section className="card"><h2>Account and automation</h2>
      <p>Status: <strong>{status.connected ? `Connected${status.username ? ` as @${status.username}` : ''}` : 'Not connected'}</strong> · Automation {status.enabled ? 'enabled' : 'disabled'}</p>
      <div className="form-actions">
        {!status.connected ? <button className="btn btn-primary" disabled={busy} onClick={connect}>Connect Instagram</button> : <button className="btn btn-secondary" disabled={busy} onClick={async () => { await instagramApi.disconnect(); await load(); }}>Disconnect</button>}
        <button className="btn btn-secondary" disabled={busy || !status.connected} onClick={() => sync('feed')}>Sync feed now</button>
        <button className="btn btn-secondary" disabled={busy || !status.connected} onClick={() => sync('stories')}>Sync stories now</button>
      </div>
      <div className="form-actions">
        <label><input type="checkbox" checked={status.enabled} disabled={!status.connected || busy} onChange={(e) => save({ enabled: e.target.checked })}/> Enable automation</label>
        <label><input type="checkbox" checked={status.feedSync} disabled={!status.connected || busy} onChange={(e) => save({ feedSync: e.target.checked })}/> Feed sync</label>
        <label><input type="checkbox" checked={status.storySync} disabled={!status.connected || busy} onChange={(e) => save({ storySync: e.target.checked })}/> Story sync</label>
        <label><input type="checkbox" checked={status.autoInsert} disabled={busy} onChange={(e) => save({ autoInsert: e.target.checked })}/> Insert approved media into active playlist</label>
        <label>Carousel slide seconds <input type="number" min="1" max="21600" value={status.carouselDuration} onChange={(e) => setStatus({ ...status, carouselDuration: Number(e.target.value) })} onBlur={(e) => save({ carouselDuration: Number(e.target.value) })}/></label>
      </div>
      <p>Last feed sync: {status.lastFeedSyncAt ? new Date(status.lastFeedSyncAt).toLocaleString() : 'Never'} · Next scheduled estimate: {status.nextFeedSyncAt ? new Date(status.nextFeedSyncAt).toLocaleString() : 'Disabled'}</p>
      <p>Last stories sync: {status.lastStorySyncAt ? new Date(status.lastStorySyncAt).toLocaleString() : 'Never'} · Next scheduled estimate: {status.nextStorySyncAt ? new Date(status.nextStorySyncAt).toLocaleString() : 'Disabled'}</p>
    </section>
    <section className="card"><h2>Media review and archive</h2><p>{status.counts.pending} pending · {status.counts.active} active · {status.counts.archived} archived</p>
      {media.length === 0 ? <p>No imported media yet.</p> : media.map((item) => <article className="card" key={item._id}><strong>{item.event?.name || item.caption || item.mediaType}</strong><p>{item.status} · Instagram ID {item.instagramId} · {item.media?.length || 0} slide(s)</p><p>{item.reviewReason || 'OCR text'}{item.ocrText ? `: ${item.ocrText}` : ''}</p>{item.event?.startDate && <p>Event starts {new Date(item.event.startDate).toLocaleDateString()}</p>}{item.event?.endDate && <p>Event ends {new Date(item.event.endDate).toLocaleDateString()} · removal {item.removalAt ? new Date(item.removalAt).toLocaleString() : '—'}</p>}{item.event?.startTime && <p>Time: {item.event.startTime}{item.event.endTime ? `–${item.event.endTime}` : ''}</p>}{item.event?.venue && <p>Venue: {item.event.venue}</p>}{item.event?.registrationDeadline && <p>Registration deadline: {new Date(item.event.registrationDeadline).toLocaleDateString()}</p>}{item.event?.explicitExpiryDate && <p>Explicit offer expiry: {new Date(item.event.explicitExpiryDate).toLocaleDateString()}</p>}{item.status === 'review' && <button className="btn btn-primary" disabled={busy} onClick={() => approve(item)}>Review / approve event end date</button>}{item.status === 'active' && <button className="btn btn-secondary" disabled={busy} onClick={async () => { setBusy(true); try { await instagramApi.remove(item._id); await load(); } catch (e) { setError(e.response?.data?.message || 'Could not remove media'); } finally { setBusy(false); } }}>Remove from playlist</button>}</article>)}
    </section>
    <section className="card"><h2>Sync history</h2>{runs.length ? runs.map((run) => <p key={run._id}>{new Date(run.startedAt).toLocaleString()} · {run.job} · {run.status} · imported {run.imported}, skipped {run.skipped}, expired {run.expired}{run.message ? ` · ${run.message}` : ''}</p>) : <p>No sync runs yet.</p>}</section>
  </section>;
}
