/**
 * Transfer routes
 * Handles streaming file downloads and uploads (simple + chunked).
 */

import { Router } from 'express';

export const transferRouter = Router();

// GET /api/download/:fileId - Stream file with resume support
transferRouter.get('/api/download/:fileId', (req, res) => {
  res.status(501).json({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Download not implemented yet' },
  });
});

// POST /api/upload - Simple file upload (<100MB)
transferRouter.post('/api/upload', (_req, res) => {
  res.status(501).json({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Upload not implemented yet' },
  });
});
