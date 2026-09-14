/**
 * Flash toast — bound to `inertia:flash`, the DOM event the stock Inertia
 * client fires after a page swap that carried flash data (Blok puts it there
 * from the signed one-shot cookie).
 *
 * ponytail: 20 lines of DOM instead of a toast library. Swap in your own
 * component the moment you want stacking, actions or animation.
 */
interface FlashEventDetail {
	flash: Record<string, unknown>;
}

function toast(message: string): void {
	const el = document.createElement("div");
	el.textContent = message;
	el.setAttribute("role", "status");
	el.style.cssText = [
		"position:fixed",
		"inset-block-end:1rem",
		"inset-inline-end:1rem",
		"max-inline-size:min(24rem, calc(100vw - 2rem))",
		"padding:0.75rem 1rem",
		"border-radius:0.5rem",
		"background:#111827",
		"color:#f9fafb",
		"font:400 0.875rem/1.4 system-ui, sans-serif",
		"box-shadow:0 10px 20px rgb(0 0 0 / 0.2)",
		"z-index:9999",
	].join(";");
	document.body.append(el);
	setTimeout(() => el.remove(), 4000);
}

export function listenForFlash(): void {
	document.addEventListener("inertia:flash", (event) => {
		const { flash } = (event as CustomEvent<FlashEventDetail>).detail;
		for (const value of Object.values(flash)) {
			if (typeof value === "string" && value !== "") toast(value);
		}
	});
}
