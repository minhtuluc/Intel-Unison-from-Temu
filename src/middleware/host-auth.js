import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './error-handler.js';

const normalize = (ip = '') => ip.replace(/^::ffff:/, '');

// Authority comes from a per-process secret delivered to the local browser by the CLI.
// Device names, platform, Host/X-Forwarded-For headers and client isHost are not identity.
export function createHostAuth() {
  const token = randomBytes(32).toString('hex');
  function verify(req, candidate) {
    const remote = normalize(req.socket.remoteAddress);
    const local = normalize(req.socket.localAddress);
    const onHost = remote === '127.0.0.1' || remote === '::1' || (remote && remote === local);
    if (!onHost || typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) {
      return false;
    }
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return false;
      } catch {
        return false;
      }
    }
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
  }
  return { token, verify };
}

export function requireHost(req, _res, next) {
  if (!req.app.locals.hostAuth.verify(req, req.headers['x-host-token'])) {
    return next(new AppError('HOST_REQUIRED', 403, 'Only the host can approve incoming files'));
  }
  next();
}
