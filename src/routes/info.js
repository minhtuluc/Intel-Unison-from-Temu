/**
 * System and server information routes
 * Provides LAN IP, port, server name, QR code, and connected devices count.
 */

import { Router } from 'express';
import os from 'node:os';
import { config } from '../config.js';
import { getLanIp } from '../utils/network.js';

export const infoRouter = Router();

// GET /api/info
infoRouter.get('/api/info', (_req, res) => {
  const ip = getLanIp() || '127.0.0.1';
  res.json({
    success: true,
    data: {
      serverName: os.hostname(),
      platform: process.platform,
      version: '1.0.0',
      ip,
      port: config.port,
      qrCode: '',
      connectedDevices: 0,
      uptime: Math.floor(process.uptime()),
    },
  });
});
