import HatchetClient from "@hatchet-dev/typescript-sdk";
import { createServer } from "node:http";

const hatchet = HatchetClient.init();
const supabaseUrl = process.env.SUPABASE_URL;
const workerName = "ETRIBE_CLOUD_RUNTIME_V2";
const logicalCloudWorker = "ETRIBE_CLOUD_01";

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL must be configured");
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface JobInput {
  job_id?: string;
  idempotency_key?: string;
  callback_token?: string;
}

interface ControlResponse {
  status?: string;
  error?: string;
  packet?: Record<string, unknown>;
  result?: unknown;
  recorded?: boolean;
}

async function control(
  operation: string,
  jobId: string,
  callbackToken: string,
  body: Record<string, unknown> = {},
): Promise<ControlResponse> {
  const response = await fetch(`${supabaseUrl}/functions/v1/hatchet-control`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hatchet-job-token": callbackToken,
    },
    body: JSON.stringify({ op: operation, job_id: jobId, ...body }),
  });

  const responseText = await response.text();
  let data: ControlResponse = {};
  try {
    data = responseText ? (JSON.parse(responseText) as ControlResponse) : {};
  } catch {
    data = { error: responseText || `http_${response.status}` };
  }

  if (!response.ok || data.status === "error" || data.error) {
    throw new Error(
      `control_${operation}_failed:${String(data.error || response.status).slice(0, 500)}`,
    );
  }
  return data;
}

async function waitForPacket(
  jobId: string,
  callbackToken: string,
): Promise<Record<string, any>> {
  let lastError = "packet_not_ready";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await control("packet", jobId, callbackToken);
      const packet = response.packet as Record<string, any> | undefined;
      if (packet?.orchestrator_run_id) {
        return packet;
      }
      lastError = "packet_missing_orchestrator_run_id";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  throw new Error(`JOB_PACKET_NOT_READY:${jobId}:${lastError.slice(0, 220)}`);
}

const acceptance = hatchet.task({
  name: "etribe-cloud-acceptance-v2",
  retries: 2,
  fn: async (input: { probe?: string }) => ({
    status: "ok",
    worker: workerName,
    probe: input?.probe || "cloud-acceptance-v2",
  }),
});

const retryAcceptance = hatchet.task({
  name: "etribe-retry-acceptance-v2",
  retries: 2,
  fn: async (input: { probe?: string }, context: any) => {
    const retryCount = context.retryCount();
    console.log(`RETRY_V2_ATTEMPT retry_count=${retryCount}`);
    if (retryCount === 0) {
      throw new Error("intentional_acceptance_failure_v2");
    }
    return {
      status: "ok_after_retry",
      worker: workerName,
      probe: input?.probe || "retry-acceptance-v2",
      retryCount,
    };
  },
});

const cloudNoopJob = hatchet.task({
  name: "etribe-cloud-noop-job-v2",
  retries: 2,
  idempotency: {
    strategy: "status",
    expression: "input.idempotency_key",
    fallbackTtlMs: 3_600_000,
  },
  fn: async (input: JobInput) => {
    const jobId = String(input?.job_id || "");
    const callbackToken = String(input?.callback_token || "");
    if (!jobId || !callbackToken) {
      throw new Error("JOB_ID_OR_CALLBACK_TOKEN_MISSING");
    }

    const packet = await waitForPacket(jobId, callbackToken);
    if (packet.status === "succeeded") {
      return packet.result_ref || { status: "already_succeeded" };
    }
    if (packet.status === "dead_letter") {
      throw new Error(`JOB_ALREADY_DEAD_LETTER:${jobId}`);
    }

    const result = {
      status: "cloud_noop_success",
      logical_worker: logicalCloudWorker,
      runtime_worker: workerName,
      job_id: jobId,
      completed_at: new Date().toISOString(),
    };
    const recorded = await control("success", jobId, callbackToken, {
      hatchet_run_id: packet.orchestrator_run_id,
      result,
    });
    if (recorded.recorded !== true) {
      throw new Error(`SUCCESS_NOT_RECORDED:${jobId}`);
    }
    return result;
  },
});

const driveJob = hatchet.task({
  name: "etribe-drive-job-v2",
  retries: 2,
  idempotency: {
    strategy: "status",
    expression: "input.idempotency_key",
    fallbackTtlMs: 3_600_000,
  },
  fn: async (input: JobInput, context: any) => {
    const jobId = String(input?.job_id || "");
    const callbackToken = String(input?.callback_token || "");
    if (!jobId || !callbackToken) {
      throw new Error("JOB_ID_OR_CALLBACK_TOKEN_MISSING");
    }

    const retryCount = context.retryCount();
    const packet = await waitForPacket(jobId, callbackToken);
    if (packet.status === "succeeded") {
      return packet.result_ref || { status: "already_succeeded" };
    }
    if (packet.status === "dead_letter") {
      throw new Error(`JOB_ALREADY_DEAD_LETTER:${jobId}`);
    }

    try {
      const executed = await control("execute_adapter", jobId, callbackToken);
      const result = {
        status: "drive_execution_success",
        logical_worker: "GOOGLE_DRIVE_WORKER",
        runtime_worker: workerName,
        job_id: jobId,
        adapter_result: executed.result ?? executed,
        completed_at: new Date().toISOString(),
      };
      const recorded = await control("success", jobId, callbackToken, {
        hatchet_run_id: packet.orchestrator_run_id,
        result,
      });
      if (recorded.recorded !== true) {
        throw new Error(`SUCCESS_NOT_RECORDED:${jobId}`);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        retryCount >= 2 &&
        packet.status === "running" &&
        !message.startsWith("SUCCESS_NOT_RECORDED")
      ) {
        try {
          await control("failure", jobId, callbackToken, {
            hatchet_run_id: packet.orchestrator_run_id,
            error_code: "DRIVE_ADAPTER_FAILED",
            error_detail: message.slice(0, 1000),
          });
        } catch (recordError) {
          console.error(
            `terminal_failure_record_failed job_id=${jobId}`,
            recordError instanceof Error ? recordError.message : String(recordError),
          );
        }
      }
      throw error;
    }
  },
});

const port = Math.max(1, Number(process.env.PORT || "3000"));
createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", worker: workerName }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}).listen(port, () => console.log(`HEALTH_LISTENER port=${port}`));

async function runAcceptance(): Promise<void> {
  await sleep(5_000);
  try {
    const reference = await acceptance.runNoWait({ probe: "versioned-runtime-v2" });
    const runId = await reference.getWorkflowRunId();
    const result = await reference.result();
    console.log(`ACCEPTANCE_V2_PASS run_id=${runId} result=${JSON.stringify(result)}`);
  } catch (error) {
    console.error("ACCEPTANCE_V2_FAIL", error);
  }

  try {
    const reference = await retryAcceptance.runNoWait({ probe: "versioned-runtime-retry-v2" });
    const runId = await reference.getWorkflowRunId();
    const result = await reference.result();
    console.log(`RETRY_V2_PASS run_id=${runId} result=${JSON.stringify(result)}`);
  } catch (error) {
    console.error("RETRY_V2_FAIL", error);
  }
}

const slots = Math.max(
  1,
  Math.min(5, Number(process.env.HATCHET_WORKER_SLOTS || "5")),
);
const worker = await hatchet.worker(workerName, {
  workflows: [acceptance, retryAcceptance, cloudNoopJob, driveJob],
  slots,
});

console.log(`STARTING_HATCHET_WORKER name=${workerName} slots=${slots}`);
void runAcceptance();
await worker.start();
