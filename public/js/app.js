/**
 * UniversalTrans Client Application Entry
 */

import { initConnection } from './connection.js';

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('connection-status');
  initConnection({
    onStatusChange: (status) => {
      if (statusEl) statusEl.textContent = status;
    },
  });
});
