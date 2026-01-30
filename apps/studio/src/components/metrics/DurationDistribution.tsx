import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface DistributionBucket {
	range: string;
	count: number;
}

interface Props {
	data: DistributionBucket[];
}

export function DurationDistribution({ data }: Props) {
	const hasData = data.some((d) => d.count > 0);

	if (!hasData) {
		return (
			<div className="flex items-center justify-center h-48 text-zinc-600 text-sm">No duration data available</div>
		);
	}

	return (
		<ResponsiveContainer width="100%" height={220}>
			<BarChart data={data} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
				<CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
				<XAxis
					dataKey="range"
					tick={{ fill: "#71717a", fontSize: 10 }}
					tickLine={false}
					axisLine={{ stroke: "#3f3f46" }}
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
					formatter={(value: number) => [`${value} runs`, "Count"]}
				/>
				<Bar dataKey="count" fill="#3b82f6" opacity={0.7} radius={[4, 4, 0, 0]} />
			</BarChart>
		</ResponsiveContainer>
	);
}
