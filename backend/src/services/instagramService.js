const crypto = require('crypto');
const InstagramSettings = require('../models/InstagramSettings');
const InstagramMedia = require('../models/InstagramMedia');
const InstagramSyncRun = require('../models/InstagramSyncRun');
const Playlist = require('../models/Playlist');
const { storageConfig, storeMedia, deleteMedia } = require('./instagramStorageService');
const { recognizeImage, inferEventDates, terminateWorker } = require('./instagramOcrService');
const { broadcastToTVs, pauseAdjustedSyncTimestamp } = require('./websocketService');

const IST = 'Asia/Kolkata';
const DAY = 24 * 60 * 60 * 1000;
const MAX_REMOTE_MEDIA_BYTES = Number(process.env.INSTAGRAM_MAX_MEDIA_BYTES) || 100 * 1024 * 1024;
const MAX_OCR_IMAGE_BYTES = Number(process.env.INSTAGRAM_MAX_IMAGE_BYTES) || 25 * 1024 * 1024;

async function settings() {
  return InstagramSettings.findOneAndUpdate({ key: 'default' }, { $setOnInsert: { key: 'default' } }, { upsert: true, new: true }).select('+accessTokenEncrypted');
}
function encryptionKey() {
  const secret = process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error('INSTAGRAM_TOKEN_ENCRYPTION_KEY must be configured before connecting Instagram');
  return crypto.createHash('sha256').update(secret).digest();
}
function encryptToken(token) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}
function decryptToken(value) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
function statusView(config) {
  return {
    enabled: config.enabled, feedSync: config.feedSync, storySync: config.storySync,
    autoInsert: config.autoInsert, carouselDuration: config.carouselDuration,
    connected: Boolean(config.accountId && config.accessTokenEncrypted), username: config.username,
    accountId: config.accountId, lastFeedSyncAt: config.lastFeedSyncAt,
    lastStorySyncAt: config.lastStorySyncAt, timezone: IST,
    nextFeedSyncAt: config.feedSync ? nextUtc('daily') : null,
    nextStorySyncAt: config.storySync ? nextUtc('six-hourly') : null,
  };
}
function nextUtc(schedule) {
  const now = new Date();
  if (schedule === 'six-hourly') { const next = new Date(now); next.setUTCHours((Math.floor(now.getUTCHours() / 6) + 1) * 6, 0, 0, 0); return next; }
  const next = new Date(now); next.setUTCHours(2, 17, 0, 0); if (next <= now) next.setUTCDate(next.getUTCDate() + 1); return next;
}
function removalDateForEventEnd(endDate) {
  const date = new Date(endDate);
  // Event date is a calendar date in IST. Retain through the seventh full IST day.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 7, 18, 30, 0));
}
function ensureProcessingConfigured() {
  storageConfig();
  if (!process.env.META_GRAPH_VERSION) throw new Error('META_GRAPH_VERSION must be configured before enabling Instagram sync');
}

async function graphJSON(url, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (response.ok) return body;
      const err = new Error(body.error?.message || `Meta API returned ${response.status}`);
      if (response.status < 500 && response.status !== 429) throw err;
      lastError = err;
    } catch (error) {
      lastError = error;
      if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.cause?.code === 'ENOTFOUND') {
        if (attempt === retries) break;
      } else if (error.message && !/fetch failed/i.test(error.message)) throw error;
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
  }
  throw lastError || new Error('Meta API request failed');
}

