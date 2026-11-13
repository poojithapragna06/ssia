const mongoose = require('mongoose');

const instagramMediaSchema = new mongoose.Schema({
  instagramId: { type: String, required: true, unique: true, index: true },
  accountId: { type: String, required: true },
  mediaType: { type: String, enum: ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM', 'STORY'], required: true },
  caption: { type: String, default: '' },
  permalink: { type: String, default: '' },
  media: [{ url: String, type: String, order: Number, storageKey: String, mimeType: String, ocrText: String }],
  ocrText: { type: String, default: '' },
  event: {
    name: String, startDate: Date, endDate: Date, startTime: String, endTime: String,
    venue: String, registrationDeadline: Date, explicitExpiryDate: Date,
  },
  reviewReason: { type: String, default: null },
  status: { type: String, enum: ['review', 'active', 'archived', 'story_expired'], default: 'review', index: true },
  autoInserted: { type: Boolean, default: false },
  storyExpiresAt: { type: Date, default: null },
  removalAt: { type: Date, default: null, index: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

instagramMediaSchema.index({ status: 1, removalAt: 1 });
module.exports = mongoose.model('InstagramMedia', instagramMediaSchema);
