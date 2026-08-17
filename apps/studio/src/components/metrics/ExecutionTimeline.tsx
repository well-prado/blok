import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface TimelineBucket {
	bucket: string;
	total: number;
	completed: number;
	failed: number;
}

interface Props {
	data: TimelineBucket[];
}

export function ExecutionTimeline({ data }: Props) {
	const chartData = data.map((d) => ({
		...d,
		time: new Date(d.bucket).toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		}),
	}));

	const hasData = data.some((d) => d.total > 0);

	if (!hasData) {
		return (
			<div className="flex items-center justify-center h-48 text-ink-muted text-sm">
				No executions in the last 24 hours
			</div>
		);
	}

	return (
		<ResponsiveContainer width="100%" height={220}>
			<BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
				{/* Recharts takes CSS values, not classes, so tokens arrive as `var()` —
				    same mechanism the status fills below use. Tick and legend labels are
				    10-11px TEXT, so they take `ink-muted` (AA), never `ink-faint`. */}
				<CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
				<XAxis
					dataKey="time"
					tick={{ fill: "var(--color-ink-muted)", fontSize: 10 }}
					tickLine={false}
					axisLine={{ stroke: "var(--color-line-strong)" }}
					interval="preserveStartEnd"
				/>
				<YAxis
					tick={{ fill: "var(--color-ink-muted)", fontSize: 10 }}
					tickLine={false}
					axisLine={{ stroke: "var(--color-line-strong)" }}
					allowDecimals={false}
				/>
				<Tooltip
					contentStyle={{
						backgroundColor: "var(--color-overlay)",
						border: "1px solid var(--color-line-strong)",
						borderRadius: "6px",
						fontSize: "12px",
					}}
					labelStyle={{ color: "var(--color-ink-dimmed)" }}
					itemStyle={{ color: "var(--color-ink)" }}
				/>
				<Legend wrapperStyle={{ fontSize: "11px", color: "var(--color-ink-muted)" }} />
				{/* Token, not a copy — `#22c55e` here was the pre-brand green. */}
				<Bar
					dataKey="completed"
					name="Completed"
					fill="var(--color-status-completed)"
					opacity={0.7}
					radius={[2, 2, 0, 0]}
					stackId="status"
				/>
				<Bar
					dataKey="failed"
					name="Failed"
					fill="var(--color-status-failed)"
					opacity={0.7}
					radius={[2, 2, 0, 0]}
					stackId="status"
				/>
			</BarChart>
		</ResponsiveContainer>
	);
}
