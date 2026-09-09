/**
 * UniversalTrans Centralized Error Handler
 * Custom operational error class and Express error boundary middleware.
 */

import { logger } from '../utils/logger.js';

export class AppError extends Error {
  /**
   * @param {string} code - Machine-readable error code (e.g. 'FILE_NOT_FOUND')
   * @param {number} statusCode - HTTP status code
   * @param {string} message - Human-readable error message
   * @param {object} [details={}] - Additional metadata or context
   */
  constructor(code, statusCode, message, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Express error handling middleware.
 * Formats all errors into standard JSON API response.
 */
export function errorHandler(err, req, res, _next) {
  const isOperational = err instanceof AppError && err.isOperational;
  const statusCode = isOperational ? err.statusCode : 500;
  const code = isOperational ? err.code : 'SERVER_ERROR';
  const message = isOperational ? err.message : 'Internal Server Error';
  const details = isOperational ? err.details : {};

  if (!isOperational) {
    logger.error('Unhandled server error', {
      error: err.message,
      stack: err.stack,
      url: req.originalUrl,
      method: req.method,
    });
  } else {
    logger.warn('Operational error occurred', {
      code,
      statusCode,
      message,
      url: req.originalUrl,
    });
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    },
  });
}
