/**
 * WebSocket Connection Manager
 */

export function initConnection({ onStatusChange }) {
  if (onStatusChange) onStatusChange('Ready');
}
