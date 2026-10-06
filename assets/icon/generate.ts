// Generates icon candidates through the CanaryLLM gateway.
// bun assets/icon/generate.ts <prompt-key> [count] [provider/model]
// The key is read from ~/.claude/secrets/canaryllm-api-key. Outputs land in
// assets/icon/candidates/<key>/, which is not committed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.CANARYLLM_BASE_URL ?? "https://canaryllm.canarycoders.es";
const KEY = readFileSync(join(homedir(), ".claude/secrets/canaryllm-api-key"), "utf8").trim();
const prompts = JSON.parse(readFileSync(join(import.meta.dir, "prompts.json"), "utf8")) as Record<string, string>;

const [key, countArg, modelArg] = process.argv.slice(2);
const prompt = prompts[key!];
if (!prompt) throw new Error(`unknown prompt key ${key}; have ${Object.keys(prompts).join(", ")}`);
const [provider, model] = (modelArg ?? "gemini/gemini-3-pro-image").split("/");
const n = Number(countArg ?? 2);

async function call(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const submit = await (await call("/api/llm/generate-image", {
  provider, model, prompt, n, size: "1024x1024", aspectRatio: "1:1", quality: "hd", tag: "lynk-icon",
  ...(process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {}),
})).json() as { data?: { queueId?: string } };
const queueId = submit.data?.queueId;
if (!queueId) throw new Error(`submit failed: ${JSON.stringify(submit).slice(0, 400)}`);

const deadline = Date.now() + 10 * 60_000;
let result: any;
while (Date.now() < deadline) {
  const res = await call("/api/llm/queue/result", { queueId });
  const body = await res.json() as any;
  if (res.status === 200 && body.data?.status === "completed") { result = body.data.result; break; }
  if (res.status !== 202) throw new Error(JSON.stringify(body).slice(0, 600));
  await Bun.sleep(3000);
}
if (!result) throw new Error("timed out");

const out = join(import.meta.dir, "candidates", key!);
mkdirSync(out, { recursive: true });
const images: any[] = result.images ?? result.data ?? (Array.isArray(result) ? result : [result]);
const stamp = Date.now().toString(36);
let i = 0;
for (const img of images) {
  const b64 = img.b64_json ?? img.base64 ?? img.data ?? (typeof img === "string" && !img.startsWith("http") ? img : undefined);
  const url = img.url ?? (typeof img === "string" && img.startsWith("http") ? img : undefined);
  const bytes = b64
    ? Buffer.from(String(b64).replace(/^data:[^,]+,/, ""), "base64")
    : url ? Buffer.from(await (await fetch(url)).arrayBuffer()) : undefined;
  if (!bytes) { console.log("unrecognised image entry", JSON.stringify(img).slice(0, 200)); continue; }
  const file = join(out, `${model}-${stamp}-${i++}.${bytes[0] === 0xff ? "jpg" : "png"}`);
  writeFileSync(file, bytes);
  console.log(file);
}
