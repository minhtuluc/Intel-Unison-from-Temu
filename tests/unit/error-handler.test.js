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

  it('delegates to next(err) if headers have already been sent to avoid double-send crash', () => {
    const error = new Error('Stream error after headers');
    let nextCalledWith = null;
    let statusCalled = false;

    const mockRes = {
      headersSent: true,
      status() {
        statusCalled = true;
        return this;
      },
      json() {},
    };

    errorHandler(error, { originalUrl: '/api/download/123' }, mockRes, (err) => {
      nextCalledWith = err;
    });

    assert.equal(nextCalledWith, error);
    assert.equal(statusCalled, false);
  });

  it('maps body-parser JSON syntax error to 400 INVALID_JSON', () => {
    const syntaxErr = new SyntaxError('Unexpected token } in JSON at position 12');
    syntaxErr.status = 400;

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

    errorHandler(syntaxErr, { originalUrl: '/api/share' }, mockRes, () => {});

    assert.equal(responseStatus, 400);
    assert.equal(responseBody.success, false);
    assert.equal(responseBody.error.code, 'INVALID_JSON');
    assert.equal(responseBody.error.message, 'Malformed JSON body in request');
  });

  it('maps Multer LIMIT_FILE_SIZE to 413 FILE_TOO_LARGE', () => {
    const multerErr = new Error('File too large');
    multerErr.name = 'MulterError';
    multerErr.code = 'LIMIT_FILE_SIZE';

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

    errorHandler(multerErr, { originalUrl: '/api/upload' }, mockRes, () => {});

    assert.equal(responseStatus, 413);
    assert.equal(responseBody.success, false);
    assert.equal(responseBody.error.code, 'FILE_TOO_LARGE');
  });

  it('maps other Multer errors to 400 UNEXPECTED_FIELD or MULTIPART_ERROR', () => {
    const unexpectedErr = new Error('Unexpected field');
    unexpectedErr.name = 'MulterError';
    unexpectedErr.code = 'LIMIT_UNEXPECTED_FILE';

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

    errorHandler(unexpectedErr, { originalUrl: '/api/upload' }, mockRes, () => {});

    assert.equal(responseStatus, 400);
    assert.equal(responseBody.error.code, 'UNEXPECTED_FIELD');

    const genericMulterErr = new Error('Too many parts');
    genericMulterErr.name = 'MulterError';
    genericMulterErr.code = 'LIMIT_PART_COUNT';

    errorHandler(genericMulterErr, { originalUrl: '/api/upload' }, mockRes, () => {});
    assert.equal(responseStatus, 400);
    assert.equal(responseBody.error.code, 'MULTIPART_ERROR');
  });

  it('maps entity.too.large error to 413 PAYLOAD_TOO_LARGE', () => {
    const payloadErr = new Error('request entity too large');
    payloadErr.status = 413;

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

    errorHandler(payloadErr, { originalUrl: '/api/upload' }, mockRes, () => {});

    assert.equal(responseStatus, 413);
    assert.equal(responseBody.error.code, 'PAYLOAD_TOO_LARGE');
  });
});
