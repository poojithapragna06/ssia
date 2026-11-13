const mongoose = require('mongoose');

const instagramSyncRunSchema = new mongoose.Schema({
  job: { type: String, enum: ['feed', 'stories', 'expiry', 'manual'], required: true },
  status: { type: String, enum: ['running', 'success', 'partial', 'failed'], default: 'running' },
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
  imported: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 },
  expired: { type: Number, default: 0 },
  message: { type: String, default: '' },
  lockUntil: Date,
}, { timestamps: true });

module.exports = mongoose.model('InstagramSyncRun', instagramSyncRunSchema);
