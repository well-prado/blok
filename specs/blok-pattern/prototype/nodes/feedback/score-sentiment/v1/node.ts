import { z } from "zod";
import { node } from "#blok";

const GOOD = ["love", "great", "good", "fast", "thanks"];
const BAD = ["hate", "slow", "broken", "bad", "refund"];

export default node({
	id: "feedback/score-sentiment@1",
	description: "Labels a piece of feedback as positive, negative or neutral.",
	input: z.object({ id: z.string(), title: z.string(), comment: z.string() }),
	output: z.object({
		id: z.string(),
		title: z.string(),
		comment: z.string(),
		sentiment: z.enum(["positive", "negative", "neutral"]),
	}),
	idempotent: true,
	run(feedback) {
		const words = feedback.comment.toLowerCase().split(/\W+/);
		const score = words.filter((w) => GOOD.includes(w)).length - words.filter((w) => BAD.includes(w)).length;
		const sentiment = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
		return { ...feedback, sentiment } as const;
	},
});
