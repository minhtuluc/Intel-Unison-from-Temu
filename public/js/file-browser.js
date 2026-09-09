/**
 * File Browser UI Controller
 * Manages shared file rendering in Grid / List modes, search filtering with debounce,
 * category pill filtering, inline image previews, and direct downloads.
 */

import { createElement, getFileSvg, showImagePreviewModal, showToast } from './ui.js';
import { debounce, formatRelativeTime } from './utils.js';

export class FileBrowser {
  constructor(container) {
    this.container = container;
    this.files = [];
    this.filteredFiles = [];
    this.searchQuery = '';
    this.selectedCategory = 'all';
    this.viewMode = localStorage.getItem('utrans_view_mode') || 'grid';
    this.isLoading = false;
  }

  /**
   * Loads shared files from server API.
   */
  async loadFiles() {
    this.isLoading = true;
    this._render();

    try {
      const res = await fetch('/api/shared');
      const json = await res.json();

      if (json.success && json.data) {
        this.files = json.data.files || [];
        this._applyFilter();
      }
    } catch {
      showToast({ type: 'danger', message: 'Failed to fetch shared files' });
    } finally {
      this.isLoading = false;
      this._render();
    }
  }

  /**
   * Sets file list from external event (e.g. WebSocket share:update).
   * @param {object[]} files
   */
  setFiles(files) {
    this.files = files || [];
    this._applyFilter();
    this._render();
  }

  /**
   * Toggles between grid and list view mode.
   * @param {'grid'|'list'} mode
   */
  setViewMode(mode) {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    localStorage.setItem('utrans_view_mode', mode);
    this._render();
  }

  _applyFilter() {
    let result = [...this.files];

    // Filter by category
    if (this.selectedCategory !== 'all') {
      result = result.filter((f) => f.type === this.selectedCategory);
    }

    // Filter by search query
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.trim().toLowerCase();
      result = result.filter((f) => f.name.toLowerCase().includes(q));
    }

