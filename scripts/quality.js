import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'utrans-quality-'));
let failed = false;
try {
  const tests = [];
  for (const group of ['unit', 'integration']) {
    const directory = path.join(root, 'tests', group);
    for (const file of (await fs.readdir(directory)).sort()) {
      if (file.endsWith('.test.js')) tests.push(path.join(directory, file));
    }
  }
  const checks = [
    [
      'Lint',
      [
        'node_modules/eslint/bin/eslint.js',
        'src/',
        'tests/',
        'bin/',
        'public/js/',
        'public/sw.js',
        'scripts/quality.js',
      ],
    ],
    [
      'Format',
      [
        'node_modules/prettier/bin/prettier.cjs',
        '--check',
        'src/',
        'tests/',
        'bin/',
        'public/js/',
        'public/sw.js',
        'scripts/quality.js',
        'AGENTS.md',
        'CONTEXT.md',
        'REPORT-ROADMAP.md',
        'docs/',
        '.github/',
      ],
    ],
    [
      'Tests and coverage',
      [
        '--test',
        '--test-timeout=30000',
        '--experimental-test-coverage',
        '--test-coverage-lines=80',
        '--test-coverage-branches=65',
        '--test-coverage-functions=75',
        ...tests,
      ],
    ],
  ];
  for (const [name, args] of checks) {
    console.log(`Quality gate: ${name}`);
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        UTRANS_UPLOAD_DIR: path.join(sandbox, 'received'),
        UTRANS_TEMP_DIR: path.join(sandbox, 'temp'),
        // Trusted-device and history stores are durable, so they must point at the
        // sandbox too — never the developer's real home directory.
        UTRANS_DATA_DIR: path.join(sandbox, 'data'),
        UTRANS_AUTO_OPEN: 'false',
        UTRANS_PIN: '',
      },
    });
    if (result.error || result.status !== 0) {
      failed = true;
      console.error(`${name} failed`, result.error?.message || `exit ${result.status}`);
      break;
    }
  }
} finally {
  // Only remove the unique directory created by this invocation.
  await fs.rm(sandbox, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
