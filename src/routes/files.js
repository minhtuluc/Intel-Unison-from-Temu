/**
 * File sharing and staging routes
 * Handles listing shared files, staging files from PC, and unstaging files.
 */

import { Router } from 'express';

export const filesRouter = Router();

// GET /api/shared - List staged files
filesRouter.get('/api/shared', (_req, res) => {
  res.json({
    success: true,
    data: {
      files: [],
      totalSize: 0,
      totalSizeFormatted: '0 B',
      fileCount: 0,
    },
  });
});

// POST /api/share - Stage files
filesRouter.post('/api/share', (_req, res) => {
  res.status(201).json({
    success: true,
    data: { shared: [] },
  });
});

// DELETE /api/share/:fileId - Unstage a file
filesRouter.delete('/api/share/:fileId', (req, res) => {
  res.json({
    success: true,
    data: { removed: req.params.fileId },
  });
});
