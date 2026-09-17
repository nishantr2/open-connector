import { readFile, writeFile } from "node:fs/promises";

const workerPath = "/app/worker.mjs";
let source = await readFile(workerPath, "utf8");

if (source.includes("DIRECT_SHEETS_CONTEXT_V1")) {
  console.log("DIRECT_SHEETS_CONTEXT_V1 already applied");
  process.exit(0);
}

const callOpenAIAnchor = "async function callOpenAI(state, jobId) {";
if (!source.includes(callOpenAIAnchor)) {
  throw new Error("DIRECT_SHEETS_PATCH_ANCHOR_MISSING:callOpenAI");
}

const helper = `// DIRECT_SHEETS_CONTEXT_V1\nasync function withCanonicalContext(state, jobId, callbackToken) {\n  const specs = Array.isArray(state?.input_packet?.canonical_spreadsheets) ? state.input_packet.canonical_spreadsheets : [];\n  if (!specs.length) return state;\n  const loaded = await control("context_bundle", jobId, callbackToken);\n  const bundle = loaded?.context_bundle || null;\n  if (!bundle || !Array.isArray(bundle.sources)) throw new Error("CANONICAL_CONTEXT_MISSING");\n  return {\n    ...state,\n    input_packet: {\n      ...(state.input_packet || {}),\n      canonical_context: bundle,\n      context_loaded_by: "hatchet_reasoner_direct_sheets_v1",\n    },\n  };\n}\n\n`;
source = source.replace(callOpenAIAnchor, helper + callOpenAIAnchor);

const reasoningCall = "const result = await callOpenAI(state, jobId);";
if (!source.includes(reasoningCall)) {
  throw new Error("DIRECT_SHEETS_PATCH_ANCHOR_MISSING:reasoningCall");
}
source = source.replace(
  reasoningCall,
  "const reasonerState = await withCanonicalContext(state, jobId, callbackToken); const result = await callOpenAI(reasonerState, jobId);"
);

const packetStringify = "safeStringify(inputPacket)";
if (source.includes(packetStringify)) {
  source = source.replace(packetStringify, "safeStringify(inputPacket, 120000)");
}

await writeFile(workerPath, source, "utf8");
console.log("DIRECT_SHEETS_CONTEXT_V1 applied");
