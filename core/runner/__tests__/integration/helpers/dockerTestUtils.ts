/**
 * Docker Test Utilities
 *
 * Helpers for Docker-based integration tests:
 * - Building test images
 * - Managing test containers
 * - Waiting for container health
 * - Cleaning up test resources
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface DockerImageBuildOptions {
  context: string;
  tag: string;
  dockerfile?: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
}

/**
 * Build a Docker image for testing
 */
export async function buildDockerImage(
  tag: string,
  context: string,
  dockerfile = 'Dockerfile',
): Promise<void> {
  console.log(`🐳 Building Docker image: ${tag}`);

  try {
    const { stdout, stderr } = await execAsync(
      `docker build -t ${tag} -f ${dockerfile} ${context}`,
      {
        cwd: process.cwd(),
      },
    );

    if (stderr && !stderr.includes('naming to')) {
      console.warn('Docker build warnings:', stderr);
    }

    console.log(`✅ Built Docker image: ${tag}`);
  } catch (error: any) {
    console.error(`❌ Failed to build Docker image: ${tag}`);
    throw new Error(`Docker build failed: ${error.message}`);
  }
}

/**
 * Check if a Docker image exists locally
 */
export async function imageExists(tag: string): Promise<boolean> {
  try {
    await execAsync(`docker image inspect ${tag}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a Docker container
 */
export async function startContainer(
  image: string,
  name: string,
  ports?: Record<string, string>,
  env?: Record<string, string>,
): Promise<string> {
  const portMappings = ports
    ? Object.entries(ports)
        .map(([host, container]) => `-p ${host}:${container}`)
        .join(' ')
    : '';

  const envVars = env
    ? Object.entries(env)
        .map(([key, value]) => `-e ${key}=${value}`)
        .join(' ')
    : '';

  const { stdout } = await execAsync(
    `docker run -d --name ${name} ${portMappings} ${envVars} ${image}`,
  );

  const containerId = stdout.trim();
  console.log(`✅ Started container: ${name} (${containerId.slice(0, 12)})`);

  return containerId;
}

/**
 * Stop and remove a Docker container
 */
export async function stopContainer(nameOrId: string): Promise<void> {
  try {
    await execAsync(`docker stop ${nameOrId}`);
    await execAsync(`docker rm ${nameOrId}`);
    console.log(`✅ Stopped and removed container: ${nameOrId}`);
  } catch (error: any) {
    console.warn(`⚠️  Failed to stop container: ${error.message}`);
  }
}

/**
 * Wait for a container to be healthy
 */
export async function waitForHealthy(
  nameOrId: string,
  timeoutMs = 30000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const { stdout } = await execAsync(
        `docker inspect --format='{{.State.Health.Status}}' ${nameOrId}`,
      );

      if (stdout.trim() === 'healthy') {
        console.log(`✅ Container is healthy: ${nameOrId}`);
        return;
      }
    } catch {
      // Container might not have health check, check if running
      try {
        const { stdout } = await execAsync(
          `docker inspect --format='{{.State.Running}}' ${nameOrId}`,
        );

        if (stdout.trim() === 'true') {
          console.log(`✅ Container is running: ${nameOrId}`);
          return;
        }
      } catch {
        // Ignore
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Container did not become healthy within ${timeoutMs}ms`);
}

/**
 * Wait for a port to be ready
 */
export async function waitForPort(
  host: string,
  port: number,
  timeoutMs = 30000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Try to connect to the port
      const nc = await execAsync(`nc -z ${host} ${port}`);
      console.log(`✅ Port ${port} is ready`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Port ${port} did not become ready within ${timeoutMs}ms`);
}

/**
 * Get container logs
 */
export async function getContainerLogs(nameOrId: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`docker logs ${nameOrId}`);
    return stdout;
  } catch (error: any) {
    return `Failed to get logs: ${error.message}`;
  }
}

/**
 * List running containers
 */
export async function listContainers(): Promise<ContainerInfo[]> {
  try {
    const { stdout } = await execAsync(
      'docker ps --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}"',
    );

    return stdout
      .trim()
      .split('\n')
      .filter((line) => line)
      .map((line) => {
        const [id, name, image, status, ports] = line.split('|');
        return { id, name, image, status, ports };
      });
  } catch {
    return [];
  }
}

/**
 * Clean up all test containers (by prefix)
 */
export async function cleanupTestContainers(prefix = 'blok-test-'): Promise<void> {
  const containers = await listContainers();
  const testContainers = containers.filter((c) => c.name.startsWith(prefix));

  for (const container of testContainers) {
    await stopContainer(container.id);
  }

  console.log(`✅ Cleaned up ${testContainers.length} test containers`);
}

/**
 * Execute command in running container
 */
export async function execInContainer(
  nameOrId: string,
  command: string,
): Promise<string> {
  const { stdout } = await execAsync(`docker exec ${nameOrId} ${command}`);
  return stdout.trim();
}
