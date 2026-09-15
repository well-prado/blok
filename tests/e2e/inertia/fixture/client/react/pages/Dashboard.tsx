import { Deferred, Head, InfiniteScroll, WhenVisible, router, usePoll } from "@inertiajs/react";
import { layout } from "../components/Layout.js";

interface Props {
	auth: { id: string; email: string };
	orders: { data: { id: string; title: string }[]; total: number };
	stats?: { revenue: number; orders: number; calls: number };
	secondary?: { label: string };
	flaky?: { label: string };
	plans: { id: string; price: number }[];
	visible?: { seen: boolean };
	feed: { data: { id: string; label: string }[]; total: number };
	users: { data: { id: string; name: string }[] };
}

/**
 * The deferred / partial / polling page.
 *
 * `stats` (Python, group `default`) and `secondary` + `flaky` (group
 * `secondary`) are announced on the full visit and fetched in TWO parallel
 * follow-up requests. `flaky` fails the first time and is rescued, so the
 * `<Deferred rescue>` slot renders and the Retry button reloads just that prop.
 */
export default function Dashboard({ auth, orders, stats, secondary, flaky, plans, visible, feed, users }: Props) {
	// Scenario 38: about four requests in two seconds, each a partial naming
	// `orders` — not a full page reload.
	usePoll(500, { only: ["orders"] });

	return (
		<>
			<Head title="Dashboard" />
			<h1 data-testid="page-heading">Dashboard</h1>
			<p data-testid="auth-email-page">{auth.email}</p>
			<p data-testid="orders-total">{orders.total}</p>
			<ul data-plans data-testid="plans">
				{(plans ?? []).map((plan) => (
					<li key={plan.id}>{plan.id}</li>
				))}
			</ul>
			<button type="button" data-testid="plans-reload" onClick={() => router.reload({ only: ["plans"] })}>
				Reload plans
			</button>

			<div data-deferred-group="default">
				<Deferred data="stats" fallback={<span data-testid="stats-loading">loading</span>}>
					<p data-testid="stats">
						python revenue {stats?.revenue} calls {stats?.calls}
					</p>
				</Deferred>
			</div>

			<div data-deferred-group="secondary">
				<Deferred data="secondary" fallback={<span data-testid="secondary-loading">loading</span>}>
					<p data-testid="secondary">{secondary?.label}</p>
				</Deferred>
				<Deferred
					data="flaky"
					fallback={<span data-testid="flaky-loading">loading</span>}
					rescue={<span data-testid="flaky-rescued">rescued</span>}
				>
					<p data-rescued="flaky" data-testid="flaky">
						{flaky?.label}
					</p>
				</Deferred>
				<button
					type="button"
					data-testid="flaky-retry"
					onClick={() => router.reload({ only: ["flaky"], data: { retry: "1" } })}
				>
					Retry
				</button>
			</div>

			{/* Scenario 39: the partial for `visible` must not leave until this
			    block scrolls into view, so it sits below a tall spacer. */}
			<div style={{ height: "2000px" }} data-testid="spacer" />
			<div data-when-visible="visible">
				<WhenVisible data="visible" fallback={<span data-testid="visible-loading">loading</span>}>
					<p data-testid="visible">{visible?.seen === true ? "seen" : ""}</p>
				</WhenVisible>
			</div>

			{/* Scenario 23: two infinite scrolls, two independent page parameters. */}
			<InfiniteScroll data="feed" data-infinite-scroll="feed">
				<ul>
					{feed.data.map((item) => (
						<li key={item.id} data-feed-id={item.id}>
							{item.label}
						</li>
					))}
				</ul>
			</InfiniteScroll>
			<InfiniteScroll data="users" data-infinite-scroll="users">
				<ul>
					{users.data.map((user) => (
						<li key={user.id} data-user-id={user.id}>
							{user.name}
						</li>
					))}
				</ul>
			</InfiniteScroll>
		</>
	);
}

Dashboard.layout = layout;
