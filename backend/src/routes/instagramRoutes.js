const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { authenticateUser, authorizeRoles } = require('../middleware/authMiddleware');
const controller = require('../controllers/instagramController');
const router = express.Router();
const admin = [authenticateUser, authorizeRoles('admin')];

router.get('/oauth/callback', asyncHandler(controller.oauthCallback));
// TVs load media without an admin JWT; this read-only endpoint resolves IDs to private S3 objects.
router.get('/media/:postId/:order', asyncHandler(controller.streamMedia));
router.post('/jobs/:job', asyncHandler(controller.scheduledJob));
router.get('/status', ...admin, asyncHandler(controller.getStatus));
router.patch('/settings', ...admin, asyncHandler(controller.updateSettings));
router.post('/connect', ...admin, asyncHandler(controller.connect));
router.delete('/connect', ...admin, asyncHandler(controller.disconnect));
router.post('/sync', ...admin, asyncHandler(controller.manualSync));
router.get('/media', ...admin, asyncHandler(controller.listMedia));
router.patch('/media/:id/review', ...admin, asyncHandler(controller.reviewMedia));
router.post('/media/:id/remove', ...admin, asyncHandler(controller.removeMedia));
router.get('/history', ...admin, asyncHandler(controller.listRuns));

module.exports = router;
