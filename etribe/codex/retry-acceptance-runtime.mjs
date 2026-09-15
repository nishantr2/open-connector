import fs from "node:fs";

const workerPath = "/app/worker.mjs";
let source = fs.readFileSync(workerPath, "utf8");

const retryFunction = `
async function runRetryAcceptanceOnStartup() {
  if (process.env.RUN_RETRY_ACCEPTANCE_ON_STARTUP !== "true") return;
  await sleep(5000);
  try {
    const run = await retryAcceptance.runNoWait({ probe: "bounded-retry-acceptance-v1" });
    const runId = await run.getWorkflowRunId();
    console.log(\`RETRY_ACCEPTANCE_DISPATCHED run_id=\${runId}\`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(\`RETRY_ACCEPTANCE_BOOTSTRAP_ERROR error=\${message.slice(0,500)}\`);
  }
}
`;

if (!source.includes("async function runRetryAcceptanceOnStartup()")) {
  const marker = "async function selfTest() {";
  if (!source.includes(marker)) throw new Error("retry_self_test_marker_not_found");
  source = source.replace(marker, retryFunction + "\n" + marker);
}

if (!source.includes("void runRetryAcceptanceOnStartup();")) {
  const marker = "void selfTest();";
  if (!source.includes(marker)) throw new Error("retry_startup_marker_not_found");
  source = source.replace(marker, "void selfTest();\nvoid runRetryAcceptanceOnStartup();");
}

fs.writeFileSync(workerPath, source);
console.log("HATCHET_RETRY_ACCEPTANCE_RUNTIME_APPLIED");
