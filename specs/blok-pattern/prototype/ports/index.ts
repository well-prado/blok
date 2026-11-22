// Ports: everything a node may touch outside itself. The host decides what is behind them.
export interface Ports {
	catalog: { priceCents(sku: string): Promise<number | undefined> };
	payments: {
		charge(
			token: string,
			amountCents: number,
			opts: { signal: AbortSignal },
		): Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
	};
	stock: { release(orderId: string): Promise<void> };
	crm: { flagVip(customerId: string): Promise<void> };
	ids: { next(prefix: string): string };
	shipping: { book(orderId: string, lane: "courier" | "post" | "hold"): Promise<string> };
	mailer: { send(to: string, subject: string, body: string): Promise<void> };
	http: {
		request(
			req: { url: string; method: string; headers?: Record<string, string>; body?: unknown },
			opts: { signal: AbortSignal },
		): Promise<{ status: number; data: unknown }>;
	};
	kv: { set(key: string, value: unknown): Promise<void>; list(): Promise<unknown[]> };
}

/** In-memory stand-ins for every port, so the app and `blokctl run` work with no setup. Tests override the ones they watch. */
export function fakePorts(overrides: Partial<Ports> = {}): Ports {
	let n = 0;
	const stored = new Map<string, unknown>();
	return {
		catalog: { priceCents: async (sku) => ({ "sku-book": 25_00, "sku-desk": 180_00 })[sku] },
		payments: {
			charge: async (token) =>
				token === "tok_bad" ? { ok: false, reason: "Insufficient funds" } : { ok: true, id: "rc_1" },
		},
		stock: { release: async () => {} },
		crm: { flagVip: async () => {} },
		ids: { next: (prefix) => `${prefix}_${++n}` },
		shipping: { book: async (orderId, lane) => `trk_${lane}_${orderId}` },
		mailer: { send: async () => {} },
		http: { request: async (req) => ({ status: 200, data: { from: req.url } }) },
		kv: {
			set: async (key, value) => void stored.set(key, value),
			list: async () => [...stored.values()],
		},
		...overrides,
	};
}

export const ports: Ports = fakePorts();