    this.filteredFiles = result;
  }

  _render() {
    if (!this.container) return;
    this.container.innerHTML = '';

    // Header & Controls
    const viewHeader = createElement('div', { class: 'view-header' }, [
      createElement('div', {}, [
        createElement('h1', { class: 'view-title' }, 'Shared Files'),
        createElement(
          'p',
          { class: 'view-subtitle' },
          `${this.files.length} ${this.files.length === 1 ? 'file' : 'files'} currently available on WLAN`
        ),
      ]),
    ]);

    // Toolbar (Search, Filter, View Switch)
    const searchInput = createElement('input', {
      type: 'text',
      placeholder: 'Search files by name...',
      value: this.searchQuery,
      oninput: debounce((e) => {
        this.searchQuery = e.target.value;
        this._applyFilter();
        this._renderFileListOnly();
      }, 300),
    });

    const searchBox = createElement('div', { class: 'search-box' }, [
      createElement('span', { class: 'search-box__icon' }, '🔍'),
      searchInput,
    ]);

    const viewSwitch = createElement('div', { class: 'view-switch' }, [
      createElement(
        'button',
        {
          class: `view-switch__btn ${this.viewMode === 'grid' ? 'view-switch__btn--active' : ''}`,
          onclick: () => this.setViewMode('grid'),
          title: 'Grid view',
        },
        '⊞ Grid'
      ),
      createElement(
        'button',
        {
          class: `view-switch__btn ${this.viewMode === 'list' ? 'view-switch__btn--active' : ''}`,
          onclick: () => this.setViewMode('list'),
          title: 'List view',
        },
        '≡ List'
      ),
    ]);

    const toolbar = createElement('div', { class: 'browser-toolbar' }, [searchBox, viewSwitch]);

    // Category Filter Pills
    const categories = [
      { id: 'all', label: 'All Files' },
      { id: 'image', label: 'Images' },
      { id: 'video', label: 'Videos' },
      { id: 'document', label: 'Documents' },
      { id: 'apk', label: 'APKs' },
      { id: 'audio', label: 'Audio' },
      { id: 'archive', label: 'Archives' },
    ];

    const filterTabs = createElement(
      'div',
      { class: 'filter-tabs' },
      categories.map((cat) =>
        createElement(
          'button',
          {
            class: `filter-tab ${this.selectedCategory === cat.id ? 'filter-tab--active' : ''}`,
            onclick: () => {
              this.selectedCategory = cat.id;
              this._applyFilter();
              this._render();
            },
          },
          cat.label
        )
      )
    );

    // Main file list wrapper
    const fileListWrapper = createElement('div', { id: 'file-list-wrapper' });

    this.container.appendChild(viewHeader);
    this.container.appendChild(toolbar);
    this.container.appendChild(filterTabs);
    this.container.appendChild(fileListWrapper);

    this._renderFileListOnly();
  }

  _renderFileListOnly() {
    const wrapper = document.getElementById('file-list-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = '';

    if (this.isLoading) {
      wrapper.appendChild(this._createSkeletonLoading());
      return;
    }

    if (this.filteredFiles.length === 0) {
      wrapper.appendChild(this._createEmptyState());
      return;
    }

    if (this.viewMode === 'grid') {
      const grid = createElement('div', { class: 'files-grid' });
      for (const file of this.filteredFiles) {
        grid.appendChild(this._createFileCard(file));
      }
      wrapper.appendChild(grid);
    } else {
      const list = createElement('div', { class: 'files-list' });
      for (const file of this.filteredFiles) {
        list.appendChild(this._createFileRow(file));
      }
      wrapper.appendChild(list);
    }
  }

  _createFileCard(file) {
    const downloadUrl = `/api/download/${file.id}`;
    const isImage = file.type === 'image';

    const preview = createElement(
      'div',
      {
        class: 'file-card__preview',
        onclick: () => {
          if (isImage) {
            showImagePreviewModal(file.id, file.name);
          }
        },
      },
      [
        isImage
          ? createElement('img', {
              src: downloadUrl,
              alt: file.name,
              class: 'file-card__img',
              loading: 'lazy',
            })
          : createElement('div', { class: 'file-card__icon' }, [getFileSvg(file.type)]),
      ]
    );

    const meta = createElement('div', { class: 'file-card__meta' }, [
      createElement('span', { class: `badge badge--${file.type}` }, file.type),
      createElement('span', { class: 'file-card__sub' }, file.sizeFormatted),
    ]);

    const title = createElement('div', { class: 'file-card__name', title: file.name }, file.name);

    const sub = createElement('div', { class: 'file-card__sub' }, [
      createElement('span', {}, formatRelativeTime(file.sharedAt)),
    ]);

    const downloadBtn = createElement(
      'a',
      {
        href: downloadUrl,
        download: file.name,
        class: 'btn btn--primary btn--sm',
        onclick: (e) => e.stopPropagation(),
      },
      'Download'
    );

    const unstageBtn = createElement(
      'button',
      {
        class: 'btn btn--ghost btn--sm btn--icon',
        title: 'Remove from share',
        onclick: async (e) => {
          e.stopPropagation();
          await this._unstageFile(file.id);
        },
      },
      '✕'
    );

    const actions = createElement('div', { class: 'file-card__actions' }, [
      downloadBtn,
      unstageBtn,
    ]);

    return createElement('div', { class: 'file-card animate-fade-in' }, [
      preview,
      meta,
      title,
      sub,
      actions,
    ]);
  }

  _createFileRow(file) {
    const downloadUrl = `/api/download/${file.id}`;

    const icon = createElement('div', { class: 'file-row__icon' }, [getFileSvg(file.type)]);

    const name = createElement(
      'div',
      {
        class: 'file-row__name',
        title: file.name,
        onclick: () => {
          if (file.type === 'image') showImagePreviewModal(file.id, file.name);
        },
        style: file.type === 'image' ? 'cursor: pointer; color: var(--color-accent);' : '',
      },
      file.name
    );

    const badge = createElement('div', { class: 'file-row__badge' }, [
      createElement('span', { class: `badge badge--${file.type}` }, file.type),
    ]);

    const size = createElement('div', { class: 'file-row__size' }, file.sizeFormatted);

    const downloadBtn = createElement(
      'a',
      {
        href: downloadUrl,
        download: file.name,
        class: 'btn btn--primary btn--sm',
      },
      'Download'
    );

    const unstageBtn = createElement(
      'button',
      {
        class: 'btn btn--ghost btn--sm btn--icon',
        title: 'Remove from share',
        onclick: async () => await this._unstageFile(file.id),
      },
      '✕'
    );

    const actions = createElement('div', { class: 'file-row__actions' }, [downloadBtn, unstageBtn]);

    return createElement('div', { class: 'file-row animate-fade-in' }, [
      icon,
      name,
      badge,
      size,
      actions,
    ]);
  }

  _createSkeletonLoading() {
    const grid = createElement('div', { class: 'files-grid' });
    for (let i = 0; i < 4; i++) {
      grid.appendChild(createElement('div', { class: 'skeleton-card skeleton-shimmer' }));
    }
    return grid;
  }

  _createEmptyState() {
    const icon = createElement('div', { class: 'empty-state__icon' }, [getFileSvg('other')]);
    const title = createElement('h3', { class: 'empty-state__title' }, 'No files shared yet');
    const desc = createElement(
      'p',
      { class: 'empty-state__desc' },
      this.searchQuery
        ? 'No shared files match your search criteria.'
        : 'On PC: Drag and drop files onto the app window or use "utrans <file>". On Mobile: Tap "Upload" below to send files.'
    );

    return createElement('div', { class: 'empty-state animate-fade-in' }, [icon, title, desc]);
  }

  async _unstageFile(fileId) {
    try {
      const res = await fetch(`/api/share/${fileId}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        showToast({ type: 'success', message: 'File removed from shared list' });
        this.files = this.files.filter((f) => f.id !== fileId);
        this._applyFilter();
        this._renderFileListOnly();
      } else {
        showToast({ type: 'danger', message: json.error?.message || 'Failed to remove file' });
      }
    } catch {
      showToast({ type: 'danger', message: 'Error removing file from sharing' });
    }
  }
}
