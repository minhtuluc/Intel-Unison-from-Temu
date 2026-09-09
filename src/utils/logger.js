/**
 * Structured Console Logger
 * Provides level-based logging with timestamps and data masking.
 * Follows security rules: Never logs full paths, passwords, or raw file contents.
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  constructor(currentLevel = 'info') {
    this.currentLevel = currentLevel;
  }

  setLevel(level) {
    if (level in LOG_LEVELS) {
      this.currentLevel = level;
    }
  }

  _shouldLog(level) {
    return LOG_LEVELS[level] >= (LOG_LEVELS[this.currentLevel] ?? LOG_LEVELS.info);
  }

  _format(level, message, data) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

    if (data && Object.keys(data).length > 0) {
      const sanitizedData = this._sanitize(data);
      return `${prefix} ${message} ${JSON.stringify(sanitizedData)}`;
    }
    return `${prefix} ${message}`;
  }

  _sanitize(data) {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    const sanitized = Array.isArray(data) ? [] : {};
    for (const [key, value] of Object.entries(data)) {
      if (['pin', 'password', 'token', 'authorization'].includes(key.toLowerCase())) {
        sanitized[key] = '***REDACTED***';
      } else if (
        ['path', 'filepath', 'absolutepath', 'fullpath'].includes(key.toLowerCase()) &&
        typeof value === 'string'
      ) {
        // Redact full path to basename to prevent leaking filesystem structure in logs
        sanitized[key] = value.split(/[\\/]/).pop() || value;
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this._sanitize(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  debug(message, data) {
    if (this._shouldLog('debug')) {
      console.debug(this._format('debug', message, data));
    }
  }

  info(message, data) {
    if (this._shouldLog('info')) {
      console.info(this._format('info', message, data));
    }
  }

  warn(message, data) {
    if (this._shouldLog('warn')) {
      console.warn(this._format('warn', message, data));
    }
  }

  error(message, data) {
    if (this._shouldLog('error')) {
      console.error(this._format('error', message, data));
    }
  }
}

export const logger = new Logger();
