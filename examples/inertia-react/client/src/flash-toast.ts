/**
 * Flash toast — bound to `inertia:flash`, the DOM event the stock Inertia
 * client fires after a page swap that carried flash data (Blok puts it there
 * from the signed one-shot cookie).
 *
 * ponytail: 20 lines of DOM instead of a toast library. It borrows `.blok-toast`
 * from `blok.css`, so it is themed for free. Swap in your own component the
 * moment you want stacking, actions or animation.
 *
 * The SAME BYTES ship in every template and example — `tests/docs/spa-design.test.ts`
 * fails if they drift.
 */
interface FlashEventDetail {
	flash: Record<string, unknown>;
}

function toast(message: string): void {
	const el = document.createElement("div");
	el.className = "blok-toast";
	el.setAttribute("role", "status");
	// The live region has to be in the DOM BEFORE its text changes, or a screen
	// reader sees a node that was born with content and announces nothing. Append
	// empty, fill on the next frame.
	document.body.append(el);
	requestAnimationFrame(() => {
		el.textContent = message;
	});
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
