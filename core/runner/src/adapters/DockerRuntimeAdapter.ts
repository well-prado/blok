import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@nanoservice-ts/shared";
import type RunnerNode from "../RunnerNode";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "./RuntimeAdapter";

const execAsync = promisify(exec);

/**
 * Container instance in the pool
 */
interface ContainerInstance {
	containerId: string;
	containerName: string;
	image: string;
	port: number;
	healthy: boolean;
	lastUsed: number;
	useCount: number;
}

/**
 * Container pool configuration
 */
interface PoolConfig {
	minInstances: number;
	maxInstances: number;
	maxIdleTime: number; // milliseconds
	maxUseCount: number; // max executions before recycling
	healthCheckInterval: number; // milliseconds
}

/**
 * DockerRuntimeAdapter executes nodes in Docker containers
 *
 * This adapter provides:
 * - Container pooling for performance
 * - Health checks for reliability
 * - Automatic cleanup and recycling
 * - HTTP-based communication protocol
 *
 * Containers must expose an HTTP endpoint that:
 * - POST /execute - Executes a node with the provided context
 * - GET /health - Returns container health status
 */
export class DockerRuntimeAdapter implements RuntimeAdapter {
	public readonly kind: RuntimeKind;
	private image: string;
	private pool: Map<string, ContainerInstance> = new Map();
	private poolConfig: PoolConfig;
	private cleanupInterval?: NodeJS.Timeout;
	private healthCheckInterval?: NodeJS.Timeout;
	private nextPort = 9000;

	constructor(kind: RuntimeKind = "docker", image: string, poolConfig?: Partial<PoolConfig>) {
		this.kind = kind;
		this.image = image;
		this.poolConfig = {
			minInstances: poolConfig?.minInstances ?? 0,
			maxInstances: poolConfig?.maxInstances ?? 5,
			maxIdleTime: poolConfig?.maxIdleTime ?? 5 * 60 * 1000, // 5 minutes
			maxUseCount: poolConfig?.maxUseCount ?? 100,
			healthCheckInterval: poolConfig?.healthCheckInterval ?? 30 * 1000, // 30 seconds
		};

		// Initialize pool
		this.initializePool();
	}

