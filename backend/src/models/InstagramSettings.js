const mongoose = require('mongoose');

const instagramSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  enabled: { type: Boolean, default: false },
  feedSync: { type: Boolean, default: false },
  storySync: { type: Boolean, default: false },
  autoInsert: { type: Boolean, default: false },
  carouselDuration: { type: Number, default: 10, min: 1, max: 21600 },
  accountId: { type: String, default: null },
  username: { type: String, default: null },
  accessTokenEncrypted: { type: String, default: null, select: false },
  tokenExpiresAt: { type: Date, default: null },
  oauthStateHash: { type: String, default: null, select: false },
  oauthStateExpiresAt: { type: Date, default: null, select: false },
  expiryLockUntil: { type: Date, default: null, select: false },
  feedLockUntil: { type: Date, default: null, select: false },
  storyLockUntil: { type: Date, default: null, select: false },
  lastFeedSyncAt: { type: Date, default: null },
  lastStorySyncAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('InstagramSettings', instagramSettingsSchema);
