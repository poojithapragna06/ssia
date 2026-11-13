const crypto = require('crypto');
const InstagramMedia = require('../models/InstagramMedia');
const InstagramSyncRun = require('../models/InstagramSyncRun');
const { settings, statusView, encryptToken, processMetaSync, runExpiry, refreshActivePlaylist, removalDateForEventEnd, ensureProcessingConfigured } = require('../services/instagramService');

const send = (res, message, data) => res.json({ success: true, message, data });

async function getStatus(req, res) {
  const config = await settings();
  const [pending, active, archived, runs] = await Promise.all([
    InstagramMedia.countDocuments({ status: 'review' }), InstagramMedia.countDocuments({ status: 'active' }),
    InstagramMedia.countDocuments({ status: { $in: ['archived', 'story_expired'] } }),
    InstagramSyncRun.find().sort({ startedAt: -1 }).limit(20),
  ]);
  return send(res, 'Instagram automation status', { ...statusView(config), counts: { pending, active, archived }, runs });
}

async function updateSettings(req, res) {
  const allowed = ['enabled', 'feedSync', 'storySync', 'autoInsert', 'carouselDuration'];
  const config = await settings();
  for (const field of allowed) if (req.body[field] !== undefined) config[field] = req.body[field];
  if (!config.enabled) { config.feedSync = false; config.storySync = false; }
  if ((config.feedSync || config.storySync || config.enabled) && !config.accountId) {
    return res.status(400).json({ success: false, message: 'Connect an Instagram account before enabling automation', errors: [] });
  }
  if (config.enabled || config.feedSync || config.storySync) {
    try { ensureProcessingConfigured(); }
    catch (error) { return res.status(503).json({ success: false, message: error.message, errors: [] }); }
  }
  await config.save();
  if (req.body.autoInsert !== undefined || req.body.enabled === true) await refreshActivePlaylist(true);
  return send(res, 'Instagram settings updated', statusView(config));
}

async function connect(req, res) {
  const { META_APP_ID, META_REDIRECT_URI, META_OAUTH_SCOPES } = process.env;
  if (!META_APP_ID || !META_REDIRECT_URI) return res.status(503).json({ success: false, message: 'Meta OAuth is not configured', errors: [] });
  const config = await settings();
  const state = crypto.randomBytes(32).toString('hex');
  config.oauthStateHash = crypto.createHash('sha256').update(state).digest('hex');
  config.oauthStateExpiresAt = new Date(Date.now() + 10 * 60 * 1000); await config.save();
  const url = new URL(`https://www.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}/dialog/oauth`);
  url.search = new URLSearchParams({ client_id: META_APP_ID, redirect_uri: META_REDIRECT_URI, state, scope: META_OAUTH_SCOPES || 'instagram_basic,pages_show_list,pages_read_engagement' }).toString();
  return send(res, 'OAuth URL created', { url: url.toString() });
}

async function oauthCallback(req, res) {
  const config = await require('../models/InstagramSettings').findOne({ key: 'default' }).select('+oauthStateHash +oauthStateExpiresAt');
  const candidate = crypto.createHash('sha256').update(String(req.query.state || '')).digest('hex');
  if (!config?.oauthStateHash || !config.oauthStateExpiresAt || config.oauthStateExpiresAt < new Date() || !crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(config.oauthStateHash))) {
    return res.status(400).send('Instagram authorization state is invalid or expired. Return to ScreenSync and try again.');
  }
  config.oauthStateHash = null; config.oauthStateExpiresAt = null;
  if (req.query.error || !req.query.code) { await config.save(); return res.status(400).send('Instagram authorization was not completed. Return to ScreenSync.'); }
  try {
    const tokenUrl = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}/oauth/access_token`);
    tokenUrl.search = new URLSearchParams({ client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: process.env.META_REDIRECT_URI, code: req.query.code }).toString();
    const tokenResponse = await fetch(tokenUrl); const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenPayload.access_token) throw new Error(tokenPayload.error?.message || 'Meta token exchange failed');
    const pagesUrl = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}/me/accounts`);
    pagesUrl.search = new URLSearchParams({ fields: 'id,name,instagram_business_account{id,username}', access_token: tokenPayload.access_token }).toString();
    const pagesResponse = await fetch(pagesUrl); const pages = await pagesResponse.json();
    if (!pagesResponse.ok) throw new Error(pages.error?.message || 'Unable to find an Instagram professional account');
    const account = (pages.data || []).find((page) => page.instagram_business_account?.id);
    if (!account) throw new Error('No eligible Instagram professional account is linked to the authorized Facebook Page');
    config.accountId = account.instagram_business_account.id; config.username = account.instagram_business_account.username || null;
    config.accessTokenEncrypted = encryptToken(tokenPayload.access_token);
    config.tokenExpiresAt = tokenPayload.expires_in ? new Date(Date.now() + tokenPayload.expires_in * 1000) : null;
    await config.save();
    const dashboardUrl = new URL('/instagram?connected=1', process.env.FRONTEND_BASE_URL || `${req.protocol}://${req.get('host')}`);
    return res.redirect(dashboardUrl.toString());
  } catch (error) {
    await config.save(); console.error('[Instagram] OAuth callback failed:', error.message);
    return res.status(400).send('Instagram account connection failed. Check the Meta permissions and ScreenSync logs.');
  }
}

