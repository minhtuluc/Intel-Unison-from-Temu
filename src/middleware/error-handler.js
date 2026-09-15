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
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  let isOperational = err instanceof AppError && err.isOperational;
  let statusCode = isOperational ? err.statusCode : 500;
  let code = isOperational ? err.code : 'SERVER_ERROR';
  let message = isOperational ? err.message : 'Internal Server Error';
  const details = isOperational ? err.details : {};

  // Map known client parsing / transport errors to structured operational errors
  if (!isOperational) {
    if (err instanceof SyntaxError && (err.status === 400 || err.type === 'entity.parse.failed')) {
      isOperational = true;
      statusCode = 400;
      code = 'INVALID_JSON';
      message = 'Malformed JSON body in request';
    } else if (err.name === 'MulterError') {
      isOperational = true;
      if (err.code === 'LIMIT_FILE_SIZE') {
        statusCode = 413;
        code = 'FILE_TOO_LARGE';
        message = err.message || 'File exceeds maximum allowed size';
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        statusCode = 400;
        code = 'UNEXPECTED_FIELD';
        message = err.message || 'Unexpected field in upload';
      } else {
        statusCode = 400;
        code = 'MULTIPART_ERROR';
        message = err.message || 'Invalid multipart upload';
      }
    } else if (err.status === 413 || err.type === 'entity.too.large') {
      isOperational = true;
      statusCode = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Payload exceeds maximum allowed size';
    }
  }

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