function normalizeMediaType(type) {
  if (type === 'VIDEO') return 'video';
  if (type === 'IMAGE' || type === 'CAROUSEL_ALBUM') return 'image';
  return null;
}
function allowedMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && (host === 'fbcdn.net' || host.endsWith('.fbcdn.net') || host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') || host === 'facebook.com' || host.endsWith('.facebook.com'));
}
async function downloadMedia(mediaUrl) {
  if (!allowedMediaUrl(mediaUrl)) throw new Error('Meta returned a media URL outside the permitted HTTPS hosts');
  let response; let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      let target = mediaUrl;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        if (!allowedMediaUrl(target)) throw new Error('Meta media redirect left the permitted HTTPS hosts');
        response = await fetch(target, { signal: AbortSignal.timeout(45000), redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw new Error('Media download exceeded the redirect limit');
        target = new URL(location, target).toString();
      }
      if (response.ok) break;
      lastError = new Error(`Media download returned ${response.status}`);
      await response.body?.cancel();
      if (response.status < 500 && response.status !== 429) throw lastError;
    } catch (error) {
      lastError = error;
      if (/^Media download returned 4\d\d/.test(error.message) && !/429/.test(error.message)) throw error;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
  }
  if (!response?.ok) throw lastError || new Error('Media download failed');
  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) throw new Error(`Unsupported media type: ${contentType || 'unknown'}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REMOTE_MEDIA_BYTES) throw new Error('Instagram media exceeds configured maximum size');
  if (contentType.startsWith('image/') && Number.isFinite(length) && length > MAX_OCR_IMAGE_BYTES) throw new Error('Instagram image exceeds configured OCR size limit');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_REMOTE_MEDIA_BYTES) { response.body.cancel(); throw new Error('Instagram media exceeds configured maximum size'); }
    chunks.push(chunk);
  }
  if (contentType.startsWith('image/') && total > MAX_OCR_IMAGE_BYTES) throw new Error('Instagram image exceeds configured OCR size limit');
  return { buffer: Buffer.concat(chunks), mimeType: contentType };
}
function mediaCandidates(post, kind) {
  if (post.media_type === 'CAROUSEL_ALBUM') return (post.children?.data || []).map((child) => ({ id: child.id, type: child.media_type, url: child.media_url || child.thumbnail_url }));
  if (post.media_type === 'VIDEO') return [{ id: post.id, type: 'VIDEO', url: post.media_url || post.thumbnail_url }];
  return [{ id: post.id, type: 'IMAGE', url: post.media_url || post.thumbnail_url }];
}
async function getCarouselChildren(post, accessToken) {
  if (post.media_type !== 'CAROUSEL_ALBUM') return mediaCandidates(post);
  const graphVersion = process.env.META_GRAPH_VERSION;
  if (!graphVersion) throw new Error('META_GRAPH_VERSION must be configured');
  const url = new URL(`https://graph.facebook.com/${graphVersion}/${post.id}/children`);
  url.searchParams.set('fields', 'id,media_type,media_url,thumbnail_url'); url.searchParams.set('limit', '100'); url.searchParams.set('access_token', accessToken);
  const children = [];
  let page = url.toString(); let pages = 0;
  while (page && pages < 10) {
    const data = await graphJSON(page); children.push(...(data.data || [])); page = data.paging?.next || null; pages += 1;
  }
  if (page) throw new Error('Carousel has more than 1000 slides; stopped to protect the sync worker');
  return children.map((child) => ({ id: child.id, type: child.media_type, url: child.media_url || child.thumbnail_url }));
}

