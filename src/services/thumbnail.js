/**
 * Thumbnail Service
 * Fallback to icon placeholders for MVP (no sharp dependency).
 */

export class ThumbnailService {
  getThumbnail(_fileId) {
    // Phase 1+: returns icon placeholder or WebP thumbnail if available
    return null;
  }
}

export const thumbnailService = new ThumbnailService();
