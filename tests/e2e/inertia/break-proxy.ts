/**
 * The suite's self-check harness: a reverse proxy that BREAKS one real thing.
 *
 * `self-check.sh` puts this in front of the live Blok server and asserts that
 * each flag makes its numbered scenario fail. A suite that cannot be made to
 * fail proves nothing, and "the assertion ran and failed" is the only evidence
 * that counts — a setup error is not breaker evidence.
 *
 *   E2E_BREAK_VARY=1    strip `Vary`                       -> scenario 01 fails
 *   E2E_BREAK_303=1     rewrite a write's 303 as a 302     -> scenario 07 fails
 *   E2E_BREAK_ESCAPE=1  un-escape `\/script` in the shell  -> scenario 20 fails
 */

declare const Bun: {
	serve(options: {
		port: number;
		hostname: string;
		idleTimeout?: number;
		fetch: (request: Request) => Promise<Response>;
	}): { port: number };
};

const target = process.env.E2E_TARGET_URL ?? "http://127.0.0.1:4600";
const port = Number(process.env.E2E_PROXY_PORT ?? 4690);
const broken = {
	vary: process.env.E2E_BREAK_VARY === "1",
	redirect: process.env.E2E_BREAK_303 === "1",
	escape: process.env.E2E_BREAK_ESCAPE === "1",
};

/** `serializePage` emits `<\/script>`: only `<` and `/` are escaped. */
export function breakEscapedScript(html: string): string {
	return html.replace(/\\u003c\\\/script>/gi, "</script><script>window.pwned=1</script>");
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

if (process.env.E2E_PROXY_SELF_TEST === "1") {
	// Built from escape SEQUENCES, not a raw literal: a formatter normalises
	// `\u003C` inside a String.raw template back to `<`, which quietly turns
	// this self-test into a no-op.
	const serialized = '{"payload":"\\u003C\\/script>"}';
	const brokenHtml = breakEscapedScript(serialized);
	if (!brokenHtml.includes("</script><script>window.pwned=1</script>")) {
		throw new Error("escape breaker did not alter the serializer output");
	}
	console.log("e2e break proxy self-check passed");
} else {
	Bun.serve({
		port,
		hostname: "127.0.0.1",
		// A browser keeps idle connections open; the default 10s would drop them.
		idleTimeout: 120,
		fetch: async (request) => {
			try {
				const url = new URL(request.url);
				const upstream = new URL(`${url.pathname}${url.search}`, target);
				const headers = new Headers(request.headers);
				headers.delete("host");
				// Identity encoding: the escape breaker rewrites the BODY, and a
				// gzipped one would have to be decoded first for no benefit.
				headers.set("accept-encoding", "identity");

				const hasBody = WRITE_METHODS.has(request.method);
				const body = hasBody ? await request.arrayBuffer() : undefined;
				const response = await fetch(upstream, {
					method: request.method,
					headers,
					...(hasBody ? { body } : {}),
					redirect: "manual",
				});

				let payload: ArrayBuffer | null = response.body === null ? null : await response.arrayBuffer();
				const out = new Headers(response.headers);
				let status = response.status;
				if (broken.vary) out.delete("vary");
				if (broken.redirect && status === 303 && WRITE_METHODS.has(request.method)) status = 302;
				if (broken.escape && payload !== null) {
					payload = new TextEncoder().encode(breakEscapedScript(new TextDecoder().decode(payload)))
						.buffer as ArrayBuffer;
				}
				// The length changed (escape), or the upstream declared one for a body
				// we re-encoded: let the runtime recompute it.
				out.delete("content-length");
				out.delete("content-encoding");
				return new Response(status === 204 || status === 304 ? null : payload, { status, headers: out });
			} catch (error) {
				return new Response(error instanceof Error ? error.message : String(error), { status: 502 });
			}
		},
	});
	console.log(`e2e break proxy listening on ${port} -> ${target}`);
}
