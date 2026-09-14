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
	el.textContent = message;
	el.setAttribute("role", "status");
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
