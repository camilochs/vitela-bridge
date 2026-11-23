// The port passes to the current bridge. A bridge of an earlier version
// holds the port with two earlier sessions attached and a current one beside
// them; the old hub's process ends. The current bridge must be the one that
// binds the port, with the same pairing code; the earlier sessions must
// attach to it and keep working; the tab, which reconnects on its own, must
// be told that requests are taken and have one routed without choosing.
//   node tests/handover.mjs        (OLD=<commit> picks the earlier version, default 0c200fc; BRIDGE=path runs another current one)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { execSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const PORT = 4396, CODE = "246802";
const here = new URL("..", import.meta.url).pathname;
const OLD = `${here}tests/.earlier-bridge.mjs`;
writeFileSync(OLD, execSync(`git -C ${here} show ${process.env.OLD ?? "0c200fc"}:server.mjs`));
const env = { ...process.env, VITELA_BRIDGE_PORT: String(PORT), VITELA_BRIDGE_CODE: CODE, VITELA_BRIDGE_HOST: "127.0.0.1", VITELA_BRIDGE_CERT: "", VITELA_BRIDGE_KEY: "" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function session(name, file) {
  const heard = [];
  const client = new Client({ name, version: "1" });
  client.fallbackNotificationHandler = async (n) => { if (n.method === "notifications/claude/channel") heard.push(n.params); };
  const transport = new StdioClientTransport({ command: process.execPath, args: [file], env, stderr: "ignore" });
  await client.connect(transport);
  return { client, heard, pid: transport.pid };
}
const textOf = (r) => r.content.map((c) => c.text).join("");
const status = async (s) => JSON.parse(textOf(await s.client.callTool({ name: "bridge_status", arguments: {} })));
const checks = [];
const check = (label, ok) => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${label}`); };

const oldHub = await session("old-hub", OLD); await wait(1200);
const oldA = await session("old-a", OLD);
const oldB = await session("old-b", OLD);
const current = await session("current", process.env.BRIDGE ?? `${here}server.mjs`); await wait(1500);

// A tab that behaves as Vitela's: it pairs, answers calls, and comes back by itself.
const seen = { paired: [], replies: [], calls: 0 };
let tab;
function openTab() {
  tab = new WebSocket(`ws://127.0.0.1:${PORT}`);
  tab.on("open", () => tab.send(JSON.stringify({ type: "pair", code: CODE, project: "p-paper" })));
  tab.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "paired") seen.paired.push(msg);
    if (msg.type === "ask-sent" || msg.type === "ask-refused") seen.replies.push(msg);
    if (msg.type === "call") { seen.calls++; tab.send(JSON.stringify({ type: "result", id: msg.id, ok: true, value: [{ id: "p-paper", name: "paper" }] })); }
  });
  tab.on("close", () => setTimeout(openTab, 300));
  tab.on("error", () => {});
}
openTab(); await wait(600);
check("before: the earlier hub holds the port and does not say it takes requests", (await status(oldHub)).role === "the shared bridge" && seen.paired.at(-1)?.asks !== true);
check("before: the current bridge is attached to it", /attached/.test((await status(current)).role));

process.kill(oldHub.pid, "SIGTERM");
await wait(4000);
const after = await status(current);
check("after: the current bridge holds the port", after.role === "the shared bridge");
check("after: the pairing code is the same", after.code === CODE);
check("after: both earlier sessions are attached to it", (after.sessions ?? []).length === 3 && /attached/.test((await status(oldA)).role) && /attached/.test((await status(oldB)).role));
check("after: the tab came back and is told requests are taken", seen.paired.at(-1)?.asks === true);
const calls = seen.calls;
const listed = textOf(await oldA.client.callTool({ name: "projects_list", arguments: {} }));
check("after: an earlier session's tool call reaches the tab", seen.calls === calls + 1 && /p-paper/.test(listed));
tab.send(JSON.stringify({ type: "ask", id: "h1", file: "main.xtex", text: "a sentence", request: "shorter" }));
await wait(600);
check("after: a request goes to the one session that can take it, without choosing", seen.replies.at(-1)?.type === "ask-sent" && current.heard.some((p) => p.meta?.request_id === "h1" && /project p-paper/.test(p.content)));

tab.removeAllListeners("close"); tab.close();
for (const s of [oldA, oldB, current]) await s.client.close();
rmSync(OLD);
const failed = checks.filter((ok) => !ok).length;
console.log(failed ? `RED: ${failed} of ${checks.length} checks failed` : `GREEN: ${checks.length} checks`);
process.exit(failed ? 1 : 0);
