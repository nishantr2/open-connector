import { Hatchet } from "@hatchet-dev/typescript-sdk";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

const h = Hatchet.init();
const U = process.env.SUPABASE_URL;
const S = process.env.HATCHET_DISPATCH_BRIDGE_SECRET || "";
const WORKER = "ETRIBE_CLOUD_02";
if (!U) throw new Error("SUPABASE_URL missing");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function tokenFor(jobId, supplied) {
  const provided = String(supplied || "");
  if (provided) return provided;
  if (!S) throw new Error("HATCHET_DISPATCH_BRIDGE_SECRET missing");
  return createHmac("sha256", `${S}:etribe-hatchet-job-callback-v1`).update(jobId).digest("hex");
}
async function control(op, jobId, token, extra = {}) {
  const response = await fetch(`${U}/functions/v1/hatchet-control`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hatchet-job-token": token },
    body: JSON.stringify({ op, job_id: jobId, ...extra }),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.error || data?.status === "error") {
    throw new Error(`control_${op}:${String(data?.error || data?.raw || response.status).slice(0, 400)}`);
  }
  return data;
}
async function packet(jobId, token) {
  let last = "not_ready";
  for (let i = 0; i < 20; i += 1) {
    try {
      const data = await control("packet", jobId, token);
      if (data?.packet?.orchestrator_run_id) return data.packet;
      last = "missing_orchestrator_run_id";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  throw new Error(`PACKET_NOT_READY:${jobId}:${last.slice(0, 180)}`);
}

const acceptance = h.task({
  name: "etribe-cloud-acceptance-v2",
  retries: 2,
  fn: async (input) => ({ status: "ok", worker: WORKER, probe: input?.probe || "accept-v2" }),
});
const retryAcceptance = h.task({
  name: "etribe-retry-acceptance-v2",
  retries: 2,
  fn: async (input, ctx) => {
    const retryCount = ctx.retryCount();
    console.log(`RETRY_V2_ATTEMPT retry_count=${retryCount}`);
    if (retryCount === 0) throw new Error("intentional_acceptance_failure_v2");
    return { status: "ok_after_retry", worker: WORKER, probe: input?.probe || "retry-v2", retryCount };
  },
});
const idempotency = { strategy: "status", expression: "input.idempotency_key", fallbackTtlMs: 3600000 };
const cloudNoop = h.task({
  name: "etribe-cloud-noop-job-v2",
  retries: 2,
  idempotency,
  fn: async (input) => {
    const jobId = String(input?.job_id || "");
    if (!jobId) throw new Error("JOB_ID_MISSING");
    const callbackToken = tokenFor(jobId, input?.callback_token);
    const state = await packet(jobId, callbackToken);
    if (state.status === "succeeded") return state.result_ref || { status: "already_succeeded" };
    if (state.status === "dead_letter") throw new Error(`JOB_ALREADY_DEAD_LETTER:${jobId}`);
    const result = { status: "cloud_noop_success", logical_worker: WORKER, job_id: jobId, completed_at: new Date().toISOString() };
    const recorded = await control("success", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, result });
    if (recorded?.recorded !== true) throw new Error(`SUCCESS_NOT_RECORDED:${jobId}`);
    console.log(`NOOP_V2_SUCCESS job_id=${jobId} run_id=${state.orchestrator_run_id}`);
    return result;
  },
});
const driveJob = h.task({
  name: "etribe-drive-job-v2",
  retries: 2,
  idempotency,
  fn: async (input, ctx) => {
    const jobId = String(input?.job_id || "");
    if (!jobId) throw new Error("JOB_ID_MISSING");
    const callbackToken = tokenFor(jobId, input?.callback_token);
    const retryCount = ctx.retryCount();
    const state = await packet(jobId, callbackToken);
    if (state.status === "succeeded") return state.result_ref || { status: "already_succeeded" };
    if (state.status === "dead_letter") throw new Error(`JOB_ALREADY_DEAD_LETTER:${jobId}`);
    try {
      const executed = await control("execute_adapter", jobId, callbackToken);
      const result = { status: "drive_execution_success", logical_worker: "GOOGLE_DRIVE_WORKER", runtime_worker: WORKER, job_id: jobId, adapter_result: executed?.result ?? executed, completed_at: new Date().toISOString() };
      const recorded = await control("success", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, result });
      if (recorded?.recorded !== true) throw new Error(`SUCCESS_NOT_RECORDED:${jobId}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (retryCount >= 2 && state.status === "running" && !message.startsWith("SUCCESS_NOT_RECORDED")) {
        try {
          await control("failure", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, error_code: "DRIVE_ADAPTER_FAILED", error_detail: message.slice(0, 1000) });
        } catch {}
      }
      throw error;
    }
  },
});

const port = Math.max(1, Number(process.env.PORT || 3000));
createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", worker: WORKER }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(port, () => console.log(`HEALTH_V2_LISTENER port=${port}`));

async function selfTest() {
  await sleep(5000);
  try {
    const run = await acceptance.runNoWait({ probe: "railway-normal-service-v2" });
    console.log(`ACCEPTANCE_V2_PASS run_id=${await run.getWorkflowRunId()} result=${JSON.stringify(await run.result())}`);
  } catch (error) { console.error("ACCEPTANCE_V2_FAIL", error); }
  try {
    const run = await retryAcceptance.runNoWait({ probe: "railway-normal-service-retry-v2" });
    console.log(`RETRY_V2_PASS run_id=${await run.getWorkflowRunId()} result=${JSON.stringify(await run.result())}`);
  } catch (error) { console.error("RETRY_V2_FAIL", error); }
}

const slots = Math.max(1, Math.min(5, Number(process.env.HATCHET_WORKER_SLOTS || 5)));
const worker = await h.worker(WORKER, { workflows: [acceptance, retryAcceptance, cloudNoop, driveJob], slots });
console.log(`STARTING_HATCHET_WORKER name=${WORKER} slots=${slots}`);
void selfTest();
await worker.start();
