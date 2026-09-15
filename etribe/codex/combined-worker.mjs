import { Hatchet } from "@hatchet-dev/typescript-sdk";
import { Codex } from "@openai/codex-sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const h = Hatchet.init();
const U = process.env.SUPABASE_URL;
const S = process.env.HATCHET_DISPATCH_BRIDGE_SECRET || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "medium";
const OPENAI_MAX_OUTPUT_TOKENS = Math.max(512, Math.min(16000, Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 4000)));
const OPENAI_TIMEOUT_MS = Math.max(10000, Math.min(300000, Number(process.env.OPENAI_TIMEOUT_MS || 180000)));
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.3-codex";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "medium";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const ALLOW_GITHUB_WRITE = process.env.ALLOW_GITHUB_WRITE === "true";
const CODEX_ALLOWED_REPOSITORIES = new Set(String(process.env.CODEX_ALLOWED_REPOSITORIES || "nishantr2/open-connector").split(",").map((x) => x.trim()).filter(Boolean));
const OPS_MCP_BEARER_TOKEN = process.env.OPS_MCP_BEARER_TOKEN || "";
const OPS_MCP_MAX_BODY_BYTES = Math.max(1024, Math.min(262144, Number(process.env.OPS_MCP_MAX_BODY_BYTES || 262144)));
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
  if (!response.ok || data?.error || data?.status === "error") throw new Error(`control_${op}:${String(data?.error || data?.raw || response.status).slice(0, 500)}`);
  return data;
}
async function packet(jobId, token) {
  let last = "not_ready";
  for (let i = 0; i < 20; i += 1) {
    try {
      const data = await control("packet", jobId, token);
      if (data?.packet?.orchestrator_run_id) return data.packet;
      last = "missing_orchestrator_run_id";
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await sleep(300);
  }
  throw new Error(`PACKET_NOT_READY:${jobId}:${last.slice(0, 180)}`);
}
function extractOutputText(response) {
  const chunks = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item?.content || []) if (content?.type === "output_text" && typeof content?.text === "string") chunks.push(content.text);
  }
  return chunks.join("\n").trim();
}
function safeStringify(value, max = 30000) {
  const text = JSON.stringify(value ?? {}, null, 2);
  return text.length <= max ? text : `${text.slice(0, max)}\n...TRUNCATED`;
}
async function callOpenAI(state, jobId) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_MISSING");
  const inputPacket = state?.input_packet || {};
  const model = String(inputPacket?.model || OPENAI_MODEL);
  const effort = String(inputPacket?.reasoning_effort || OPENAI_REASONING_EFFORT);
  const canonicalDrive = inputPacket?.canonical_drive_folder_url || inputPacket?.canonical_drive_url || null;
  const sourceChat = inputPacket?.source_chat_url || null;
  const prompt = [
    `JOB ID: ${jobId}`,
    `OBJECTIVE: ${String(state?.objective || "").trim()}`,
    `HUMAN GATE: ${String(state?.human_gate || "none")}`,
    `CANONICAL DRIVE: ${canonicalDrive || "not supplied"}`,
    `SOURCE CHAT: ${sourceChat || "not supplied"}`,
    "INPUT PACKET:", safeStringify(inputPacket), "",
    "Complete the bounded reasoning job. Do not claim to have used tools or private sources that were not supplied. Preserve any human approval gate. Return a concise operational answer with: summary, decision, next_actions, needs_human, and evidence_refs."
  ].join("\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: "You are the background reasoning worker for the eTribe self-running operating system. Remain bounded to the supplied job, protect irreversible human gates, and never invent tool execution, links, evidence, or external state.",
        input: prompt,
        reasoning: { effort },
        max_output_tokens: Number(inputPacket?.max_output_tokens || OPENAI_MAX_OUTPUT_TOKENS),
        store: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`OPENAI_TIMEOUT:${OPENAI_TIMEOUT_MS}`);
    throw error;
  } finally { clearTimeout(timeout); }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`OPENAI_${response.status}:${String(data?.error?.message || data?.raw || text).slice(0, 800)}`);
  const outputText = extractOutputText(data);
  if (!outputText) throw new Error("OPENAI_EMPTY_OUTPUT");
  return {
    status: "reasoning_success", logical_worker: String(state?.worker_key || "ETRIBE_REASONER_01"), runtime_worker: WORKER,
    job_id: jobId, model, response_id: data?.id || null, output_text: outputText, usage: data?.usage || null,
    canonical_drive_folder_url: canonicalDrive, source_chat_url: sourceChat, completed_at: new Date().toISOString(),
  };
}