	/**
	 * Execute a node in a Docker container
	 */
	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		try {
			// Get or create a container from the pool
			const container = await this.getContainer();

			// Prepare the execution request
			const request = this.createExecutionRequest(node, ctx);

			// Execute via HTTP POST to container
			const response = await this.executeInContainer(container, request);

			// Update container stats
			container.lastUsed = Date.now();
			container.useCount++;

			// Recycle container if needed
			if (container.useCount >= this.poolConfig.maxUseCount) {
				await this.recycleContainer(container);
			}

			const duration_ms = performance.now() - startTime;

			return {
				success: response.success ?? true,
				data: response.data,
				errors: response.errors || null,
				logs: response.logs,
				metrics: {
					duration_ms,
					...(response.metrics || {}),
				},
			};
		} catch (error: unknown) {
			const duration_ms = performance.now() - startTime;

			return {
				success: false,
				data: null,
				errors: {
					message: (error as Error).message,
					stack: (error as Error).stack,
					name: (error as Error).name,
				},
				metrics: {
					duration_ms,
				},
			};
		}
	}

	/**
	 * Get a container from the pool or create a new one
	 */
	private async getContainer(): Promise<ContainerInstance> {
		// Try to get a healthy container from the pool
		for (const container of this.pool.values()) {
			if (container.healthy && container.useCount < this.poolConfig.maxUseCount) {
				return container;
			}
		}

		// Check if we can create a new container
		if (this.pool.size < this.poolConfig.maxInstances) {
			return await this.createContainer();
		}

		// Wait and retry (simple backoff)
		await new Promise((resolve) => setTimeout(resolve, 100));
		return await this.getContainer();
	}

	/**
	 * Create a new container instance
	 */
	private async createContainer(): Promise<ContainerInstance> {
		const port = this.nextPort++;
		const containerName = `blok-runtime-${this.kind}-${Date.now()}-${port}`;

		try {
			// Run container with port mapping
			const { stdout } = await execAsync(`docker run -d --name ${containerName} -p ${port}:8080 --rm ${this.image}`);

			const containerId = stdout.trim();

			const container: ContainerInstance = {
				containerId,
				containerName,
				image: this.image,
				port,
				healthy: false,
				lastUsed: Date.now(),
				useCount: 0,
			};

			// Wait for container to be healthy
			await this.waitForHealth(container);

			this.pool.set(containerId, container);

			return container;
		} catch (error) {
			throw new Error(`Failed to create container: ${(error as Error).message}`);
		}
	}

	/**
	 * Wait for container to be healthy
	 */
	private async waitForHealth(container: ContainerInstance, maxAttempts = 30, delay = 1000): Promise<void> {
		for (let i = 0; i < maxAttempts; i++) {
			try {
				const healthy = await this.checkHealth(container);
				if (healthy) {
					container.healthy = true;
					return;
				}
			} catch {
				// Container not ready yet
			}

			await new Promise((resolve) => setTimeout(resolve, delay));
		}

		throw new Error(`Container ${container.containerName} failed to become healthy`);
	}

	/**
	 * Check if a container is healthy
	 */
	private async checkHealth(container: ContainerInstance): Promise<boolean> {
		try {
			const response = await fetch(`http://localhost:${container.port}/health`, {
				method: "GET",
				signal: AbortSignal.timeout(2000),
			});

			if (response.ok) {
				const data = await response.json();
				return data.status === "healthy";
			}

			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Execute a request in a container
	 */
	private async executeInContainer(container: ContainerInstance, request: unknown): Promise<ExecutionResult> {
		const response = await fetch(`http://localhost:${container.port}/execute`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(30000), // 30 second timeout
		});

		if (!response.ok) {
			throw new Error(`Container execution failed: ${response.statusText}`);
		}

		return (await response.json()) as ExecutionResult;
	}

	/**
	 * Create the execution request payload
	 */
	private createExecutionRequest(node: RunnerNode, ctx: Context): unknown {
		const nodeConfig = ctx.config ? (ctx.config as Record<string, unknown>)[node.name] : {};

		return {
			node: {
				name: node.node,
				type: node.type,
				config: nodeConfig || {},
			},
			context: {
				id: ctx.id,
				workflow_name: ctx.workflow_name,
				workflow_path: ctx.workflow_path,
				request: {
					body: ctx.request.body,
					headers: ctx.request.headers,
					params: ctx.request.params,
					query: ctx.request.query,
					method: ctx.request.method,
					url: ctx.request.url,
					cookies: ctx.request.cookies,
					baseUrl: ctx.request.baseUrl,
				},
				response: ctx.response,
				vars: ctx.vars,
				env: ctx.env,
			},
		};
	}

	/**
	 * Recycle a container (stop and remove from pool)
	 */
	private async recycleContainer(container: ContainerInstance): Promise<void> {
		this.pool.delete(container.containerId);

		try {
			// Container will auto-remove due to --rm flag
			await execAsync(`docker stop ${container.containerName}`);
		} catch {
			// Ignore errors during cleanup
		}
	}

	/**
	 * Initialize the container pool
	 */
	private async initializePool(): Promise<void> {
		// Create minimum instances
		const promises = [];
		for (let i = 0; i < this.poolConfig.minInstances; i++) {
			promises.push(this.createContainer().catch(() => null));
		}
		await Promise.all(promises);

		// Start cleanup interval
		this.cleanupInterval = setInterval(() => {
			this.cleanupIdleContainers();
		}, 60000); // Run every minute

		// Start health check interval
		this.healthCheckInterval = setInterval(() => {
			this.performHealthChecks();
		}, this.poolConfig.healthCheckInterval);
	}

	/**
	 * Cleanup idle containers
	 */
	private async cleanupIdleContainers(): Promise<void> {
		const now = Date.now();
		const containersToRemove: ContainerInstance[] = [];

		for (const container of this.pool.values()) {
			const idleTime = now - container.lastUsed;
			const isIdle = idleTime > this.poolConfig.maxIdleTime;
			const canRemove = this.pool.size > this.poolConfig.minInstances;

			if (isIdle && canRemove) {
				containersToRemove.push(container);
			}
		}

		for (const container of containersToRemove) {
			await this.recycleContainer(container);
		}
	}

	/**
	 * Perform health checks on all containers
	 */
	private async performHealthChecks(): Promise<void> {
		const checks = Array.from(this.pool.values()).map(async (container) => {
			const healthy = await this.checkHealth(container);
			container.healthy = healthy;

			// Recycle unhealthy containers
			if (!healthy) {
				await this.recycleContainer(container);
			}
		});

		await Promise.allSettled(checks);
	}

	/**
	 * Shutdown the adapter and cleanup all containers
	 */
	async shutdown(): Promise<void> {
		// Clear intervals
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
		}

		// Stop all containers
		const shutdownPromises = Array.from(this.pool.values()).map((container) => this.recycleContainer(container));

		await Promise.allSettled(shutdownPromises);

		this.pool.clear();
	}
}
