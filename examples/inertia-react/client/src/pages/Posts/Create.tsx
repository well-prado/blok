import type { PageProps } from "@blokjs/inertia";
import { Head, Link, useForm } from "@inertiajs/react";
import { useState } from "react";
import type { PostsCreate as PostsCreatePage } from "../../../../src/workflows/posts-create.js";
import { appLayout } from "../../components/AppLayout.js";

/**
 * Create a post, and watch the list below it change.
 *
 * The form is an ordinary Inertia `useForm`. On success the workflow redirects
 * BACK to this page, the Inertia client follows that as an XHR, and the `posts`
 * prop comes back with the new post at the top — no full page load, no manual
 * client-side list surgery, no state to keep in sync.
 *
 * `form.validate(field)` drives Precognition: the blur posts `/posts` with
 * `Precognition: true`, the runner stops after the step marked
 * `{ precognition: true }`, and nothing is written.
 */
export default function Create({ posts }: PageProps<typeof PostsCreatePage>) {
	// A FRESH form per created post. Precognition debounces the validation a blur
	// starts, so clicking "Create post" right after typing leaves one in flight —
	// and a `form.reset()` on success makes that request validate EMPTY data and
	// paint "Required." over a form that just succeeded. Remounting the form is
	// the fix that cannot race it: the stale response lands on a component that
	// is gone.
	const [formKey, setFormKey] = useState(0);

	return (
		<>
			<Head title="New post" />

			<div className="blok-page-header">
				<div>
					<p className="blok-eyebrow">Posts</p>
					<h1>New post</h1>
					<p className="blok-lede">
						Submit, and the list below updates from the same request — a redirect back, followed as an Inertia visit.
					</p>
				</div>
				<div className="blok-page-header__end">
					<Link href="/" className="blok-btn">
						Dashboard
					</Link>
				</div>
			</div>

			<div className="blok-card">
				<div className="blok-card__body">
					<PostForm key={formKey} onCreated={() => setFormKey((previous) => previous + 1)} />
				</div>
			</div>

			<div className="blok-card">
				<div className="blok-card__header">
					<h2>Posts</h2>
					<span className="blok-badge">{posts.total} total</span>
				</div>
				<ul className="blok-feed">
					{posts.data.map((post) => (
						<li key={post.id}>
							<span>{post.title}</span>
							<span className="blok-feed__meta">{post.id}</span>
						</li>
					))}
				</ul>
			</div>
		</>
	);
}

/** The form itself — its own component, so the page can remount it on success. */
function PostForm({ onCreated }: { onCreated: () => void }) {
	const form = useForm("post", "/posts", { title: "", body: "" });

	return (
		<form
			className="blok-form"
			onSubmit={(event) => {
				event.preventDefault();
				// Nothing to do for the list on success: the redirect back already
				// re-rendered this page's props with the new post at the top.
				form.post("/posts", { onSuccess: onCreated });
			}}
		>
			<div className="blok-field">
				<label className="blok-label" htmlFor="title">
					Title
				</label>
				<input
					id="title"
					name="title"
					className="blok-input"
					placeholder="Shipping the SPA layer"
					value={form.data.title}
					onChange={(event) => form.setData("title", event.target.value)}
					onBlur={() => form.validate("title")}
					aria-invalid={form.errors.title === undefined ? undefined : true}
					aria-describedby={form.errors.title === undefined ? "title-hint" : "title-error"}
				/>
				{form.errors.title === undefined ? (
					<p className="blok-hint" id="title-hint">
						What the post is about.
					</p>
				) : (
					<p className="blok-error" id="title-error">
						{form.errors.title}
					</p>
				)}
			</div>

			<div className="blok-field">
				<label className="blok-label" htmlFor="body">
					Body
				</label>
				<textarea
					id="body"
					name="body"
					rows={4}
					// `.blok-input` covers a textarea as-is; the design system has no
					// separate token for one and this example may not edit blok.css.
					className="blok-input"
					placeholder="A paragraph or two."
					value={form.data.body}
					onChange={(event) => form.setData("body", event.target.value)}
					onBlur={() => form.validate("body")}
					aria-invalid={form.errors.body === undefined ? undefined : true}
					aria-describedby={form.errors.body === undefined ? "body-hint" : "body-error"}
				/>
				{form.errors.body === undefined ? (
					<p className="blok-hint" id="body-hint">
						Required, like the title.
					</p>
				) : (
					<p className="blok-error" id="body-error">
						{form.errors.body}
					</p>
				)}
			</div>

			<div className="blok-form__actions">
				<button type="submit" className="blok-btn blok-btn--primary" disabled={form.processing}>
					{form.processing ? <span className="blok-spinner" /> : null}
					{form.processing ? "Saving…" : "Create post"}
				</button>
				<Link href="/" className="blok-btn">
					Cancel
				</Link>
				<PrecognitionStatus validating={form.validating} valid={form.valid("title") && form.valid("body")} />
			</div>
		</form>
	);
}

/** The live-validation indicator: the whole point of the Precognition round trip. */
function PrecognitionStatus({ validating, valid }: { validating: boolean; valid: boolean }) {
	if (validating) {
		return (
			<output className="blok-form__status">
				<span className="blok-spinner" /> Validating…
			</output>
		);
	}
	if (valid) {
		return <output className="blok-form__status blok-form__status--valid">✓ Looks good</output>;
	}
	return null;
}

Create.layout = appLayout;
