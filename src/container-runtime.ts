/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** The Docker network for agent ↔ proxy isolation. */
export const CONTAINER_NETWORK = 'nanoclaw-net';

/** The copilot-api proxy container name. */
const PROXY_CONTAINER_NAME = 'copilot-api';

/** The MCP services container name. */
const MCP_SERVICES_CONTAINER_NAME = 'mcp-services';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Create the isolated Docker network (idempotent). */
function ensureNetwork(): void {
  try {
    execSync(
      `${CONTAINER_RUNTIME_BIN} network create ${CONTAINER_NETWORK} 2>/dev/null || true`,
      { stdio: 'pipe', timeout: 10000 },
    );
    logger.debug({ network: CONTAINER_NETWORK }, 'Container network ready');
  } catch (err) {
    logger.warn({ err }, 'Failed to create container network');
  }
}

/** Ensure the copilot-api proxy container is running on nanoclaw-net. */
function ensureProxyRunning(): void {
  try {
    const status = execSync(
      `${CONTAINER_RUNTIME_BIN} inspect -f '{{.State.Running}}' ${PROXY_CONTAINER_NAME} 2>/dev/null || echo "false"`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
    ).trim();

    if (status === 'true') {
      logger.debug('copilot-api proxy container already running');
      return;
    }

    throw new Error('copilot-api container is not running');
  } catch (err) {
    logger.error({ err }, 'copilot-api proxy container is not running');
    throw new Error(
      'copilot-api proxy container is required but not running. ' +
        'Start it with: sudo systemctl start copilot-api',
    );
  }
}

/** Ensure the mcp-services container is running on nanoclaw-net. */
function ensureMcpServicesRunning(): void {
  try {
    const status = execSync(
      `${CONTAINER_RUNTIME_BIN} inspect -f '{{.State.Running}}' ${MCP_SERVICES_CONTAINER_NAME} 2>/dev/null || echo "false"`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
    ).trim();

    if (status === 'true') {
      logger.debug('mcp-services container already running');
      return;
    }

    throw new Error('mcp-services container is not running');
  } catch (err) {
    logger.warn(
      { err },
      'mcp-services container is not running — agents will not have access to MCP service tools',
    );
  }
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }

  ensureNetwork();
  ensureProxyRunning();
  ensureMcpServicesRunning();
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output
      .trim()
      .split('\n')
      .filter(
        (name) =>
          name &&
          name !== PROXY_CONTAINER_NAME &&
          name !== MCP_SERVICES_CONTAINER_NAME,
      );
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
