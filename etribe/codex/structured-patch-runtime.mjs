import fs from "node:fs";

const workerPath = "/app/worker.mjs";
let source = fs.readFileSync(workerPath, "utf8");

const cloneBefore = 'await run("git", ["clone", "--depth", "1", "--branch", baseBranch, `https://github.com/${repository}.git`, cwd], root);';
const cloneAfter = `const cloneBasic = Buffer.from(\`x-access-token:\${GITHUB_TOKEN}\`).toString("base64");
    const cloneEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: \`AUTHORIZATION: basic \${cloneBasic}\` };
    await run("git", ["clone", "--depth", "1", "--branch", baseBranch, \`https://github.com/\${repository}.git\`, cwd], root, cloneEnv);`;
if (source.includes(cloneBefore)) source = source.replace(cloneBefore, cloneAfter);
else if (!source.includes("const cloneBasic = Buffer.from")) throw new Error("clone_patch_target_not_found");

const startMarker = '    const codex = new Codex({';
const endMarker = '    const status = await run("git", ["status", "--porcelain"], cwd);';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) throw new Error("structured_patch_target_not_found");

const replacement = `    const tree = (await run("git", ["ls-files"], cwd)).stdout.split("\\n").filter(Boolean).slice(0, 4000);
    const contextParts = [];
    let contextBytes = 0;
    for (const file of tree) {
      if (!pathAllowed(file, allowedPaths)) continue;
      if (contextBytes > 180000) break;
      try {
        const { readFile } = await import("node:fs/promises");
        const text = await readFile(path.join(cwd, file), "utf8");
        if (text.includes("\\u0000")) continue;
        const clipped = text.slice(0, 30000);
        contextParts.push(\`--- FILE: \${file} ---\\n\${clipped}\`);
        contextBytes += Buffer.byteLength(clipped, "utf8");
      } catch {}
    }
    const patchPrompt = [
      \`You are executing bounded eTribe code job \${jobId}.\`,
      \`Objective: \${objective}\`,
      \`Repository: \${repository}\`,
      \`Base branch: \${baseBranch}\`,
      \`You may propose changes ONLY to these paths: \${allowedPaths.join(", ")}\`,
      "Return the smallest sufficient edit. Do not propose any path outside the allowed list.",
      "Do not request shell access, network access, credentials, secrets, deployment, publishing, merging, billing changes, or irreversible actions.",
      "For each changed file return the COMPLETE final UTF-8 text content, not a diff. If a file is new, return its complete new content.",
      "Repository tracked-file list follows:", tree.join("\\n"),
      contextParts.length ? "Relevant current file contents follow:" : "No existing allowed-path file content is present; create the required file if the objective requires it.",
      ...contextParts,
    ].join("\\n\\n");
    const patchSchema = {
      type: "object", additionalProperties: false,
      properties: {
        summary: { type: "string" },
        changes: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } }
      },
      required: ["summary", "changes"]
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(OPENAI_TIMEOUT_MS, 240000));
    let patchResponse;
    try {
      patchResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: \`Bearer \${OPENAI_API_KEY}\`, "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: String(input.model || CODEX_MODEL),
          input: patchPrompt,
          reasoning: { effort: String(input.reasoning_effort || CODEX_REASONING_EFFORT) },
          max_output_tokens: Math.max(512, Math.min(12000, Number(input.max_output_tokens || 4096))),
          store: false,
          text: { format: { type: "json_schema", name: "bounded_patch", strict: true, schema: patchSchema }, verbosity: "low" }
        })
      });
    } finally { clearTimeout(timer); }
    const patchRaw = await patchResponse.text();
    let patchData;
    try { patchData = patchRaw ? JSON.parse(patchRaw) : {}; } catch { throw new Error(\`OPENAI_RESPONSE_INVALID_JSON:\${patchRaw.slice(0,400)}\`); }
    if (!patchResponse.ok) throw new Error(\`OPENAI_RESPONSE_\${patchResponse.status}:\${String(patchData?.error?.message || patchRaw).slice(0,600)}\`);
    const outputText = String(patchData?.output_text || (patchData?.output || []).flatMap((item) => item?.content || []).filter((c) => c?.type === "output_text").map((c) => c?.text || "").join("\\n") || "").trim();
    if (!outputText) throw new Error("STRUCTURED_PATCH_EMPTY_OUTPUT");
    let patch;
    try { patch = JSON.parse(outputText); } catch { throw new Error(\`STRUCTURED_PATCH_PARSE_FAILED:\${outputText.slice(0,500)}\`); }
    const proposed = Array.isArray(patch?.changes) ? patch.changes : [];
    if (!proposed.length) throw new Error("STRUCTURED_PATCH_NO_CHANGES");
    const seen = new Set();
    const { mkdir, writeFile } = await import("node:fs/promises");
    for (const change of proposed) {
      const file = normalizePath(change?.path);
      if (!file || file.startsWith("../") || path.isAbsolute(file) || !pathAllowed(file, allowedPaths)) throw new Error(\`STRUCTURED_PATCH_PATH_VIOLATION:\${file || "missing"}\`);
      if (seen.has(file)) throw new Error(\`STRUCTURED_PATCH_DUPLICATE_PATH:\${file}\`);
      seen.add(file);
      const content = String(change?.content ?? "");
      if (Buffer.byteLength(content, "utf8") > 500000) throw new Error(\`STRUCTURED_PATCH_FILE_TOO_LARGE:\${file}\`);
      const target = path.join(cwd, file);
      const resolved = path.resolve(target);
      const rootResolved = path.resolve(cwd) + path.sep;
      if (!resolved.startsWith(rootResolved)) throw new Error(\`STRUCTURED_PATCH_ESCAPE:\${file}\`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const turn = { finalResponse: String(patch?.summary || "structured patch applied"), usage: patchData?.usage || null };
    const thread = { id: String(patchData?.id || "responses-structured-patch") };
`;

source = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(workerPath, source);
console.log("CODEX_STRUCTURED_PATCH_RUNTIME_APPLIED");
