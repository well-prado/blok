import { runPage, runPrecognition } from "@blokjs/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import postsCreate, { page as postsCreatePage } from "../src/workflows/posts-create.js";

beforeAll(() => {
	// The flash cookie is signed; there is no session store to fall back on.
	process.env.BLOK_FLASH_SECRET ??= "example-secret-for-tests-only";
});

const AUTH = { auth: { id: "u-1", email: "ada@example.com" } };

describe("GET /posts/new", () => {
	it("renders the form page with the list it is going to update", async () => {
		const page = await runPage(postsCreatePage, { middleware: AUTH });

		page.assert().component("Posts/Create").has("auth").has("posts").etc();
		expect(page.scrollProps.posts).toMatchObject({ pageName: "page", currentPage: 1 });
	});
});

describe("POST /posts", () => {
	it("bounces back with a field error per empty field, and writes nothing", async () => {
		const page = await runPage(postsCreate, { method: "POST", input: { title: "", body: "" } });

		page
			.assertRedirect("/posts/new")
			.status(303)
			.assertFlash("errors.title", "Required.")
			.assertFlash("errors.body", "Required.");
		expect(page.run.step("create")?.executed).toBe(false);
	});

	it("creates the post, flashes the toast, and puts it at the top of the list", async () => {
		const created = await runPage(postsCreate, {
			method: "POST",
			input: { title: "Shipping the SPA layer", body: "Every prop is a step." },
			headers: { referer: "/posts/new" },
		});

		created.assertRedirect("/posts/new").status(303).assertFlash("toast", "Post created.");
		expect(created.run.step("reject")?.executed).toBe(false);

		// The redirect back is followed as an Inertia visit — this is that visit,
		// and the new post is the first row of the prop it comes back with.
		const page = await runPage(postsCreatePage, { middleware: AUTH });
		const posts = page.props.posts as { data: Array<{ title: string }>; total: number };

		expect(posts.data[0].title).toBe("Shipping the SPA layer");
		expect(posts.total).toBe(26);
	});

	it("never reaches the write on a Precognition dry run", async () => {
		const dry = await runPrecognition(postsCreate, { body: { title: "", body: "" }, fields: ["title"] });

		expect(dry.status).toBe(422);
		expect(dry.errors.title).toBe("Required.");
		// `Precognition-Validate-Only: title` filters the other field out.
		expect(dry.errors.body).toBeUndefined();
		expect(dry.run.step("create")?.executed).toBe(false);
	});

	it("answers 204 when the asked-about fields are clean", async () => {
		const dry = await runPrecognition(postsCreate, { body: { title: "Ok", body: "Fine" } });

		expect(dry.status).toBe(204);
		expect(dry.run.step("create")?.executed).toBe(false);
	});
});
