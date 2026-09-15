import fs from "node:fs";

const workerPath = "/app/worker.mjs";
let source = fs.readFileSync(workerPath, "utf8");

const cloneBefore = 'await run("git", ["clone", "--depth", "1", "--branch", baseBranch, `https://github.com/${repository}.git`, cwd], root);';
const cloneAfter = `const cloneBasic = Buffer.from(\`x-access-token:\${GITHUB_TOKEN}\`).toString("base64");
    const cloneEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: \`AUTHORIZATION: basic \${cloneBasic}\` };
    await run("git", ["clone", "--depth", "1", "--branch", baseBranch, \`https://github.com/\${repository}.git\`, cwd], root, cloneEnv);`;

if (source.includes(cloneBefore)) {
  source = source.replace(cloneBefore, cloneAfter);
} else if (!source.includes("const cloneBasic = Buffer.from")) {
  throw new Error("clone_patch_target_not_found");
}

const acceptanceFunction = `
async function runCodexAcceptanceOnStartup() {
  if (process.env.RUN_CODEX_ACCEPTANCE_ON_STARTUP !== "true") return;
  await sleep(5000);
  try {
    const prepared = await bridge("codex_acceptance_prepare");
    const jobId = String(prepared?.job_id || "");
    const idempotencyKey = String(prepared?.idempotency_key || "codex-acceptance-test-v1");
    if (!jobId) throw new Error("ACCEPTANCE_PREPARE_MISSING_JOB");
    if (prepared?.reused === true && prepared?.orchestrator_run_id) {
      console.log(\`CODEX_ACCEPTANCE_ALREADY_BOUND job_id=\${jobId} run_id=\${prepared.orchestrator_run_id}\`);
      return;
    }
    if (prepared?.reused === true && prepared?.status !== "running") {
      console.log(\`CODEX_ACCEPTANCE_REUSED_TERMINAL job_id=\${jobId} status=\${prepared?.status || "unknown"}\`);
      return;
    }
    const run = await codexJob.runNoWait({ job_id: jobId, idempotency_key: idempotencyKey });
    const hatchetRunId = await run.getWorkflowRunId();
    const bound = await bridge("codex_acceptance_bind", { job_id: jobId, hatchet_run_id: hatchetRunId });
    if (bound?.bound !== true) throw new Error("ACCEPTANCE_BIND_FAILED");
    console.log(\`CODEX_ACCEPTANCE_DISPATCHED job_id=\${jobId} run_id=\${hatchetRunId} key=\${idempotencyKey}\`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(\`CODEX_ACCEPTANCE_BOOTSTRAP_ERROR error=\${message.slice(0, 500)}\`);
  }
}
`;

if (!source.includes("async function runCodexAcceptanceOnStartup()")) {
  const marker = "async function selfTest() {";
  if (!source.includes(marker)) throw new Error("self_test_marker_not_found");
  source = source.replace(marker, acceptanceFunction + "\n" + marker);
}

if (!source.includes("void runCodexAcceptanceOnStartup();")) {
  const marker = "void selfTest();\nawait worker.start();";
  if (!source.includes(marker)) throw new Error("startup_marker_not_found");
  source = source.replace(marker, "void selfTest();\nvoid runCodexAcceptanceOnStartup();\nawait worker.start();");
}

fs.writeFileSync(workerPath, source);
console.log("CODEX_ACCEPTANCE_RUNTIME_PATCH_APPLIED");
