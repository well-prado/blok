/** Throws from a separate module so the captured stack has a frame to map. */
export function detonate(): never {
	throw new Error("conformance: boom from lib/boom");
}