async function run(cmd, args, cwd, env = process.env) {
  const result = await execFile(cmd, args, { cwd, env, maxBuffer: 5 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}
function normalizePath(p) { return String(p || "").replaceAll("\\", "/").replace(/^\.\//, ""); }
function pathAllowed(file, allowedPaths) {
  const f = normalizePath(file);
  return allowedPaths.some((raw) => { const a = normalizePath(raw).replace(/\/$/, ""); return f === a || f.startsWith(`${a}/`); });
}
function changedPaths(statusText) {
  return statusText.split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1)).filter(Boolean).map(normalizePath);
}
function safeBranch(jobId) { return `codex/job-${String(jobId).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12)}`; }
function githubHeaders() {
  return { authorization: `Bearer ${GITHUB_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" };
}
async function createDraftPr(repo, base, head, jobId, summary) {
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: "POST", headers: githubHeaders(),
    body: JSON.stringify({ title: `Codex job ${jobId.slice(0, 8)}`, head, base, draft: true, body: ["Automated bounded eTribe Codex job.", "", `Supabase job: ${jobId}`, "Merge is intentionally human-gated.", "", summary ? `Codex summary: ${summary.slice(0, 2000)}` : ""].join("\n") }),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`GITHUB_PR_${response.status}:${String(data?.message || data?.raw || text).slice(0, 600)}`);
  return data;
}
async function validateProfile(profile, cwd) {
  await run("git", ["diff", "--check"], cwd);
  if (!profile || profile === "git_diff_check") return { profile: "git_diff_check", passed: true };
  if (profile === "npm_test") { const out = await run("npm", ["test"], cwd); return { profile, passed: true, stdout_tail: out.stdout.slice(-3000) }; }
  if (profile === "python_pytest") { const out = await run("python", ["-m", "pytest"], cwd); return { profile, passed: true, stdout_tail: out.stdout.slice(-3000) }; }
  throw new Error(`VALIDATION_PROFILE_NOT_ALLOWED:${profile}`);
}
async function executeCodexJob(state, jobId) {
  const packetInput = state?.input_packet || {};
  const input = packetInput?.payload && typeof packetInput.payload === "object" && !Array.isArray(packetInput.payload) ? packetInput.payload : packetInput;
  if (String(input.billing_mode || "") !== "openai_api") throw new Error("BILLING_MODE_MUST_BE_OPENAI_API");
  if (input.chatgpt_fallback_forbidden !== true) throw new Error("CHATGPT_FALLBACK_MUST_BE_FORBIDDEN");
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_MISSING");
  // GitHub authority is checked before starting Codex so a missing repo credential cannot burn API tokens.
  if (!ALLOW_GITHUB_WRITE || !GITHUB_TOKEN) throw new Error("GITHUB_WRITE_NOT_CONFIGURED");
  const repository = String(input.repository || "");
  if (!repository || !CODEX_ALLOWED_REPOSITORIES.has(repository)) throw new Error(`REPOSITORY_NOT_ALLOWED:${repository || "missing"}`);
  const allowedPaths = Array.isArray(input.allowed_paths) ? input.allowed_paths.map(normalizePath).filter(Boolean) : [];
  if (!allowedPaths.length) throw new Error("ALLOWED_PATHS_REQUIRED");
  const baseBranch = String(input.base_branch || "main");
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(baseBranch)) throw new Error("INVALID_BASE_BRANCH");
  const branch = safeBranch(jobId);
  const objective = String(input.objective || state?.objective || "").trim();
  if (!objective) throw new Error("OBJECTIVE_REQUIRED");
  const root = await mkdtemp(path.join(tmpdir(), "etribe-codex-"));
  const cwd = path.join(root, "repo");
  try {
    await run("git", ["clone", "--depth", "1", "--branch", baseBranch, `https://github.com/${repository}.git`, cwd], root);
    await run("git", ["checkout", "-b", branch], cwd);
    const codex = new Codex({
      apiKey: OPENAI_API_KEY,
      env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME || "/tmp", TMPDIR: process.env.TMPDIR || "/tmp" },
      config: { show_raw_agent_reasoning: false, sandbox_workspace_write: { network_access: false } },
    });
    const thread = codex.startThread({
      model: String(input.model || CODEX_MODEL), modelReasoningEffort: String(input.reasoning_effort || CODEX_REASONING_EFFORT),
      sandboxMode: "workspace-write", workingDirectory: cwd, skipGitRepoCheck: false, networkAccessEnabled: false,
      webSearchMode: "disabled", approvalPolicy: "never",
    });
    const prompt = [
      `You are executing bounded eTribe code job ${jobId}.`, `Objective: ${objective}`, `Repository: ${repository}`, `Base branch: ${baseBranch}`,
      `You may modify ONLY these paths: ${allowedPaths.join(", ")}`,
      "Do not read, create, modify, print, or search for secrets, credentials, .env files, keychains, browser sessions, tokens, or unrelated user data.",
      "Network access is disabled. Do not attempt publishing, deployment, merging, billing changes, credential changes, or other irreversible actions.",
      "Make the smallest sufficient code change. Inspect the repository, implement the objective, and run only safe local checks that do not require network access.",
      "Do not commit, push, or open a PR yourself; the enclosing worker performs those steps after path/test validation."
    ].join("\n");
    const turn = await thread.run(prompt);
    const status = await run("git", ["status", "--porcelain"], cwd);
    const files = changedPaths(status.stdout);
    if (!files.length && input.allow_no_change !== true) throw new Error("CODEX_NO_CHANGES");
    const outside = files.filter((file) => !pathAllowed(file, allowedPaths));
    if (outside.length) throw new Error(`CODEX_PATH_VIOLATION:${outside.join(",")}`);
    const validation = await validateProfile(String(input.validation_profile || "git_diff_check"), cwd);
    if (files.length) {
      await run("git", ["config", "user.name", "eTribe Codex Worker"], cwd);
      await run("git", ["config", "user.email", "codex-worker@users.noreply.github.com"], cwd);
      await run("git", ["add", "--", ...files], cwd);
      await run("git", ["commit", "-m", `Codex: ${jobId.slice(0, 8)} bounded change`], cwd);
    }
    const commit = (await run("git", ["rev-parse", "HEAD"], cwd)).stdout.trim();
    const basic = Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64");
    const pushEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
    await run("git", ["push", "origin", branch], cwd, pushEnv);
    const pr = await createDraftPr(repository, baseBranch, branch, jobId, turn.finalResponse || "");
    return {
      status: "codex_pr_ready", logical_worker: "CODEX_GITHUB", runtime_worker: WORKER, job_id: jobId, repository, base_branch: baseBranch,
      branch, commit_sha: commit, changed_paths: files, validation, codex_model: String(input.model || CODEX_MODEL), codex_thread_id: thread.id,
      codex_usage: turn.usage || null, codex_summary: String(turn.finalResponse || "").slice(0, 6000), pr_number: pr?.number || null,
      pr_url: pr?.html_url || null, pr_draft: pr?.draft === true, human_merge_gate: true, completed_at: new Date().toISOString(),
    };
  } finally { await rm(root, { recursive: true, force: true }).catch(() => {}); }
}

const acceptance = h.task({ name: "etribe-cloud-acceptance-v2", retries: 2, fn: async (input) => ({ status: "ok", worker: WORKER, probe: input?.probe || "accept-v2" }) });
const retryAcceptance = h.task({
  name: "etribe-retry-acceptance-v2", retries: 2,
  fn: async (input, ctx) => { const retryCount = ctx.retryCount(); console.log(`RETRY_V2_ATTEMPT retry_count=${retryCount}`); if (retryCount === 0) throw new Error("intentional_acceptance_failure_v2"); return { status: "ok_after_retry", worker: WORKER, probe: input?.probe || "retry-v2", retryCount }; },
});
const idempotency = { strategy: "status", expression: "input.idempotency_key", fallbackTtlMs: 3600000 };
const cloudNoop = h.task({
  name: "etribe-cloud-noop-job-v2", retries: 2, idempotency,
  fn: async (input) => {
    const jobId = String(input?.job_id || ""); if (!jobId) throw new Error("JOB_ID_MISSING");
    const callbackToken = tokenFor(jobId, input?.callback_token); const state = await packet(jobId, callbackToken);
    if (state.status === "succeeded") return state.result_ref || { status: "already_succeeded" };
    if (state.status === "dead_letter") throw new Error(`JOB_ALREADY_DEAD_LETTER:${jobId}`);
    const result = { status: "cloud_noop_success", logical_worker: WORKER, job_id: jobId, completed_at: new Date().toISOString() };
    const recorded = await control("success", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, result });
    if (recorded?.recorded !== true) throw new Error(`SUCCESS_NOT_RECORDED:${jobId}`); return result;
  },
});
const driveJob = h.task({
  name: "etribe-drive-job-v2", retries: 2, idempotency,
  fn: async (input, ctx) => {
    const jobId = String(input?.job_id || ""); if (!jobId) throw new Error("JOB_ID_MISSING"); const callbackToken = tokenFor(jobId, input?.callback_token);
    const retryCount = ctx.retryCount(); const state = await packet(jobId, callbackToken);
    if (state.status === "succeeded") return state.result_ref || { status: "already_succeeded" };
    if (state.status === "dead_letter") throw new Error(`JOB_ALREADY_DEAD_LETTER:${jobId}`);
    try {
      const executed = await control("execute_adapter", jobId, callbackToken);
      const result = { status: "drive_execution_success", logical_worker: "GOOGLE_DRIVE_WORKER", runtime_worker: WORKER, job_id: jobId, adapter_result: executed?.result ?? executed, completed_at: new Date().toISOString() };
      const recorded = await control("success", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, result }); if (recorded?.recorded !== true) throw new Error(`SUCCESS_NOT_RECORDED:${jobId}`); return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (retryCount >= 2 && state.status === "running" && !message.startsWith("SUCCESS_NOT_RECORDED")) await control("failure", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, error_code: "DRIVE_ADAPTER_FAILED", error_detail: message.slice(0, 1000) }).catch(() => {});
      throw error;
    }
  },
});
const reasoningJob = h.task({
  name: "etribe-reasoning-job-v1", retries: 2, idempotency,
  fn: async (input, ctx) => {
    const jobId = String(input?.job_id || ""); if (!jobId) throw new Error("JOB_ID_MISSING"); const callbackToken = tokenFor(jobId, input?.callback_token);
    const retryCount = ctx.retryCount(); const state = await packet(jobId, callbackToken);
    if (state.status === "succeeded") return state.result_ref || { status: "already_succeeded" };
    if (state.status === "dead_letter") throw new Error(`JOB_ALREADY_DEAD_LETTER:${jobId}`);
    try {
      const result = await callOpenAI(state, jobId); const recorded = await control("success", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, result });
      if (recorded?.recorded !== true) throw new Error(`SUCCESS_NOT_RECORDED:${jobId}`); console.log(`REASONER_V1_SUCCESS job_id=${jobId} run_id=${state.orchestrator_run_id} model=${result.model}`); return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); console.error(`REASONER_V1_ERROR job_id=${jobId} retry_count=${retryCount} error=${message.slice(0, 500)}`);
      if (retryCount >= 2 && state.status === "running" && !message.startsWith("SUCCESS_NOT_RECORDED")) await control("failure", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, error_code: message.startsWith("OPENAI_API_KEY_MISSING") ? "OPENAI_API_KEY_MISSING" : "REASONER_FAILED", error_detail: message.slice(0, 1000) }).catch(() => {});
      throw error;
    }
  },
});
const codexJob = h.task({
  name: "etribe-codex-github-job-v1", retries: 1, idempotency: { strategy: "status", expression: "input.idempotency_key", fallbackTtlMs: 6 * 60 * 60 * 1000 },
  fn: async (input, ctx) => {
    const jobId = String(input?.job_id || ""); if (!jobId) throw new Error("JOB_ID_MISSING"); const callbackToken = tokenFor(jobId, input?.callback_token); const state = await packet(jobId, callbackToken);
    if (state.status === "succeeded") return state.result_ref || { status: "already_succeeded" };
    if (state.status === "dead_letter") throw new Error(`JOB_ALREADY_DEAD_LETTER:${jobId}`);
    try {
      const result = await executeCodexJob(state, jobId); const recorded = await control("success", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, result });
      if (recorded?.recorded !== true) throw new Error(`SUCCESS_NOT_RECORDED:${jobId}`); console.log(`CODEX_SUCCESS job_id=${jobId} pr=${result.pr_number || "none"}`); return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); console.error(`CODEX_ERROR job_id=${jobId} retry_count=${ctx.retryCount()} error=${message.slice(0, 500)}`);
      if (ctx.retryCount() >= 1 && state.status === "running" && !message.startsWith("SUCCESS_NOT_RECORDED")) await control("failure", jobId, callbackToken, { hatchet_run_id: state.orchestrator_run_id, error_code: message.split(":")[0].slice(0, 120) || "CODEX_WORKER_FAILED", error_detail: message.slice(0, 1000) }).catch(() => {});
      throw error;
    }
  },
});

