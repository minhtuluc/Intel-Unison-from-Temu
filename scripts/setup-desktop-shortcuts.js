/**
 * UniversalTrans — Create Desktop Shortcuts for Windows
 * Invokes scripts/setup-desktop-shortcuts.ps1 via PowerShell
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const psScript = path.join(__dirname, 'setup-desktop-shortcuts.ps1');

try {
  const output = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, {
    encoding: 'utf8',
  });
  console.log(output.trim());
} catch (err) {
  console.error('Loi khi tao shortcut:', err.message);
  process.exit(1);
}
