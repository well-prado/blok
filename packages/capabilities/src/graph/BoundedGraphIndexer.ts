import {
	GRAPH_MAX_FILES_PER_INDEX,
	GRAPH_MAX_INDEX_BYTES,
	type GraphIndexRequest,
	type GraphIndexResponse,
	type GraphProvider,
	parseGraphIndexRequest,
} from "@blokjs/shared";
import { GraphProviderError } from "./GraphProviderError";

export interface GraphIndexerEvent {
	readonly type: "enqueued" | "started" | "completed" | "failed" | "cancelled";
	readonly key: string;
	readonly queued: number;
	readonly active: number;
	readonly error?: string;
}

export interface GraphIndexJobHandle {
	readonly key: string;
	readonly promise: Promise<GraphIndexResponse>;
	cancel(): void;
}

export interface GraphIndexerEnqueueOptions {
	readonly signal?: AbortSignal;
}

export interface BoundedGraphIndexerOptions {
	readonly maxQueueSize?: number;
	readonly maxConcurrent?: number;
	readonly maxFilesPerJob?: number;
	readonly maxBytesPerJob?: number;
	readonly onEvent?: (event: GraphIndexerEvent) => void;
}

interface Job {
	readonly key: string;
	readonly request: GraphIndexRequest;
	readonly controller: AbortController;
	readonly promise: Promise<GraphIndexResponse>;
	readonly resolve: (value: GraphIndexResponse) => void;
	readonly reject: (reason: unknown) => void;
	started: boolean;
}

function identityKey(request: GraphIndexRequest): string {
	const files = [...request.files]
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file) => `${file.path}:${file.contentHash}`);
	return JSON.stringify({
		repository: request.scope.repository,
		worktree: request.scope.worktree,
		commit: request.scope.commit,
		files,
	});
}

function requestBytes(request: GraphIndexRequest): number {
	return new TextEncoder().encode(JSON.stringify(request)).byteLength;
}

/** A bounded, cancellable and content-deduplicating index work queue. */
export class BoundedGraphIndexer {
	private readonly maxQueueSize: number;
	private readonly maxConcurrent: number;
	private readonly maxFilesPerJob: number;
	private readonly maxBytesPerJob: number;
	private readonly onEvent?: (event: GraphIndexerEvent) => void;
	private readonly jobs = new Map<string, Job>();
	private readonly queue: Job[] = [];
	private active = 0;

	constructor(
		private readonly provider: GraphProvider,
		options: BoundedGraphIndexerOptions = {},
	) {
		this.maxQueueSize = options.maxQueueSize ?? 64;
		this.maxConcurrent = options.maxConcurrent ?? 2;
		this.maxFilesPerJob = options.maxFilesPerJob ?? GRAPH_MAX_FILES_PER_INDEX;
		this.maxBytesPerJob = options.maxBytesPerJob ?? GRAPH_MAX_INDEX_BYTES;
		this.onEvent = options.onEvent;
		if (!Number.isSafeInteger(this.maxQueueSize) || this.maxQueueSize <= 0)
			throw new Error("maxQueueSize must be positive");
		if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent <= 0)
			throw new Error("maxConcurrent must be positive");
	}

	get queued(): number {
		return this.queue.length;
	}

	get running(): number {
		return this.active;
	}

	enqueue(input: unknown, options: GraphIndexerEnqueueOptions = {}): GraphIndexJobHandle {
		if (options.signal?.aborted) throw GraphProviderError.cancelled();
		let request: GraphIndexRequest;
		try {
			request = parseGraphIndexRequest(input);
		} catch (error) {
			throw new GraphProviderError(
				"invalid-query",
				"GRAPH_INVALID_INDEX_REQUEST",
				error instanceof Error ? error.message : "Invalid graph index request",
				{ guidance: "narrow-query" },
			);
		}
		if (request.files.length > this.maxFilesPerJob) {
			throw new GraphProviderError(
				"limit-exceeded",
				"GRAPH_INDEX_FILE_LIMIT",
				"Index request exceeds the configured file limit",
				{
					guidance: "narrow-query",
				},
			);
		}
		if (requestBytes(request) > this.maxBytesPerJob) {
			throw new GraphProviderError(
				"limit-exceeded",
				"GRAPH_INDEX_BYTE_LIMIT",
				"Index request exceeds the configured byte limit",
				{
					guidance: "narrow-query",
				},
			);
		}
		const key = identityKey(request);
		const existing = this.jobs.get(key);
		if (existing) return { key, promise: existing.promise, cancel: () => this.cancel(existing) };
		if (this.jobs.size >= this.maxQueueSize) {
			throw new GraphProviderError("limit-exceeded", "GRAPH_INDEX_QUEUE_FULL", "Graph index queue is full", {
				retryable: true,
				guidance: "retry",
			});
		}

		let resolve!: (value: GraphIndexResponse) => void;
		let reject!: (reason: unknown) => void;
		const promise = new Promise<GraphIndexResponse>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const job: Job = { key, request, controller: new AbortController(), promise, resolve, reject, started: false };
		this.jobs.set(key, job);
		this.queue.push(job);
		if (options.signal) {
			if (options.signal.aborted) {
				this.cancel(job);
			} else {
				options.signal.addEventListener("abort", () => this.cancel(job), { once: true });
			}
		}
		this.emit({ type: "enqueued", key });
		this.pump();
		return { key, promise, cancel: () => this.cancel(job) };
	}

	close(): void {
		for (const job of this.jobs.values()) this.cancel(job);
	}

	private cancel(job: Job): void {
		if (job.controller.signal.aborted) return;
		job.controller.abort();
		if (job.started) return;
		const index = this.queue.indexOf(job);
		if (index >= 0) this.queue.splice(index, 1);
		this.jobs.delete(job.key);
		job.reject(GraphProviderError.cancelled());
		this.emit({ type: "cancelled", key: job.key });
		this.pump();
	}

	private emit(event: Omit<GraphIndexerEvent, "queued" | "active">): void {
		this.onEvent?.({ ...event, queued: this.queue.length, active: this.active });
	}

	private pump(): void {
		while (this.active < this.maxConcurrent && this.queue.length > 0) {
			const job = this.queue.shift();
			if (!job) return;
			if (job.controller.signal.aborted) {
				this.jobs.delete(job.key);
				job.reject(GraphProviderError.cancelled());
				continue;
			}
			job.started = true;
			this.active += 1;
			this.emit({ type: "started", key: job.key });
			void this.run(job);
		}
	}

	private async run(job: Job): Promise<void> {
		try {
			const result = await this.provider.index(job.request, { signal: job.controller.signal });
			if (job.controller.signal.aborted) throw GraphProviderError.cancelled();
			job.resolve(result);
			this.emit({ type: "completed", key: job.key });
		} catch (error) {
			const failure = job.controller.signal.aborted ? GraphProviderError.cancelled() : error;
			job.reject(failure);
			this.emit({
				type: failure instanceof GraphProviderError && failure.category === "cancelled" ? "cancelled" : "failed",
				key: job.key,
				error: String(failure),
			});
		} finally {
			this.active -= 1;
			this.jobs.delete(job.key);
			this.pump();
		}
	}
}
