#!/usr/bin/env node

/**
 * UniversalTrans CLI Entry Point
 * Command-line interface for starting the UniversalTrans server and sharing files/folders.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { logger } from '../src/utils/logger.js';

function printHelp() {
  console.log(`
UniversalTrans — AirDrop-style bidirectional file transfer over local WLAN

Usage:
  utrans [options] [files/folders...]

Options:
  -p, --port <number>    Set server port (default: 8080)
  -v, --version          Show version number
  -h, --help             Show this help message

Examples:
  utrans                         Start server and open web UI
  utrans photo.jpg video.mp4     Start server and immediately share files
  utrans /path/to/folder/        Start server and share all files in folder
  utrans -p 8080                 Start server on port 8080
`);
}

function printVersion() {
  try {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(dirname, '..', 'package.json'), 'utf8'));
    console.log(`universaltrans v${pkg.version}`);
  } catch {
    console.log('universaltrans v1.0.0');
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('-v') || args.includes('--version')) {
    printVersion();
    process.exit(0);
  }

  let port;
  const files = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-p' || args[i] === '--port') && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else {
      files.push(args[i]);
    }
  }

  try {
    await startServer({ initialPaths: files, port });
  } catch (error) {
    logger.error('Failed to start UniversalTrans', { error: error.message });
    process.exit(1);
  }
}

main();
