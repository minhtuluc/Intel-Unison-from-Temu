/**
 * Share Manager Service
 * Manages in-memory staged files for sharing over LAN.
 */

export class ShareManager {
  constructor() {
    this.stagedFiles = new Map();
  }

  async addFile(_filePath) {
    throw new Error('Not implemented');
  }

  async removeFile(_fileId) {
    throw new Error('Not implemented');
  }

  getFile(_fileId) {
    throw new Error('Not implemented');
  }

  listFiles() {
    return Array.from(this.stagedFiles.values());
  }

  clear() {
    this.stagedFiles.clear();
  }
}

export const shareManager = new ShareManager();
