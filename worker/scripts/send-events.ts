// Usage (from worker/): WEBHOOK_URL=http://localhost:8787/webhooks/app WEBHOOK_SECRET=<your secret> npm run send-events
// Sends one signed scenario of app events to the webhook and prints one line per request: a label and the status code.
import { sign } from "../src/webhook/sign";
import { buildScenario, formatResult, PRIMARY_USER, SECOND_USER } from "./lib/scenario";

async function main(): Promise<void> {
	const url = process.env.WEBHOOK_URL;
	const secret = process.env.WEBHOOK_SECRET;
	if (!url || !secret) {
		console.error("Set WEBHOOK_URL (for example http://localhost:8787/webhooks/app) and WEBHOOK_SECRET in the environment.");
		process.exitCode = 1;
		return;
	}

	const runId = Date.now().toString(36);
	console.log("Run " + runId + ". Afterwards, look up " + PRIMARY_USER + " on the Lookup page. User " + SECOND_USER + " logs in later on the same device.");

	let failures = 0;
	for (const step of buildScenario(runId, Date.now())) {
		const body = JSON.stringify(step.body);
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = await sign(secret, timestamp, body);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-TPO-Timestamp": timestamp, "X-TPO-Signature": signature },
				body,
			});
			console.log(formatResult(step.label, response.status, await response.text()));
			if (response.status !== 200) failures += 1;
		} catch {
			console.log(`${step.label}: request failed`);
			failures += 1;
		}
	}
	if (failures > 0) process.exitCode = 1;
}

main().catch(() => {
	console.error("send-events failed");
	process.exitCode = 1;
});