async function disconnect(req, res) {
  const config = await settings(); config.accountId = null; config.username = null; config.accessTokenEncrypted = null; config.tokenExpiresAt = null;
  config.enabled = false; config.feedSync = false; config.storySync = false; await config.save();
  return send(res, 'Instagram disconnected and automation disabled', statusView(config));
}

async function manualSync(req, res) {
  const job = req.body.job || 'feed';
  if (!['feed', 'stories', 'expiry'].includes(job)) return res.status(400).json({ success: false, message: 'job must be feed, stories, or expiry', errors: [] });
  const result = job === 'expiry' ? await runExpiry() : await processMetaSync(job);
  return send(res, 'Instagram sync completed', result);
}

async function listMedia(req, res) {
  const status = req.query.status;
  const filter = status === 'archived' ? { status: { $in: ['archived', 'story_expired'] } } : status ? { status } : {};
  const media = await InstagramMedia.find(filter).sort({ createdAt: -1 }).limit(200);
  return send(res, 'Instagram media', { media });
}

async function reviewMedia(req, res) {
  const media = await InstagramMedia.findById(req.params.id);
  if (!media) return res.status(404).json({ success: false, message: 'Media not found', errors: [] });
  const endDate = req.body.eventEndDate ? new Date(req.body.eventEndDate) : null;
  if (!endDate || Number.isNaN(endDate.getTime())) return res.status(400).json({ success: false, message: 'A valid event end date is required', errors: [] });
  media.event = { ...media.event.toObject?.(), name: req.body.eventName || media.event?.name, startDate: req.body.eventStartDate ? new Date(req.body.eventStartDate) : media.event?.startDate, endDate };
  media.removalAt = removalDateForEventEnd(endDate);
  media.reviewReason = null; media.status = 'active'; media.autoInserted = Boolean(req.body.insertToPlaylist);
  await media.save();
  if (media.autoInserted) await refreshActivePlaylist();
  return send(res, 'Event date approved', { media });
}

async function removeMedia(req, res) {
  const media = await InstagramMedia.findById(req.params.id);
  if (!media) return res.status(404).json({ success: false, message: 'Media not found', errors: [] });
  media.status = 'archived'; media.archivedAt = new Date(); media.autoInserted = false; media.reviewReason = 'Manually removed by admin';
  await media.save();
  await refreshActivePlaylist(true);
  return send(res, 'Instagram media removed from the active playlist and archived', { media });
}

async function listRuns(req, res) {
  const runs = await InstagramSyncRun.find().sort({ startedAt: -1 }).limit(100);
  return send(res, 'Instagram sync history', { runs });
}

async function scheduledJob(req, res) {
  const configured = process.env.INSTAGRAM_SCHEDULER_SECRET;
  const supplied = req.get('x-screensync-job-secret') || '';
  if (!configured || supplied.length !== configured.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(configured))) {
    return res.status(401).json({ success: false, message: 'Invalid scheduler credentials', errors: [] });
  }
  const job = req.params.job;
  if (job === 'expiry') return send(res, 'Event expiry completed', await runExpiry());
  if (!['feed', 'stories'].includes(job)) return res.status(404).json({ success: false, message: 'Unknown scheduled job', errors: [] });
  return send(res, `${job} sync completed`, await processMetaSync(job));
}

async function streamMedia(req, res) {
  const item = await InstagramMedia.findOne({ instagramId: req.params.postId, status: 'active', autoInserted: true });
  if (!item) return res.status(404).end();
  const order = Number(req.params.order);
  const slide = item.media.find((entry) => entry.order === order);
  if (!slide?.storageKey) return res.status(404).end();
  const { readMedia } = require('../services/instagramStorageService');
  try {
    const object = await readMedia(slide.storageKey);
    res.set('Content-Type', slide.mimeType || object.ContentType || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('X-Content-Type-Options', 'nosniff');
    if (object.ContentLength) res.set('Content-Length', String(object.ContentLength));
    object.Body.on('error', (error) => { console.error('[Instagram] Media stream failed:', error.message); if (!res.headersSent) res.status(502); res.end(); });
    return object.Body.pipe(res);
  } catch (error) {
    console.error('[Instagram] Stored media read failed:', error.message);
    return res.status(502).json({ success: false, message: 'Stored Instagram media is temporarily unavailable', errors: [] });
  }
}

module.exports = { getStatus, updateSettings, connect, oauthCallback, disconnect, manualSync, listMedia, reviewMedia, removeMedia, listRuns, scheduledJob, streamMedia };
