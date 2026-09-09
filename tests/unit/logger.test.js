import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../src/utils/logger.js';

describe('Structured Logger', () => {
  let originalDebug, originalInfo, originalWarn, originalError;
  let loggedMessages = [];

  beforeEach(() => {
    loggedMessages = [];
    originalDebug = console.debug;
    originalInfo = console.info;
    originalWarn = console.warn;
    originalError = console.error;

    console.debug = (msg) => loggedMessages.push({ level: 'debug', msg });
    console.info = (msg) => loggedMessages.push({ level: 'info', msg });
    console.warn = (msg) => loggedMessages.push({ level: 'warn', msg });
    console.error = (msg) => loggedMessages.push({ level: 'error', msg });
  });

  afterEach(() => {
    console.debug = originalDebug;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
    logger.setLevel('info');
  });

  it('should log info, warn, and error at default info level', () => {
    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    assert.equal(loggedMessages.length, 3);
    assert.equal(loggedMessages[0].level, 'info');
    assert.equal(loggedMessages[1].level, 'warn');
    assert.equal(loggedMessages[2].level, 'error');
  });

  it('should log debug messages when level is set to debug', () => {
    logger.setLevel('debug');
    logger.debug('debug trace', { step: 1 });

    assert.equal(loggedMessages.length, 1);
    assert.equal(loggedMessages[0].level, 'debug');
    assert.ok(loggedMessages[0].msg.includes('[DEBUG]'));
    assert.ok(loggedMessages[0].msg.includes('"step":1'));
  });

  it('should filter messages lower than configured level', () => {
    logger.setLevel('error');
    logger.info('should not appear');
    logger.warn('should not appear');
    logger.error('only error appears');

    assert.equal(loggedMessages.length, 1);
    assert.equal(loggedMessages[0].level, 'error');
  });

  it('should redact sensitive PIN and password fields', () => {
    logger.info('Authentication attempt', { pin: '1234', password: 'secret', token: 'xyz' });

    assert.equal(loggedMessages.length, 1);
    assert.ok(loggedMessages[0].msg.includes('***REDACTED***'));
    assert.equal(loggedMessages[0].msg.includes('1234'), false);
    assert.equal(loggedMessages[0].msg.includes('secret'), false);
  });

  it('should redact full file paths to basenames only', () => {
    logger.info('Sharing file', {
      filePath: 'C:\\Users\\admin\\SecretDocs\\private_report.pdf',
      nested: { fullPath: '/home/user/photos/vacation.jpg' },
    });

    assert.equal(loggedMessages.length, 1);
    assert.ok(loggedMessages[0].msg.includes('private_report.pdf'));
    assert.ok(loggedMessages[0].msg.includes('vacation.jpg'));
    assert.equal(loggedMessages[0].msg.includes('SecretDocs'), false);
    assert.equal(loggedMessages[0].msg.includes('/home/user/photos'), false);
  });
});
