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
			<div className="flex items-center justify-center h-48 text-zinc-600 text-sm">
				No executions in the last 24 hours
			</div>
		);
	}

	return (
		<ResponsiveContainer width="100%" height={220}>
			<BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
				<CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
				<XAxis
					dataKey="time"
					tick={{ fill: "#71717a", fontSize: 10 }}
					tickLine={false}
					axisLine={{ stroke: "#3f3f46" }}
					interval="preserveStartEnd"
				/>
				<YAxis
					tick={{ fill: "#71717a", fontSize: 10 }}
					tickLine={false}
					axisLine={{ stroke: "#3f3f46" }}
					allowDecimals={false}
				/>
				<Tooltip
					contentStyle={{
						backgroundColor: "#18181b",
						border: "1px solid #3f3f46",
						borderRadius: "6px",
						fontSize: "12px",
					}}
					labelStyle={{ color: "#a1a1aa" }}
					itemStyle={{ color: "#d4d4d8" }}
				/>
				<Legend wrapperStyle={{ fontSize: "11px", color: "#71717a" }} />
				<Bar dataKey="completed" name="Completed" fill="#22c55e" opacity={0.7} radius={[2, 2, 0, 0]} stackId="status" />
				<Bar dataKey="failed" name="Failed" fill="#ef4444" opacity={0.7} radius={[2, 2, 0, 0]} stackId="status" />
			</BarChart>
		</ResponsiveContainer>
	);
}
