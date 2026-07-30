/**
 * Version-tolerant OpenTelemetry `Resource` construction.
 *
 * The OTel SDK packages are OPTIONAL dynamic imports (`PrometheusBootstrap` /
 * `TracingBootstrap` degrade gracefully when they're absent), so a user project
 * may be on either major line:
 *
 *   - 1.x — `Resource` class: `Resource.default().merge(new Resource(attrs))`
 *   - 2.x — factories: `defaultResource().merge(resourceFromAttributes(attrs))`
 *
 * 2.x removed the `Resource` class outright, so calling `new Resource()` against
 * it throws. Blok pins `^2.10.0` (the 1.x line carries GHSA-8988-4f7v-96qf), but
 * an existing project that hasn't upgraded its own OTel deps must keep working —
 * hence the runtime detection rather than a hard 2.x-only call.
 */

/** Shape we probe on the dynamically imported `@opentelemetry/resources` module. */
interface ResourceModuleLike {
	resourceFromAttributes?: (attrs: Record<string, unknown>) => unknown;
	defaultResource?: () => { merge: (other: unknown) => unknown };
	Resource?: {
		new (attrs: Record<string, unknown>): unknown;
		default?: () => { merge: (other: unknown) => unknown };
	};
}

/**
 * Build a Resource carrying `attrs`, merged onto the SDK's default resource,
 * using whichever API the installed `@opentelemetry/resources` exposes.
 */
export function buildOtelResource(resourceMod: unknown, attrs: Record<string, unknown>): unknown {
	const mod = resourceMod as ResourceModuleLike;

	// OTel 2.x — factory functions.
	if (typeof mod.resourceFromAttributes === "function") {
		const attrResource = mod.resourceFromAttributes(attrs);
		return typeof mod.defaultResource === "function" ? mod.defaultResource().merge(attrResource) : attrResource;
	}

	// OTel 1.x — the `Resource` class.
	const ResourceCtor = mod.Resource;
	if (typeof ResourceCtor === "function") {
		const attrResource = new ResourceCtor(attrs);
		return typeof ResourceCtor.default === "function" ? ResourceCtor.default().merge(attrResource) : attrResource;
	}

	// Neither shape available — let the caller pass `undefined` through; the SDK
	// falls back to its own default resource rather than crashing boot.
	return undefined;
}
