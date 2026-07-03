'use strict';

const path = require('path');

/**
 * Make Thick mode "just work" on Linux/macOS.
 *
 * Thick mode needs the OS dynamic loader to find the Oracle Instant Client
 * libraries. That search path is fixed when the process starts and cannot be
 * changed from inside Node, so if it does not already include the client
 * directory we re-exec this process ONCE with the correct library-path variable
 * set. The result: `npm start` works in Thick mode without a separate launcher.
 *
 * Windows loads the DLLs from EBS_CLIENT_LIB_DIR directly, so this is a no-op
 * there. Must be called before oracledb is loaded.
 */
function ensureClientLibraryPath(config) {
  if (process.platform === 'win32') return;
  if (!config.db.thick || !config.db.clientLibDir) return;
  if (process.env.__EBS_RELAUNCHED === '1') return; // guard against relaunch loop

  const varName = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
  const libDir = path.resolve(config.db.clientLibDir);
  const current = process.env[varName] || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(libDir)) return; // already on the path

  const { spawnSync } = require('child_process');
  const env = {
    ...process.env,
    [varName]: [libDir, current].filter(Boolean).join(path.delimiter),
    __EBS_RELAUNCHED: '1',
  };
  const result = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env });
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { ensureClientLibraryPath };
