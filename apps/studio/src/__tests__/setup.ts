import "@testing-library/jest-dom/vitest";

// ponytail: Node 22+ ships its own `localStorage` global that needs
// `--localstorage-file` to actually work; vitest's jsdom environment doesn't
// override it (jsdom's real Storage isn't in vitest's global-keys allowlist),
// so bare `localStorage` resolves to `undefined` here instead of jsdom's
// implementation. Minimal in-memory Storage polyfill unblocks any test using
// localStorage — swap for real jsdom storage if a vitest/jsdom upgrade fixes
// the allowlist mismatch upstream.
class MemoryStorage implements Storage {
	private store = new Map<string, string>();
	get length() {
		return this.store.size;
	}
	clear() {
		this.store.clear();
	}
	getItem(key: string) {
		return this.store.has(key) ? (this.store.get(key) as string) : null;
	}
	key(index: number) {
		return [...this.store.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.store.delete(key);
	}
	setItem(key: string, value: string) {
		this.store.set(key, String(value));
	}
}
Object.defineProperty(globalThis, "localStorage", {
	value: new MemoryStorage(),
	configurable: true,
	writable: true,
});
