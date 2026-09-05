import { runCampaign } from "./campaign";
import { serializeCampaignReport } from "./report";

const report = await runCampaign();
process.stdout.write(`${serializeCampaignReport(report)}\n`);
if (report.summary.failed > 0) process.exitCode = 1;
