import fs from "node:fs";

const workerPath = "/app/worker.mjs";
let source = fs.readFileSync(workerPath, "utf8");

const oldTaskName = 'name: "etribe-retry-acceptance-v2"';
const newTaskName = 'name: "etribe-retry-acceptance-v3"';
if (source.includes(oldTaskName)) source = source.replace(oldTaskName, newTaskName);
else if (!source.includes(newTaskName)) throw new Error("retry_v3_task_name_patch_target_not_found");

const runner = `
async function runRetryAcceptanceV3OnStartup() {
  if (process.env.RUN_RETRY_ACCEPTANCE_ON_STARTUP !== "true") return;
  await sleep(7000);
  try {
    const run = await retryAcceptance.runNoWait({ probe: "bounded-retry-acceptance-v3" });
    const runId = await run.getWorkflowRunId();
    console.log(\`RETRY_V3_DISPATCHED run_id=\${runId}\`);
    const result = await run.result();
    console.log(\`RETRY_V3_PASS run_id=\${runId} result=\${JSON.stringify(result)}\`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(\`RETRY_V3_FAIL error=\${message.slice(0, 500)}\`);
  }
}
`;

if (!source.includes("async function runRetryAcceptanceV3OnStartup()")) {
  const marker = "async function selfTest() {";
  if (!source.includes(marker)) throw new Error("retry_v3_self_test_marker_not_found");
  source = source.replace(marker, runner + "\n" + marker);
}

if (!source.includes("void runRetryAcceptanceV3OnStartup();")) {
  const marker = "void selfTest();";
  if (!source.includes(marker)) throw new Error("retry_v3_startup_marker_not_found");
  source = source.replace(marker, "void selfTest();\nvoid runRetryAcceptanceV3OnStartup();");
}

fs.writeFileSync(workerPath, source);
console.log("HATCHET_RETRY_ACCEPTANCE_V3_RUNTIME_APPLIED");
