/**
 * Relay routes (UT-021) — client A sends a file to client B through the host.
 *
 * The authority here is the receiver. The host may list what is in flight and cancel it,
 * but it can neither decide nor download: `POST /api/relay/decision` accepts only the
 * identity keys bound to the relay's receiver, with no host bypass.
 */

import { Router } from 'express';
import { AppError } from '../middleware/error-handler.js';
import { requireHost } from '../middleware/host-auth.js';
import { resolveSender } from '../utils/connection-identity.js';
import { identityKeysFromRequest, intersects } from '../utils/client-identity.js';
import { sendToIdentity, broadcastEvent } from '../websocket/handlers.js';

export const relayRouter = Router();

/**
 * Identity keys of the live socket that currently serves a device. A device that is not
 * connected cannot receive a relay offer, so this is also the online check.
 * @param {object} runtime
 * @param {object} wss
 * @param {string} deviceId
 * @returns {{ device: object, keys: string[] }|null}
 */
function liveReceiverIdentity(runtime, wss, deviceId) {
  const device = runtime.discovery.getDevice(deviceId);
  if (!device || !wss) return null;
  for (const client of wss.clients) {
    if (client.connectionId !== device.connectionId) continue;
    const keys = Array.isArray(client.identityKeys) ? [...client.identityKeys] : [];
    if (keys.length === 0) return null;
    return { device, keys };
  }
  return null;
}

/** Sender-side actor descriptor: connection plus the durable keys it presents. */
function senderActor(req, sender) {
  return { ...sender, keys: identityKeysFromRequest(req).keys };
}

/** The actor's identity keys, as verified from the request. */
function actorKeys(req) {
  return identityKeysFromRequest(req).keys;
}

function isHostRequest(req) {
  const hostAuth = req.app.locals.hostAuth || req.app.locals.runtime?.hostAuth;
  return Boolean(hostAuth?.verify(req, req.headers['x-host-token']));
}

/**
 * Readback of a relay's decisions, so a sender that missed the WebSocket event can still
 * collect the grants it was allowed to spend. Download capabilities are never included:
 * those belong to the receiver alone and are handed out only in the decision response.
 * @param {object} relay
 */
function relayDecisionPayload(relay) {
  return {
    relayId: relay.relayId,
    state: relay.state,
    decisions: relay.files.map((file) => ({
      index: file.index,
      name: file.name,
      size: file.size,
      decision: file.decision,
      grantId: file.grantId || null,
    })),
  };
}

/**
 * POST /api/relay/offer
 * Declares a batch the sender wants delivered to one specific device. Metadata only —
 * no byte moves until the receiver accepts.
 */
