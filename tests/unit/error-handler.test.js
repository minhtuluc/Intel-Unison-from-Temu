import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, errorHandler } from '../../src/middleware/error-handler.js';

describe('Error Handler & AppError', () => {
  it('should create AppError with expected operational properties', () => {
    const error = new AppError('FILE_NOT_FOUND', 404, 'The requested file was not found', {
      fileId: 'f_123',
    });

    assert.equal(error.name, 'AppError');
    assert.equal(error.code, 'FILE_NOT_FOUND');
    assert.equal(error.statusCode, 404);
    assert.equal(error.message, 'The requested file was not found');
    assert.deepEqual(error.details, { fileId: 'f_123' });
    assert.equal(error.isOperational, true);
  });

  it('should format AppError into structured JSON response', () => {
    const appError = new AppError('ACCESS_DENIED', 403, 'Permission denied', {
      path: '/etc/passwd',
    });

    let responseStatus = 0;
    let responseBody = null;

    const mockRes = {
      status(code) {
        responseStatus = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };

    const mockReq = { originalUrl: '/api/download', method: 'GET' };

    errorHandler(appError, mockReq, mockRes, () => {});

    assert.equal(responseStatus, 403);
    assert.equal(responseBody.success, false);
    assert.equal(responseBody.error.code, 'ACCESS_DENIED');
    assert.equal(responseBody.error.message, 'Permission denied');
    assert.deepEqual(responseBody.error.details, { path: '/etc/passwd' });
  });

  it('should handle unhandled programming errors as 500 SERVER_ERROR', () => {
    const genericError = new TypeError('Cannot read property of undefined');

    let responseStatus = 0;
    let responseBody = null;

    const mockRes = {
      status(code) {
        responseStatus = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };

    const mockReq = { originalUrl: '/api/upload', method: 'POST' };

    errorHandler(genericError, mockReq, mockRes, () => {});

    assert.equal(responseStatus, 500);
    assert.equal(responseBody.success, false);
    assert.equal(responseBody.error.code, 'SERVER_ERROR');
    assert.equal(responseBody.error.message, 'Internal Server Error');
  });
});
