/**
 * In-process event bus for the v0.7 SSE trigger.
 *
 * Provides three operations:
 *   - `publish(channel, event)` — fan out an event to every active
 *     subscriber of the channel, then append it to the channel's ring
 *     buffer (bounded by `MAX_HISTORY_PER_CHANNEL`).
 *   - `subscribe(channels, lastEventId?)` — return an async iterator
 *     yielding events on any of the named channels, replaying buffered
 *     events whose id strictly follows `lastEventId` first. Caller
 *     unsubscribes by exiting the `for-await` loop (or calling
 *     `iterator.return()`).
 *   - `clear()` — drop all subscribers + buffers. Used by tests.
 *
 * Design choices:
 *   - **In-process only** for v0.7 PR 3. Multi-process backplane
 *     (Redis Streams / NATS JetStream) is a follow-up — keeps the
 *     trigger demoable without external infra.
 *   - **Per-channel ring buffer** caps memory: 100 events × 1KB ≈ 100KB
 *     per channel. Adjustable via `MAX_HISTORY_PER_CHANNEL`.
 *   - **Backpressure**: the iterator queues events in a per-subscriber
 *     bounded array (`MAX_SUBSCRIBER_QUEUE`). When full, oldest events
 *     are dropped and `droppedEvents` counter increments — the
 *     trigger surfaces this in Studio. Slow consumers cannot block
 *     publishers.
 *   - **Replay correctness**: events carry a monotonically increasing
 *     `seq` per process. `lastEventId` parses to a numeric `seq`; the
 *     iterator yields buffered events with `seq > lastSeq` before
 *     entering the live phase. Crash-restart resets `seq` — clients
 *     re-syncing across a server restart see the new sequence and
 *     get a normal live stream (no false replay).
 */

const MAX_HISTORY_PER_CHANNEL = 100;
const MAX_SUBSCRIBER_QUEUE = 256;

export interface BusEvent {
	/** Channel the event was published on. */
	channel: string;
	/** Process-monotonic sequence number, formatted as a string for the SSE `id:` field. */
	id: string;
	/** Caller-supplied event name (maps to SSE `event:` field). */
	event?: string;
	/** Caller-supplied payload (arbitrary JSON-serializable value). */
	data: unknown;
	/** Wall-clock publish time (ms since epoch). */
	timestamp: number;
}

interface QueuedSubscriber {
	channels: Set<string>;
	queue: BusEvent[];
	resolveNext: ((value: BusEvent | null) => void) | null;
	closed: boolean;
	droppedEvents: number;
}

class Bus {
	private subscribers = new Set<QueuedSubscriber>();
	private history = new Map<string, BusEvent[]>();
	private seq = 0;

	publish(channel: string, opts: { event?: string; data: unknown; id?: string }): BusEvent {
		this.seq += 1;
		const evt: BusEvent = {
			channel,
			id: opts.id ?? String(this.seq),
			event: opts.event,
			data: opts.data,
			timestamp: Date.now(),
		};

		// Append to history (bounded ring buffer).
		let history = this.history.get(channel);
		if (!history) {
			history = [];
			this.history.set(channel, history);
		}
		history.push(evt);
		if (history.length > MAX_HISTORY_PER_CHANNEL) {
			history.splice(0, history.length - MAX_HISTORY_PER_CHANNEL);
		}

		// Fan out to every matching subscriber.
		for (const sub of this.subscribers) {
			if (!sub.channels.has(channel)) continue;
			this.deliver(sub, evt);
		}
		return evt;
	}

	subscribe(channels: string[], lastEventId?: string | null): AsyncIterableIterator<BusEvent> {
		const channelSet = new Set(channels);
		const sub: QueuedSubscriber = {
			channels: channelSet,
			queue: [],
			resolveNext: null,
			closed: false,
			droppedEvents: 0,
		};

		// Replay buffered events whose seq strictly exceeds `lastEventId`
		// across every subscribed channel, interleaved by their original
		// publish order (seq is process-monotonic so a numeric sort gives
		// chronological order).
		if (lastEventId !== undefined && lastEventId !== null && lastEventId !== "") {
			const lastSeq = Number.parseInt(lastEventId, 10);
			if (Number.isFinite(lastSeq)) {
				const replay: BusEvent[] = [];
				for (const channel of channelSet) {
					const history = this.history.get(channel);
					if (!history) continue;
					for (const evt of history) {
						const evtSeq = Number.parseInt(evt.id, 10);
						if (Number.isFinite(evtSeq) && evtSeq > lastSeq) {
							replay.push(evt);
						}
					}
				}
				replay.sort((a, b) => Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10));
				sub.queue.push(...replay);
			}
		}

		this.subscribers.add(sub);

		const iterator: AsyncIterableIterator<BusEvent> = {
			[Symbol.asyncIterator]() {
				return iterator;
			},
			next: () => this.consumeNext(sub),
			return: async (value?: unknown) => {
				this.cancel(sub);
				return { value: value as BusEvent | undefined, done: true };
			},
			throw: async (err: unknown) => {
				this.cancel(sub);
				throw err;
			},
		};
		return iterator;
	}

	clear(): void {
		for (const sub of this.subscribers) {
			sub.closed = true;
			sub.resolveNext?.(null);
		}
		this.subscribers.clear();
		this.history.clear();
		this.seq = 0;
	}

	stats(): { subscribers: number; channels: number; bufferedEvents: number } {
		let bufferedEvents = 0;
		for (const buf of this.history.values()) bufferedEvents += buf.length;
		return { subscribers: this.subscribers.size, channels: this.history.size, bufferedEvents };
	}

	private deliver(sub: QueuedSubscriber, evt: BusEvent): void {
		if (sub.closed) return;
		if (sub.resolveNext) {
			const resolve = sub.resolveNext;
			sub.resolveNext = null;
			resolve(evt);
			return;
		}
		if (sub.queue.length >= MAX_SUBSCRIBER_QUEUE) {
			sub.queue.shift();
			sub.droppedEvents += 1;
		}
		sub.queue.push(evt);
	}

	private async consumeNext(sub: QueuedSubscriber): Promise<IteratorResult<BusEvent>> {
		if (sub.closed) return { value: undefined, done: true };
		const queued = sub.queue.shift();
		if (queued) return { value: queued, done: false };
		const evt = await new Promise<BusEvent | null>((resolve) => {
			sub.resolveNext = resolve;
		});
		if (sub.closed || evt === null) return { value: undefined, done: true };
		return { value: evt, done: false };
	}

	private cancel(sub: QueuedSubscriber): void {
		sub.closed = true;
		sub.queue = [];
		const resolve = sub.resolveNext;
		sub.resolveNext = null;
		resolve?.(null);
		this.subscribers.delete(sub);
	}
}

let activeBus: Bus | null = null;

export function getBus(): Bus {
	if (!activeBus) activeBus = new Bus();
	return activeBus;
}

export function _resetBusForTests(): void {
	activeBus?.clear();
	activeBus = null;
}

export type { Bus };
