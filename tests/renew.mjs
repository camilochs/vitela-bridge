// The bridge renews itself. Two sessions run a copy of the bridge outside any
// git checkout: one holds the port, the other is attached, with a paper open
// and a request waiting. The file on disk changes — first to something that
// does not load, then to a version with one more tool. Nothing may happen
// for the first. For the second, each process must replace its own image:
// same pid, same connection to its client, the client told the tools
// changed, the new tool callable, the waiting request and the paper kept,
// and the tab, which reconnects on its own, paired again with the same code.
//   node tests/renew.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 4397, CODE = "975310";
const here = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "vitela-bridge-renew-"));
const SERVER = join(dir, "server.mjs");
const original = readFileSync(`${here}server.mjs`, "utf8");
writeFileSync(SERVER, original);
symlinkSync(`${here}node_modules`, join(dir, "node_modules"));
const env = { ...process.env, VITELA_BRIDGE_PORT: String(PORT), VITELA_BRIDGE_CODE: CODE, VITELA_BRIDGE_HOST: "127.0.0.1", VITELA_BRIDGE_CERT: "", VITELA_BRIDGE_KEY: "", VITELA_BRIDGE_WATCH_MS: "300" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await wait(250); } return false; }

async function session(name) {
  const heard = [];
  const client = new Client({ name, version: "1" });
  client.fallbackNotificationHandler = async (n) => { heard.push(n.method); };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" });
  await client.connect(transport);
  return { client, heard, pid: transport.pid };
}
const textOf = (r) => r.content.map((c) => c.text).join("");
const status = async (s) => JSON.parse(textOf(await s.client.callTool({ name: "bridge_status", arguments: {} })));
const toolNames = async (s) => (await s.client.listTools()).tools.map((t) => t.name);
const checks = [];
const check = (label, ok) => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${label}`); };

const hub = await session("hub-session"); await wait(1000);
const other = await session("other-session"); await wait(1200);

const seen = { paired: 0, rows: [], calls: 0 };
let tab;
function openTab() {
  tab = new WebSocket(`ws://127.0.0.1:${PORT}`);
  tab.on("open", () => tab.send(JSON.stringify({ type: "pair", code: CODE, project: "p-paper" })));
  tab.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "paired") seen.paired++;
    if (msg.type === "sessions") seen.rows = msg.list;
    if (msg.type === "call") { seen.calls++; tab.send(JSON.stringify({ type: "result", id: msg.id, ok: true, value: [{ id: "p-paper", name: "paper" }] })); }
  });
  tab.on("close", () => setTimeout(openTab, 300));
  tab.on("error", () => {});
}
openTab(); await wait(500);
await other.client.callTool({ name: "project_open", arguments: { id: "p-paper" } });
tab.send(JSON.stringify({ type: "ask", id: "r1", file: "main.xtex", text: "a sentence", request: "kept across a renewal" }));
await wait(400);
const before = { hub: await status(hub), other: await status(other) };
check("before: one build on both, the request waits in the attached session", before.hub.build === before.other.build && /kept across a renewal/.test(textOf(await other.client.callTool({ name: "requests_list", arguments: {} }))));

// A file that does not load is never loaded into a running session.
writeFileSync(SERVER, original + "\nthis is not javascript (\n");
await wait(6000);
const stuck = await status(other);
check("a file that does not load: the bridge stays on its own build and says so", stuck.build === before.other.build && /does not load/.test(stuck.newer ?? "") && !other.heard.includes("notifications/tools/list_changed"));

// A version with one more tool.
const held = other.client.callTool({ name: "requests_wait", arguments: { seconds: 50 } });
const marker = `server.registerTool("renewed_marker", { description: "Present only in the newer bridge.", inputSchema: {} }, async () => text("answered by the newer code"));\n`;
const next = original.replace("if (PROBE) process.exit(0);", marker + "if (PROBE) process.exit(0);");
if (next === original) throw new Error("the test could not place its marker tool");
const t0 = Date.now();
writeFileSync(SERVER, next);
check("a held requests_wait returns, so the renewal can happen", await Promise.race([held.then(() => true), wait(15000).then(() => false)]));
check("the attached session is told its tools changed", await until(() => other.heard.includes("notifications/tools/list_changed"), 80000));
check("the session that holds the port is told too, after the attached one", await until(() => hub.heard.includes("notifications/tools/list_changed"), 60000));
console.log(`    (both renewed ${Math.round((Date.now() - t0) / 1000)} s after the file changed)`);
await wait(2500);
const after = { hub: await status(hub), other: await status(other) };
check("both run the new build, in the same processes", after.hub.build === after.other.build && after.hub.build !== before.hub.build && after.hub.me === before.hub.me && after.other.me === before.other.me);
check("the new tool is listed and answers on the connection each client already had", (await toolNames(other)).includes("renewed_marker") && (await toolNames(hub)).includes("renewed_marker") && /newer code/.test(textOf(await other.client.callTool({ name: "renewed_marker", arguments: {} }))));
check("the waiting request is still there", /kept across a renewal/.test(textOf(await other.client.callTool({ name: "requests_list", arguments: {} }))));
check("the tab paired again with the same code", seen.paired >= 2 && after.hub.code === CODE);
const row = seen.rows.find((r) => r.id === before.other.me);
check("the attached session kept its name and its tab", row?.name === "other-session 1" && row?.here === true && row?.paper === "p-paper");
const calls = seen.calls;
await other.client.callTool({ name: "projects_list", arguments: {} });
check("its tool calls reach the tab", seen.calls === calls + 1);

tab.removeAllListeners("close"); tab.close();
await other.client.close(); await hub.client.close();
rmSync(dir, { recursive: true, force: true });
const failed = checks.filter((ok) => !ok).length;
console.log(failed ? `RED: ${failed} of ${checks.length} checks failed` : `GREEN: ${checks.length} checks`);
process.exit(failed ? 1 : 0);
