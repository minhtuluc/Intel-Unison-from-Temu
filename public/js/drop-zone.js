/**
 * UniversalTrans PC Drop Zone Controller
 * Enables dragging & dropping files and folders recursively into the browser,
 * as well as pasting clipboard images (Ctrl+V) directly into the shared staging area.
 */

import { showToast } from './ui.js';

export class DropZone {
  constructor(targetElement = document.body, onFilesShared = null) {
    this.target = targetElement;
    this.onFilesShared = onFilesShared;
    this.dragCounter = 0;
    this.overlay = null;

    this._initOverlay();
    this._bindDragEvents();
    this._bindPasteEvents();
  }

  _initOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'drop-overlay';
    this.overlay.innerHTML = `
      <div class="drop-overlay__content">
        <div class="drop-overlay__icon">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
        </div>
        <h2 class="drop-overlay__title">Drop Files or Folders Here</h2>
        <p class="drop-overlay__subtitle">Files will be instantly shared across your local Wi-Fi</p>
      </div>
    `;
    document.body.appendChild(this.overlay);
  }

  _bindDragEvents() {
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      this.dragCounter++;
      if (this.dragCounter === 1) {
        this.overlay.classList.add('drop-overlay--active');
      }
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      this.dragCounter--;
      if (this.dragCounter <= 0) {
        this.dragCounter = 0;
        this.overlay.classList.remove('drop-overlay--active');
      }
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.dragCounter = 0;
      this.overlay.classList.remove('drop-overlay--active');

      const files = await this._extractFilesFromDataTransfer(e.dataTransfer);
      if (files.length > 0) {
        await this._shareFiles(files);
      }
    });
  }

  _bindPasteEvents() {
    window.addEventListener('paste', async (e) => {
      // Avoid intercepting paste inside text inputs or textareas
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') return;

      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const ext = file.type.split('/')[1] || 'png';
            const renamedFile = new File(
              [file],
              `clipboard_image_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`,
              { type: file.type }
            );
            pastedFiles.push(renamedFile);
          }
        }
      }

      if (pastedFiles.length > 0) {
        showToast('Pasting image from clipboard...', 'info');
        await this._shareFiles(pastedFiles);
      }
    });
  }

  /**
   * Recursively traverses DataTransferItemList including nested folders.
   */
  async _extractFilesFromDataTransfer(dataTransfer) {
    const files = [];
    const items = dataTransfer.items;

    if (!items || items.length === 0) {
      // Fallback for browsers lacking DataTransferItemList
      return Array.from(dataTransfer.files || []);
    }

    const queue = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) {
          queue.push(this._traverseEntry(entry));
        } else {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }

    const results = await Promise.all(queue);
    for (const res of results) {
      if (Array.isArray(res)) {
        files.push(...res);
      } else if (res) {
        files.push(res);
      }
    }

    return files;
  }

  async _traverseEntry(entry) {
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file(
          (file) => resolve(file),
          () => resolve(null)
        );
      });
    }

    if (entry.isDirectory) {
      const reader = entry.createReader();
      const dirFiles = [];

      const readBatch = () => {
        return new Promise((resolve) => {
          reader.readEntries(
            async (entries) => {
              if (entries.length === 0) {
                return resolve(dirFiles);
              }
              for (const childEntry of entries) {
                const childResult = await this._traverseEntry(childEntry);
                if (Array.isArray(childResult)) {
                  dirFiles.push(...childResult);
                } else if (childResult) {
                  dirFiles.push(childResult);
                }
              }
              const nextBatch = await readBatch();
              resolve(nextBatch);
            },
            () => resolve(dirFiles)
          );
        });
      };

      return readBatch();
    }

    return null;
  }

  async _shareFiles(files) {
    try {
      showToast(`Staging ${files.length} file(s) for sharing...`, 'info');

      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }

      const res = await fetch('/api/share', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `Server returned ${res.status}`);
      }

      const data = await res.json();
      const count = data.data?.shared?.length || files.length;
      showToast(`Shared ${count} file(s) successfully!`, 'success');

      if (this.onFilesShared) {
        this.onFilesShared(data.data?.shared);
      }
    } catch (err) {
      showToast(`Failed to share files: ${err.message}`, 'danger');
    }
  }
}
