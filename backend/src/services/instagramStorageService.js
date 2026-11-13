const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

let client;
function storageConfig() {
  const bucket = process.env.INSTAGRAM_OBJECT_STORAGE_BUCKET;
  const region = process.env.INSTAGRAM_OBJECT_STORAGE_REGION;
  if (!bucket || !region) throw new Error('Instagram media storage is not configured (bucket and region are required)');
  return { bucket, region };
}
function s3() {
  if (!client) {
    const { region } = storageConfig();
    client = new S3Client({ region, ...(process.env.INSTAGRAM_OBJECT_STORAGE_ENDPOINT ? { endpoint: process.env.INSTAGRAM_OBJECT_STORAGE_ENDPOINT } : {}), ...(process.env.INSTAGRAM_OBJECT_STORAGE_FORCE_PATH_STYLE === 'true' ? { forcePathStyle: true } : {}) });
  }
  return client;
}
function objectKey(postId, order, mimeType) {
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : mimeType === 'video/mp4' ? 'mp4' : mimeType === 'video/quicktime' ? 'mov' : 'jpg';
  return `instagram/${crypto.createHash('sha256').update(postId).digest('hex')}/${String(order).padStart(3, '0')}.${ext}`;
}
async function storeMedia(postId, order, body, mimeType) {
  const { bucket } = storageConfig();
  const key = objectKey(postId, order, mimeType);
  await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mimeType, CacheControl: 'public, max-age=31536000, immutable' }));
  return { storageKey: key, url: `/api/instagram/media/${encodeURIComponent(postId)}/${order}` };
}
async function readMedia(key) {
  const { bucket } = storageConfig();
  return s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}
async function deleteMedia(key) {
  const { bucket } = storageConfig();
  await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
module.exports = { storageConfig, storeMedia, readMedia, deleteMedia };
