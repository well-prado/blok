import { createCsrfMiddleware } from "@blokjs/inertia";

export default {
	"inertia.csrf": await createCsrfMiddleware(),
};