const port = Math.max(1, Number(process.env.PORT || 3000));
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
function json(res, status, body) { res.writeHead(status, JSON_HEADERS); res.end(JSON.stringify(body)); }
function safeTokenMatch(candidate) {
  if (!OPS_MCP_BEARER_TOKEN || !candidate) return false;
  const expected = createHmac("sha256", "etribe-ops-mcp-v1").update(OPS_MCP_BEARER_TOKEN).digest();
  const actual = createHmac("sha256", "etribe-ops-mcp-v1").update(candidate).digest();
  return timingSafeEqual(expected, actual);
}
function requestBearer(req) {
  const auth = String(req.headers.authorization || "");
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > OPS_MCP_MAX_BODY_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new Error("INVALID_JSON"); }
}
async function bridge(action, body = {}) {
  if (!S) throw new Error("HATCHET_DISPATCH_BRIDGE_SECRET_MISSING");
  const response = await fetch(`${U}/functions/v1/hatchet-dispatch-bridge`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-secret": S },
    body: JSON.stringify({ ...body, action }),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.error || data?.status === "error") throw new Error(`BRIDGE_${action}:${String(data?.error || data?.raw || response.status).slice(0, 500)}`);
  return data;
}
const MCP_TOOLS = [
  { name: "capabilities_list", title: "List eTribe capabilities", description: "Read enabled, disabled, blocked, and acceptance state for registered eTribe workers and Hatchet routes.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "work_submit", title: "Submit bounded eTribe work", description: "Submit a bounded job through the existing Supabase resolver and Hatchet control plane. Disabled or unaccepted capabilities fail closed.", inputSchema: { type: "object", properties: { target: { type: "string" }, action: { type: "string" }, payload: { type: "object" }, idempotency_key: { type: "string" }, project_key: { type: "string" }, company_id: { type: "string" }, property_id: { type: ["string", "null"] } }, required: ["target", "action", "payload", "idempotency_key"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "work_status", title: "Get eTribe work status", description: "Read status, result, evidence, and next action for one submitted job.", inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];
function toolResult(output, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output, isError };
}
async function handleMcp(message) {
  const id = message?.id ?? null;
  if (message?.jsonrpc !== "2.0" || typeof message?.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  if (message.method === "notifications/initialized") return null;
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "etribe-ops-gateway", version: "1.0.0" }, instructions: "Use capabilities_list before work_submit. Disabled or unaccepted capabilities fail closed. Responses contain STATUS, RESULT, EVIDENCE, and NEXT." } };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  if (message.method !== "tools/call") return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  const name = String(message?.params?.name || "");
  const args = message?.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
  try {
    let output;
    if (name === "capabilities_list") output = await bridge("capabilities");
    else if (name === "work_submit") output = await bridge("submit", { ...args, job_action: args.action });
    else if (name === "work_status") output = await bridge("job_status", args);
    else return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } };
    return { jsonrpc: "2.0", id, result: toolResult(output, false) };
  } catch (error) {
    const output = { STATUS: "ERROR", RESULT: null, EVIDENCE: { error: error instanceof Error ? error.message : String(error) }, NEXT: "Inspect capability state and correct the failed gate before retrying." };
    return { jsonrpc: "2.0", id, result: toolResult(output, true) };
  }
}
function healthBody() {
  return { status: "ok", worker: WORKER, gateway: "etribe-ops-mcp-v1", openai_configured: Boolean(OPENAI_API_KEY), openai_model: OPENAI_MODEL, codex_registered: true, codex_model: CODEX_MODEL, codex_github_write_configured: Boolean(GITHUB_TOKEN && ALLOW_GITHUB_WRITE), codex_chatgpt_credit_path: false };
}
function readyBody() {
  const gates = { supabase_url: Boolean(U), bridge_secret: Boolean(S), mcp_auth: Boolean(OPS_MCP_BEARER_TOKEN), openai_api: Boolean(OPENAI_API_KEY), github_write: Boolean(GITHUB_TOKEN && ALLOW_GITHUB_WRITE), dedicated_repo_allowed: CODEX_ALLOWED_REPOSITORIES.has("nishantr2/etribe-ops") };
  return { status: Object.values(gates).every(Boolean) ? "ready" : "not_ready", gates };
}
createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (req.method === "GET" && (pathname === "/health" || pathname === "/healthz")) return json(res, 200, healthBody());
  if (req.method === "GET" && pathname === "/readyz") { const body = readyBody(); return json(res, body.status === "ready" ? 200 : 503, body); }
  if (pathname !== "/mcp") return json(res, 404, { error: "not_found" });
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!safeTokenMatch(requestBearer(req))) return json(res, 401, { error: "unauthorized" });
  try {
    const reply = await handleMcp(await readJsonBody(req));
    if (reply === null) { res.writeHead(204, { "cache-control": "no-store" }); return res.end(); }
    return json(res, 200, reply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(res, message === "PAYLOAD_TOO_LARGE" ? 413 : 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message } });
  }
}).listen(port, () => console.log(`HEALTH_V4_MCP_LISTENER port=${port}`));
async function selfTest() {
  if (process.env.RUN_STARTUP_SELF_TEST !== "true") return; await sleep(5000);
  try { const run = await acceptance.runNoWait({ probe: "railway-normal-service-v3" }); console.log(`ACCEPTANCE_V3_PASS run_id=${await run.getWorkflowRunId()} result=${JSON.stringify(await run.result())}`); } catch (error) { console.error("ACCEPTANCE_V3_FAIL", error); }
  try { const run = await retryAcceptance.runNoWait({ probe: "railway-normal-service-retry-v3" }); console.log(`RETRY_V3_PASS run_id=${await run.getWorkflowRunId()} result=${JSON.stringify(await run.result())}`); } catch (error) { console.error("RETRY_V3_FAIL", error); }
}
const slots = Math.max(1, Math.min(5, Number(process.env.HATCHET_WORKER_SLOTS || 5)));
const worker = await h.worker(WORKER, { workflows: [acceptance, retryAcceptance, cloudNoop, driveJob, reasoningJob, codexJob], slots });
console.log(`STARTING_HATCHET_WORKER name=${WORKER} slots=${slots} openai_configured=${Boolean(OPENAI_API_KEY)} codex_registered=true codex_github_write=${Boolean(GITHUB_TOKEN && ALLOW_GITHUB_WRITE)} codex_model=${CODEX_MODEL}`);
void selfTest();
await worker.start();