relayRouter.post('/api/relay/offer', (req, res, next) => {
  try {
    const runtime = req.app.locals.runtime;
    const sender = resolveSender(req, { required: true });
    const receiverDeviceId = req.body?.receiverDeviceId;
    if (typeof receiverDeviceId !== 'string' || receiverDeviceId.length === 0) {
      throw new AppError('INVALID_INPUT', 400, 'receiverDeviceId is required');
    }

    const wss = req.app.get('wss');
    const live = liveReceiverIdentity(runtime, wss, receiverDeviceId);
    if (!live) {
      throw new AppError(
        'RECEIVER_OFFLINE',
        409,
        'The selected receiver is not connected right now'
      );
    }

    const actor = senderActor(req, sender);
    // A device cannot relay to itself: the receiver would be its own sender.
    if (
      (sender.connectionId && sender.connectionId === live.device.connectionId) ||
      intersects(actor.keys, live.keys)
    ) {
      throw new AppError('RELAY_SELF', 400, 'Cannot relay a transfer to this device itself');
    }

    const { relay } = runtime.relayService.createOffer({
      files: req.body?.files,
      sender: actor,
      receiver: {
        keys: live.keys,
        deviceId: live.device.id,
        label: live.device.label,
        platform: live.device.platform,
      },
    });

    const sanitized = runtime.relayService.sanitize(relay);
    if (wss) {
      // Only the receiver sees the offer. The host gets a metadata refresh for its
      // management list — it is not asked to decide anything.
      sendToIdentity(wss, relay.receiver.keys, 'relay:offer', { relay: sanitized });
      broadcastEvent(wss, 'relay:update', { relay: sanitized }, (client) => Boolean(client.isHost));
    }

    res.status(201).json({ success: true, data: { relay: sanitized } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/relay/offer/:relayId
 * Readback for the sender, the receiver, or the host (each within its own remit).
 */
relayRouter.get('/api/relay/offer/:relayId', (req, res, next) => {
  try {
    const runtime = req.app.locals.runtime;
    const relay = runtime.relayService.getRelay(req.params.relayId);
    if (!relay) {
      throw new AppError('RELAY_NOT_FOUND', 404, `Relay ${req.params.relayId} not found`);
    }

    if (!isHostRequest(req)) {
      const keys = actorKeys(req);
      const isReceiver = intersects(keys, relay.receiver.keys);

      // The receiver is recognized by the identity keys bound when the offer was created.
      // The sender is recognized the same way, or — for a client that presents no durable
      // key — by verifying its connection against the live socket, its IP and its session,
      // exactly like the write paths do. A claimed `X-Connection-Id` on its own is not
      // authority (M4-QC-02).
      let isSender = intersects(keys, relay.sender?.keys || []);
      if (!isSender) {
        const verified = resolveSender(req, { required: true });
        isSender = Boolean(
          verified.connectionId && relay.sender?.connectionId === verified.connectionId
        );
      }

      if (!isReceiver && !isSender) {
        throw new AppError('RELAY_FORBIDDEN', 403, 'Relay belongs to another peer');
      }
    }

    res.json({
      success: true,
      data: { relay: runtime.relayService.sanitize(relay), ...relayDecisionPayload(relay) },
    });
  } catch (error) {
    next(error);
  }
});

/** POST /api/relay/offer/cancel — the sender abandons its own relay; the host may stop it. */
relayRouter.post('/api/relay/offer/cancel', (req, res, next) => {
  try {
    const { relayId } = req.body || {};
    if (!relayId) {
      throw new AppError('INVALID_INPUT', 400, 'relayId is required');
    }
    const isHost = isHostRequest(req);
    const runtime = req.app.locals.runtime;
    const sender = isHost ? { connectionId: null } : resolveSender(req, { required: true });
    const canceled = runtime.relayService.cancelOffer(relayId, {
      ...senderActor(req, sender),
      isHost,
    });
    res.json({ success: true, data: { relay: canceled } });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/relay/decision
 * The receiver accepts or declines individual files. Accepting issues the single-use
 * grants the sender will spend, plus a per-file download capability returned exactly once.
 */
relayRouter.post('/api/relay/decision', (req, res, next) => {
  try {
    const { relayId, decisions } = req.body || {};
    if (!relayId) {
      throw new AppError('INVALID_INPUT', 400, 'relayId is required');
    }

    const runtime = req.app.locals.runtime;
    const result = runtime.relayService.decide(relayId, decisions, { keys: actorKeys(req) });

    const wss = req.app.get('wss');

    // Two DTOs on purpose (M4-QC-01). The download capability is the receiver's alone: it
    // travels in the receiver's HTTP response exactly once and is never broadcast, so the
    // event the sender receives carries only what it needs to upload.
    const decisionSummary = result.decisions.map((decision) => ({
      index: decision.index,
      decision: decision.decision,
      grantId: decision.grantId,
    }));

    if (wss) {
      sendToIdentity(wss, result.relay.sender?.keys || [], 'relay:decision', {
        relayId,
        decisions: decisionSummary,
        files: decisionSummary,
      });
      const sanitized = runtime.relayService.sanitize(result.relay);
      broadcastEvent(wss, 'relay:update', { relay: sanitized }, (client) => Boolean(client.isHost));
    }

    res.json({
      success: true,
      data: {
        relayId,
        decisions: decisionSummary,
        files: result.decisions.map((decision) => ({
          ...decision,
          relayToken: result.tokens[decision.index] || null,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/relay/incoming — stored relay files addressed to the caller. */
relayRouter.get('/api/relay/incoming', (req, res) => {
  const runtime = req.app.locals.runtime;
  res.json({
    success: true,
    data: { files: runtime.relayService.listStoredFor(actorKeys(req)) },
  });
});

/** GET /api/relay/sent — relays the caller created, with their current state. */
relayRouter.get('/api/relay/sent', (req, res, next) => {
  try {
    const sender = resolveSender(req, { required: true });
    const runtime = req.app.locals.runtime;
    res.json({
      success: true,
      data: { relays: runtime.relayService.listSentFor(senderActor(req, sender)) },
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/relay/active — host management view (metadata only, no download handle). */
relayRouter.get('/api/relay/active', requireHost, (req, res) => {
  res.json({ success: true, data: req.app.locals.runtime.relayService.listActive() });
});

/**
 * POST /api/relay/revoke — host stops a relay and/or deletes what it left on disk.
 * The host can remove relayed bytes; the app offers it no way to read them. That is an
 * authorization boundary inside the app, not encryption: the machine's owner still has
 * the plaintext in the relay staging area.
 */
relayRouter.post('/api/relay/revoke', requireHost, (req, res, next) => {
  try {
    const { relayId, fileId } = req.body || {};
    if (!relayId && !fileId) {
      throw new AppError('INVALID_INPUT', 400, 'relayId or fileId is required');
    }
    const service = req.app.locals.runtime.relayService;
    const removed = fileId ? (service.revokeFile(fileId) ? 1 : 0) : service.revokeRelay(relayId);
    res.json({
      success: true,
      data: { relayId: relayId || null, fileId: fileId || null, removed },
    });
  } catch (error) {
    next(error);
  }
});