async function processPost(post, kind, config, accessToken, workerState) {
  const existing = await InstagramMedia.findOne({ instagramId: post.id });
  if (existing) { console.log(`[Instagram] skipped duplicate id=${post.id}`); return { skipped: true }; }
  const storyExpiresAt = kind === 'stories' && post.timestamp ? new Date(new Date(post.timestamp).getTime() + DAY) : null;
  if (storyExpiresAt && storyExpiresAt <= new Date()) { console.log(`[Instagram] skipped expired story id=${post.id}`); return { skipped: true, reason: 'Story is no longer available' }; }
  const candidates = await getCarouselChildren(post, accessToken);
  if (!candidates.length) throw new Error('Meta returned no carousel slides');
  const uploaded = []; const media = []; const ocrTexts = [];
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const mediaType = normalizeMediaType(candidate.type);
      if (!mediaType || !candidate.url) { workerState.skipped += 1; console.log(`[Instagram] skipped unsupported slide post=${post.id} slide=${index}`); continue; }
      const downloaded = await downloadMedia(candidate.url);
      if (mediaType === 'image' && !downloaded.mimeType.startsWith('image/')) throw new Error('Meta media type and downloaded media content do not match');
      if (mediaType === 'video' && !downloaded.mimeType.startsWith('video/')) throw new Error('Meta video did not return a video content type');
      const stored = await storeMedia(post.id, index, downloaded.buffer, downloaded.mimeType);
      uploaded.push(stored.storageKey);
      const slideOcr = mediaType === 'image' ? await recognizeImage(downloaded.buffer) : '';
      if (slideOcr) ocrTexts.push(slideOcr);
      media.push({ ...stored, type: mediaType, order: index, mimeType: downloaded.mimeType, ocrText: slideOcr });
    }
    if (!media.length) throw new Error('No supported image or video media was found');
    const ocrText = ocrTexts.join('\n\n--- Carousel slide ---\n\n');
    const eventDetails = inferEventDates([post.caption || '', ocrText].filter(Boolean).join('\n'));
    const isStory = kind === 'stories';
    const approvedEndDate = eventDetails.confidence === 'clear' ? eventDetails.eventEndDate : null;
    const record = await InstagramMedia.create({
      instagramId: post.id, accountId: config.accountId, mediaType: kind === 'stories' ? 'STORY' : post.media_type,
      caption: post.caption || '', permalink: post.permalink || '', media, ocrText,
      event: { name: eventDetails.eventName, startDate: eventDetails.eventStartDate, endDate: approvedEndDate, startTime: eventDetails.startTime, endTime: eventDetails.endTime, venue: eventDetails.venue, registrationDeadline: eventDetails.registrationDeadline, explicitExpiryDate: eventDetails.explicitExpiryDate },
      reviewReason: isStory ? null : eventDetails.reason,
      status: isStory ? 'active' : approvedEndDate ? 'active' : 'review',
      storyExpiresAt,
      removalAt: approvedEndDate ? removalDateForEventEnd(approvedEndDate) : null,
      autoInserted: Boolean(isStory || (config.autoInsert && approvedEndDate)),
    });
    workerState.imported += 1;
    console.log(`[Instagram] imported id=${record.instagramId} type=${record.mediaType} slides=${media.length} status=${record.status}`);
    return { record };
  } catch (error) {
    // A duplicate can be another worker's successful idempotent insert; keep its objects.
    if (error.code !== 11000) {
      await Promise.all(uploaded.map((key) => deleteMedia(key).catch((deleteError) => console.warn('[Instagram] Failed to clean incomplete object:', deleteError.message))));
    }
    throw error;
  }
}

