/**
 * HTTP Request Logging Middleware
 * Logs incoming requests without exposing sensitive paths or credentials.
 */

import { logger } from '../utils/logger.js';

export function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, url, ip } = req;

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${method} ${url} ${res.statusCode} - ${duration}ms`, {
      ip,
      statusCode: res.statusCode,
      duration,
    });
  });

  next();
}
