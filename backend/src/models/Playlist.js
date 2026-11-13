const mongoose = require('mongoose');
const { MEDIA_TYPE } = require('../utils/constants');

const playlistItemSchema = new mongoose.Schema(
  {
    media_type: {
      type: String,
      enum: Object.values(MEDIA_TYPE),
      required: true,
    },
    url: {
      type: String,
      required: function urlRequired() {
        return [MEDIA_TYPE.IMAGE, MEDIA_TYPE.VIDEO, MEDIA_TYPE.YOUTUBE].includes(this.media_type);
      },
      trim: true,
    },
    content: {
      type: String,
      required: function contentRequired() {
        return this.media_type === MEDIA_TYPE.TEXT;
      },
      trim: true,
      maxlength: 2000,
    },
    duration: {
      type: Number,
      required: [true, 'Duration (seconds) is required'],
      min: [1, 'Duration must be at least 1 second'],
      max: [21600, 'Duration must be 6 hours or less'],
    },
    // Imported items are tagged so Instagram sync can update only its own
    // entries while preserving every manually managed playlist item.
    source: { type: String, enum: ['manual', 'instagram'], default: 'manual' },
    instagramId: { type: String, default: null },
  },
  { _id: true }
);

const playlistSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Playlist name is required'],
      trim: true,
      minlength: 1,
      maxlength: 150,
    },
    type: {
      type: String,
      default: 'playlist',
      immutable: true,
    },
    items: {
      type: [playlistItemSchema],
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: 'Playlist must contain at least one item',
      },
    },
    active: {
      type: Boolean,
      default: false,
    },
    sync_timestamp: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

playlistSchema.index({ name: 1 });
playlistSchema.index({ active: 1 });

module.exports = mongoose.model('Playlist', playlistSchema);