async function acquireRunLock(config, job) {
  const field = job === 'feed' ? 'feedLockUntil' : 'storyLockUntil';
  const now = new Date();
  const locked = await InstagramSettings.findOneAndUpdate(
    { _id: config._id, $or: [{ [field]: null }, { [field]: { $lte: now } }] },
    { $set: { [field]: new Date(Date.now() + 45 * 60 * 1000) } }, { new: true }
  );
  return { field, locked: Boolean(locked) };
}
async function processMetaSync(kind) {
  const config = await settings();
  if (!config.enabled || !config.accountId || !config.accessTokenEncrypted) throw new Error('Instagram automation is disabled or no account is connected');
  if (kind === 'feed' && !config.feedSync) return { skipped: 'Feed sync is disabled' };
  if (kind === 'stories' && !config.storySync) return { skipped: 'Story sync is disabled' };
  if (!['feed', 'stories'].includes(kind)) throw new Error('Unknown Instagram sync type');
  ensureProcessingConfigured();
  const { field, locked } = await acquireRunLock(config, kind);
  if (!locked) return { skipped: `${kind} sync is already running` };
  const run = await InstagramSyncRun.create({ job: kind, status: 'running', message: `${kind} sync started` });
  const workerState = { imported: 0, skipped: 0, failed: 0, errors: [] };
  try {
    const accessToken = decryptToken(config.accessTokenEncrypted);
    const endpoint = kind === 'stories' ? 'stories' : 'media';
    const fields = kind === 'stories' ? 'id,media_type,media_url,thumbnail_url,timestamp' : 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{id,media_type,media_url,thumbnail_url}';
    const url = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION}/${config.accountId}/${endpoint}`);
    url.searchParams.set('fields', fields); url.searchParams.set('access_token', accessToken); url.searchParams.set('limit', '100');
    let page = url.toString(); let pages = 0;
    while (page && pages < 20) {
      const payload = await graphJSON(page);
      for (const post of payload.data || []) {
        try {
          const result = await processPost(post, kind, config, accessToken, workerState);
          if (result.skipped) workerState.skipped += 1;
        } catch (error) {
          if (error.code === 11000) { workerState.skipped += 1; continue; }
          workerState.failed += 1; workerState.errors.push(`${post.id}: ${error.message}`);
          console.error(`[Instagram] item failed id=${post.id}: ${error.message}`);
        }
      }
      page = payload.paging?.next || null; pages += 1;
    }
    if (page) throw new Error('Instagram feed has more than 2000 pages; stopped to protect the sync worker');
    const fieldName = kind === 'stories' ? 'lastStorySyncAt' : 'lastFeedSyncAt';
    if (!workerState.failed) { config[fieldName] = new Date(); await config.save(); }
    if (config.autoInsert && workerState.imported) await refreshActivePlaylist();
    run.status = workerState.failed ? (workerState.imported || workerState.skipped ? 'partial' : 'failed') : 'success';
    run.imported = workerState.imported; run.skipped = workerState.skipped; run.finishedAt = new Date();
    run.message = workerState.errors.slice(0, 20).join(' | ') || `Imported ${workerState.imported}; skipped ${workerState.skipped}`;
    await run.save();
    console.log(`[Instagram] ${kind} sync complete imported=${run.imported} skipped=${run.skipped} failed=${workerState.failed}`);
    return { imported: run.imported, skipped: run.skipped, failed: workerState.failed };
  } catch (error) {
    run.status = 'failed'; run.finishedAt = new Date(); run.imported = workerState.imported; run.skipped = workerState.skipped; run.message = error.message; await run.save();
    throw error;
  } finally {
    await terminateWorker();
    await InstagramSettings.updateOne({ _id: config._id }, { $set: { [field]: null } });
  }
}

async function refreshActivePlaylist(force = false) {
  const config = await settings();
  if ((!config.autoInsert || !config.enabled) && !force) return;
  const active = await Playlist.findOne({ active: true });
  if (!active) return;
  const imported = config.autoInsert && config.enabled
    ? await InstagramMedia.find({ status: 'active', autoInserted: true, 'media.0.url': { $exists: true } }).sort({ createdAt: 1 })
    : [];
  const manualItems = active.items.filter((item) => item.source !== 'instagram');
  const instagramItems = imported.flatMap((post) => post.media.map((slide) => ({ media_type: slide.type, url: slide.url, duration: config.carouselDuration, source: 'instagram', instagramId: post.instagramId })));
  active.items = [...manualItems, ...instagramItems];
  if (!active.items.length) {
    await Playlist.updateOne({ _id: active._id }, { $set: { items: [], active: false } }, { runValidators: false });
    broadcastToTVs({ type: 'clear_playlist', playlist_id: active._id.toString() });
    return;
  }
  await active.save();
  broadcastToTVs({ type: 'playlist', playlist_id: active._id.toString(), name: active.name, items: active.items, sync_timestamp: pauseAdjustedSyncTimestamp(active.sync_timestamp) });
}

async function runExpiry() {
  const config = await settings(); const now = new Date();
  const claimed = await InstagramSettings.findOneAndUpdate({ _id: config._id, $or: [{ expiryLockUntil: null }, { expiryLockUntil: { $lte: now } }] }, { $set: { expiryLockUntil: new Date(Date.now() + 30 * 60 * 1000) } }, { new: true });
  if (!claimed) return { skipped: 'Expiry job already running' };
  const run = await InstagramSyncRun.create({ job: 'expiry', status: 'running', message: 'Event expiry job started' });
  try {
    const media = await InstagramMedia.find({ status: 'active', removalAt: { $lte: now } });
    for (const item of media) { item.status = 'archived'; item.archivedAt = now; await item.save(); console.log(`[Instagram] archived event id=${item.instagramId} removedAt=${now.toISOString()}`); }
    const stories = await InstagramMedia.updateMany({ status: 'active', mediaType: 'STORY', storyExpiresAt: { $lte: now } }, { $set: { status: 'story_expired', archivedAt: now } });
    if (stories.modifiedCount) console.log(`[Instagram] archived expired stories count=${stories.modifiedCount}`);
    if ((media.length || stories.modifiedCount) && config.autoInsert) await refreshActivePlaylist();
    run.status = 'success'; run.expired = media.length + stories.modifiedCount; run.finishedAt = new Date(); await run.save();
    console.log(`[Instagram] expiry complete expired=${run.expired}`); return { expired: run.expired };
  } catch (error) {
    run.status = 'failed'; run.finishedAt = new Date(); run.message = error.message; await run.save(); throw error;
  } finally { await InstagramSettings.updateOne({ _id: config._id }, { $set: { expiryLockUntil: null } }); }
}

module.exports = { settings, statusView, encryptToken, decryptToken, processMetaSync, processPost, runExpiry, refreshActivePlaylist, removalDateForEventEnd, ensureProcessingConfigured, DAY, IST };
