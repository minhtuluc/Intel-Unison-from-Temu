/**
 * UniversalTrans Client Transfer Engine
 * Handles queued, concurrent file uploads (<100MB single POST, >=100MB chunked protocol)
 * with rolling 5s speed calculation, ETA estimation, pause/resume, and PC approval tracking.
 */

import { formatFileSize, formatEta } from './utils.js';

export class TransferEngine {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.chunkSize = options.chunkSize || 10 * 1024 * 1024; // 10MB default
    this.maxRetries = options.maxRetries || 3;

    this.queue = [];
    this.activeTransfers = new Map();
    this.pausedTransfers = new Map();
    this.completedTransfers = [];
    this.failedTransfers = [];

    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
    }
  }

  _emit(event, data) {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        try {
          cb(data);
        } catch (err) {
          console.error(`Error in transfer listener for ${event}:`, err);
        }
      }
    }
  }

  /**
   * Adds files to the upload queue and initiates processing.
   * @param {FileList|File[]} files
   * @returns {Array<object>} Created tasks
   */
  addFiles(files) {
    const addedTasks = [];

    for (const file of files) {
      const isChunked = file.size >= 100 * 1024 * 1024;
      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const task = {
        id: taskId,
        file,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        status: 'queued', // queued, uploading, awaiting_approval, completed, error, paused, cancelled
        bytesUploaded: 0,
        progress: 0,
        speed: 0,
        speedFormatted: '0 B/s',
        eta: 0,
        etaFormatted: '--',
        isChunked,
        uploadId: null,
        transferId: null,
        currentChunk: 0,
        totalChunks: isChunked ? Math.ceil(file.size / this.chunkSize) : 1,
        retries: 0,
        speedSamples: [],
        createdAt: Date.now(),
        error: null,
        xhr: null,
      };

      this.queue.push(task);
      addedTasks.push(task);
      this._emit('task:added', task);
    }

    this._emit('queue:updated', this.getStatus());
    this._processQueue();

    return addedTasks;
  }

  /**
   * Processes queued transfers respecting concurrency limit.
   */
  async _processQueue() {
    while (this.activeTransfers.size < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      this.activeTransfers.set(task.id, task);
      task.status = 'uploading';
      this._emit('task:started', task);
      this._emit('queue:updated', this.getStatus());

      this._startUpload(task)
        .catch((err) => {
          console.error(`Upload failed for task ${task.id}:`, err);
        })
        .finally(() => {
          if (
            task.status === 'completed' ||
            task.status === 'error' ||
            task.status === 'cancelled'
          ) {
            this.activeTransfers.delete(task.id);
            this._emit('queue:updated', this.getStatus());
            this._processQueue();
          }
        });
    }
  }

  async _startUpload(task) {
    if (task.isChunked) {
      return this._uploadChunked(task);
    }
    return this._uploadSingle(task);
  }

  /**
   * Upload single file < 100MB via XHR with progress tracking.
   */
  _uploadSingle(task) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      task.xhr = xhr;
      task.speedSamples = [{ time: Date.now(), bytes: 0 }];

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          task.bytesUploaded = e.loaded;
          task.progress = Math.min(99, Math.round((e.loaded / e.total) * 100));
          this._updateSpeedAndEta(task, e.loaded, e.total);
          this._emit('task:progress', task);
        }
      };

      xhr.onload = () => {
        task.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          let response = {};
          try {
            response = JSON.parse(xhr.responseText);
          } catch {
            // Ignore JSON parse error
          }

          const pendingItem = response.data?.pending?.[0];
          if (pendingItem) {
            task.transferId = pendingItem.transferId;
            task.status = 'awaiting_approval';
            task.progress = 100;
            task.speed = 0;
            task.speedFormatted = '0 B/s';
            task.etaFormatted = 'Awaiting PC...';
            this._emit('task:awaiting_approval', task);
          } else {
            this._markCompleted(task);
          }
          resolve(task);
        } else {
          let errMsg = `Upload failed with status ${xhr.status}`;
          try {
            const errJson = JSON.parse(xhr.responseText);
            if (errJson.error?.message) errMsg = errJson.error.message;
          } catch {
            // ignore
          }
          this._markError(task, errMsg);
          reject(new Error(errMsg));
        }
      };

      xhr.onerror = () => {
        task.xhr = null;
        if (task.status === 'cancelled') return resolve(task);
        if (task.retries < this.maxRetries) {
          task.retries++;
          const delay = Math.pow(2, task.retries) * 500;
          setTimeout(() => {
            this._uploadSingle(task).then(resolve).catch(reject);
          }, delay);
        } else {
          this._markError(task, 'Network connection lost');
          reject(new Error('Network connection lost'));
        }
      };

      xhr.onabort = () => {
        task.xhr = null;
        resolve(task);
      };

      const formData = new FormData();
      formData.append('files', task.file, task.name);

      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Device-Id', this._getDeviceId());
      xhr.setRequestHeader('X-Device-Name', this._getDeviceName());
      xhr.setRequestHeader('X-Platform', this._getPlatform());
      xhr.send(formData);
    });
  }

  /**
   * Upload chunked file >= 100MB.
   */
  async _uploadChunked(task) {
    try {
      // Step 1: Init if not already initialized
      if (!task.uploadId) {
        const initRes = await fetch('/api/upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: task.name,
            fileSize: task.size,
            mimeType: task.type,
          }),
        });

        if (!initRes.ok) {
          throw new Error(`Init chunked upload failed: ${initRes.status}`);
        }

        const initData = await initRes.json();
        task.uploadId = initData.data.uploadId;
        task.chunkSize = initData.data.chunkSize || this.chunkSize;
        task.totalChunks = initData.data.totalChunks;
      }

      task.speedSamples = [{ time: Date.now(), bytes: task.bytesUploaded }];

      // Step 2: Upload chunks sequentially
      while (task.currentChunk < task.totalChunks) {
        if (task.status === 'paused' || task.status === 'cancelled') {
          return task;
        }

        const idx = task.currentChunk;
        const start = idx * task.chunkSize;
        const end = Math.min(task.size, start + task.chunkSize);
        const chunkBlob = task.file.slice(start, end);

        let chunkSuccess = false;
        let chunkRetries = 0;

        while (!chunkSuccess && chunkRetries <= this.maxRetries) {
          try {
            await this._uploadChunkWithProgress(task, idx, chunkBlob);
            chunkSuccess = true;
          } catch (err) {
            chunkRetries++;
            if (chunkRetries > this.maxRetries) {
              throw err;
            }
            await new Promise((r) => setTimeout(r, Math.pow(2, chunkRetries) * 500));
          }
        }

        task.currentChunk++;
        task.bytesUploaded = Math.min(task.size, end);
        task.progress = Math.min(99, Math.round((task.bytesUploaded / task.size) * 100));
        this._updateSpeedAndEta(task, task.bytesUploaded, task.size);
        this._emit('task:progress', task);
      }

      // Step 3: Complete upload
      const compRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': this._getDeviceId(),
          'X-Device-Name': this._getDeviceName(),
          'X-Platform': this._getPlatform(),
        },
        body: JSON.stringify({ uploadId: task.uploadId }),
      });

      if (!compRes.ok) {
        throw new Error(`Complete chunked upload failed: ${compRes.status}`);
      }

      const compData = await compRes.json();
      if (compData.data?.pending) {
        task.transferId = compData.data.pending.transferId;
        task.status = 'awaiting_approval';
        task.progress = 100;
        task.speed = 0;
        task.speedFormatted = '0 B/s';
        task.etaFormatted = 'Awaiting PC...';
        this._emit('task:awaiting_approval', task);
      } else {
        this._markCompleted(task);
      }

      return task;
    } catch (err) {
      this._markError(task, err.message);
      throw err;
    }
  }

  _uploadChunkWithProgress(task, chunkIndex, chunkBlob) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      task.xhr = xhr;

      xhr.onload = () => {
        task.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Chunk ${chunkIndex} failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => {
        task.xhr = null;
        reject(new Error(`Chunk ${chunkIndex} network error`));
      };

      xhr.onabort = () => {
        task.xhr = null;
        reject(new Error('Chunk upload aborted'));
      };

      const formData = new FormData();
      formData.append('uploadId', task.uploadId);
      formData.append('chunkIndex', String(chunkIndex));
      formData.append('chunk', chunkBlob, `chunk_${chunkIndex}`);

      xhr.open('POST', '/api/upload/chunk');
      xhr.send(formData);
    });
  }

  _updateSpeedAndEta(task, bytesCurrent, bytesTotal) {
    const now = Date.now();
    task.speedSamples.push({ time: now, bytes: bytesCurrent });

    // Keep samples within rolling 5 seconds window
    task.speedSamples = task.speedSamples.filter((s) => now - s.time <= 5000);

    if (task.speedSamples.length >= 2) {
      const oldest = task.speedSamples[0];
      const timeDiff = (now - oldest.time) / 1000;
      const bytesDiff = bytesCurrent - oldest.bytes;

      if (timeDiff > 0.3 && bytesDiff >= 0) {
        task.speed = bytesDiff / timeDiff;
        task.speedFormatted = `${formatFileSize(task.speed)}/s`;

        const bytesRemaining = Math.max(0, bytesTotal - bytesCurrent);
        if (task.speed > 0) {
          task.eta = bytesRemaining / task.speed;
          task.etaFormatted = formatEta(task.eta);
        } else {
          task.etaFormatted = '--';
        }
      }
    }
  }

  pause(taskId) {
    const task = this.activeTransfers.get(taskId);
    if (!task) return;

    if (task.xhr) {
      task.xhr.abort();
      task.xhr = null;
    }
    task.status = 'paused';
    task.speed = 0;
    task.speedFormatted = 'Paused';
    task.etaFormatted = '--';
    this.activeTransfers.delete(taskId);
    this.pausedTransfers.set(taskId, task);
    this._emit('task:paused', task);
    this._emit('queue:updated', this.getStatus());
    this._processQueue();
  }

  async resume(taskId) {
    const task =
      this.pausedTransfers.get(taskId) ||
      this.activeTransfers.get(taskId) ||
      this.queue.find((t) => t.id === taskId) ||
      this.failedTransfers.find((t) => t.id === taskId);

    if (!task) return;
    this.pausedTransfers.delete(taskId);

    task.status = 'queued';
    task.error = null;

    if (task.isChunked && task.uploadId) {
      try {
        const res = await fetch(`/api/upload/status/${task.uploadId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.data?.nextChunk !== null && data.data?.nextChunk !== undefined) {
            task.currentChunk = data.data.nextChunk;
            task.bytesUploaded = task.currentChunk * task.chunkSize;
            task.progress = Math.min(99, Math.round((task.bytesUploaded / task.size) * 100));
          }
        }
      } catch {
        // Continue from current chunk if status check fails
      }
    }

    this.failedTransfers = this.failedTransfers.filter((t) => t.id !== taskId);
    if (!this.queue.some((t) => t.id === taskId)) {
      this.queue.push(task);
    }
    this._emit('task:resumed', task);
    this._emit('queue:updated', this.getStatus());
    this._processQueue();
  }

  cancel(taskId) {
    let task = this.activeTransfers.get(taskId);
    if (task) {
      if (task.xhr) task.xhr.abort();
      this.activeTransfers.delete(taskId);
    } else if (this.pausedTransfers.has(taskId)) {
      task = this.pausedTransfers.get(taskId);
      this.pausedTransfers.delete(taskId);
    } else {
      const qIdx = this.queue.findIndex((t) => t.id === taskId);
      if (qIdx !== -1) {
        task = this.queue.splice(qIdx, 1)[0];
      }
    }

    if (task) {
      task.status = 'cancelled';
      task.speed = 0;
      task.speedFormatted = 'Cancelled';
      this._emit('task:cancelled', task);
      this._emit('queue:updated', this.getStatus());
      this._processQueue();
    }
  }

  retry(taskId) {
    const task = this.failedTransfers.find((t) => t.id === taskId);
    if (!task) return;

    this.failedTransfers = this.failedTransfers.filter((t) => t.id !== taskId);
    task.retries = 0;
    task.status = 'queued';
    task.error = null;
    this.queue.push(task);
    this._emit('queue:updated', this.getStatus());
    this._processQueue();
  }

  /**
   * Matches WebSocket transfer completion / rejection events to pending client tasks.
   * @param {object} eventData
   */
  handleWebSocketEvent(event, data) {
    const { transferId } = data || {};
    if (!transferId) return;

    // Search active or awaiting approval tasks
    for (const task of this.activeTransfers.values()) {
      if (task.transferId === transferId) {
        if (event === 'transfer:complete') {
          this._markCompleted(task);
        } else if (event === 'transfer:rejected') {
          this._markError(task, 'Declined by PC user');
        }
        this.activeTransfers.delete(task.id);
        this._emit('queue:updated', this.getStatus());
        this._processQueue();
        return;
      }
    }
  }

  _markCompleted(task) {
    task.status = 'completed';
    task.progress = 100;
    task.speed = 0;
    task.speedFormatted = 'Complete';
    task.etaFormatted = 'Done';
    task.completedAt = Date.now();
    this.completedTransfers.unshift(task);
    this._emit('task:completed', task);
  }

  _markError(task, errorMessage) {
    task.status = 'error';
    task.error = errorMessage;
    task.speed = 0;
    task.speedFormatted = 'Failed';
    task.etaFormatted = '--';
    this.failedTransfers.unshift(task);
    this._emit('task:error', task);
  }

  getStatus() {
    return {
      active: [
        ...Array.from(this.activeTransfers.values()),
        ...Array.from(this.pausedTransfers.values()),
      ],
      queued: [...this.queue],
      completed: [...this.completedTransfers],
      failed: [...this.failedTransfers],
    };
  }

  clearCompleted() {
    this.completedTransfers = [];
    this._emit('queue:updated', this.getStatus());
  }

  _getDeviceId() {
    let id = localStorage.getItem('utrans_device_id');
    if (!id) {
      id = `dev_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('utrans_device_id', id);
    }
    return id;
  }

  _getDeviceName() {
    let name = localStorage.getItem('utrans_device_name');
    if (!name) {
      const ua = navigator.userAgent;
      if (/Android/i.test(ua)) name = 'Android Phone';
      else if (/iPhone/i.test(ua)) name = 'iPhone';
      else if (/iPad/i.test(ua)) name = 'iPad';
      else if (/Windows/i.test(ua)) name = 'Windows PC';
      else if (/Linux/i.test(ua)) name = 'Linux PC';
      else if (/Mac/i.test(ua)) name = 'Mac Device';
      else name = 'Web Client';
      localStorage.setItem('utrans_device_name', name);
    }
    return name;
  }

  _getPlatform() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad/i.test(ua)) return 'ios';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Linux/i.test(ua)) return 'linux';
    return 'web';
  }
}

export const transferEngine = new TransferEngine();
