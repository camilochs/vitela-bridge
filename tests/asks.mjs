// The author's requests reach the right session: a tab sends a request about
// selected text and a rejection with a comment; the session that works on
// that tab hears both as channel notifications and finds them in
// requests_list, and a proposal that names a request takes it off the list.
// Two sessions share the bridge, so the test also checks that the request
// goes to the session the tab chose, not to the other one.
//   node tests/asks.mjs     (BRIDGE=path/to/another/server.mjs runs it against that one)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const PORT = 4394, CODE = "135791";
const SERVER = process.env.BRIDGE ?? new URL("../server.mjs", import.meta.url).pathname;
const env = { ...process.env, VITELA_BRIDGE_PORT: String(PORT), VITELA_BRIDGE_CODE: CODE, VITELA_BRIDGE_HOST: "127.0.0.1" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(name) {
  const heard = [];
  const client = new Client({ name, version: "1" });
  client.fallbackNotificationHandler = async (n) => { if (n.method === "notifications/claude/channel") heard.push(n.params); };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" }));
  return { client, heard, name };
}
const textOf = (r) => r.content.map((c) => c.text).join("");
const checks = [];
const check = (label, ok) => { checks.push([label, ok]); console.log(`${ok ? "ok  " : "FAIL"} ${label}`); };

const hub = await session("hub-session");
await wait(1200);
const other = await session("other-session");
await wait(1500);

// A fake tab: pairs, answers every call with a card id, records the sessions.
let rows = [], paired = null;
const replies = [];
const tab = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => tab.on("open", r));
tab.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === "sessions") rows = msg.list;
  if (msg.type === "paired") paired = msg;
  if (msg.type === "ask-sent" || msg.type === "ask-refused") replies.push(msg);
  if (msg.type === "call") tab.send(JSON.stringify({ type: "result", id: msg.id, ok: true, value: { id: "change:shorter", file: "main.xtex" } }));
});
tab.send(JSON.stringify({ type: "pair", code: CODE, project: "p1" }));
await wait(600);

check("the bridge says it takes requests", paired?.asks === true);

// With two sessions and no choice, the tab is told to choose.
tab.send(JSON.stringify({ type: "ask", id: "q1", file: "main.xtex", text: "a long sentence", request: "shorten it" }));
await wait(400);
check("two sessions, none chosen: the request is refused with a reason", replies.at(-1)?.type === "ask-refused");

// The tab chooses the second session; the request goes there only.
const chosen = rows.find((r) => r.name !== "agent" && r.name.startsWith("other")) ?? rows.find((r) => !r.here && r.id !== rows[0]?.id) ?? rows[1];
tab.send(JSON.stringify({ type: "choose", session: chosen?.id }));
await wait(300);
tab.send(JSON.stringify({ type: "ask", id: "q1", file: "main.xtex", text: "a long sentence", request: "shorten it" }));
await wait(800);
check("the request is accepted for the chosen session", replies.at(-1)?.type === "ask-sent" && replies.at(-1)?.session === chosen?.id);
check("the chosen session hears it as a channel message", other.heard.some((p) => p.meta?.kind === "ask" && p.meta?.request_id === "q1" && /shorten it/.test(p.content) && /a long sentence/.test(p.content)));
check("the other session hears nothing", hub.heard.length === 0);
check("meta keys are identifiers only", other.heard.every((p) => Object.keys(p.meta).every((k) => /^[A-Za-z0-9_]+$/.test(k))));
const listed = textOf(await other.client.callTool({ name: "requests_list", arguments: {} }));
check("requests_list carries it", /"id": "q1"/.test(listed) && /shorten it/.test(listed));

// A card that names the request answers it.
await other.client.callTool({ name: "revision_propose", arguments: { file: "main.xtex", kind: "sub", anchor: "a long sentence", text: "a sentence", request: "q1" } });
check("a proposal naming the request takes it off the list", /no request is waiting/.test(textOf(await other.client.callTool({ name: "requests_list", arguments: {} }))));

// A rejection with a comment.
tab.send(JSON.stringify({ type: "rejected", id: "q1", file: "main.xtex", revision: "change:shorter", excerpt: "a long sentence -> a sentence", comment: "keep the word long", request: "shorten it" }));
await wait(800);
check("a rejection with its comment reaches the session", other.heard.some((p) => p.meta?.kind === "rejected" && p.meta?.revision === "change:shorter" && /keep the word long/.test(p.content)));
check("and waits in requests_list", /keep the word long/.test(textOf(await other.client.callTool({ name: "requests_list", arguments: {} }))));

// requests_wait: held open until a request arrives, each handed over once.
const wait1 = async (args, options) => textOf(await other.client.callTool({ name: "requests_wait", arguments: args }, undefined, options));
check("requests_wait hands over what was already waiting", /keep the word long/.test(await wait1({ seconds: 1 })));
const t0 = Date.now();
check("and does not hand it over twice", /nothing arrived/.test(await wait1({ seconds: 1 })) && Date.now() - t0 >= 900);
const held = wait1({ seconds: 10 });
await wait(300);
tab.send(JSON.stringify({ type: "ask", id: "q2", file: "main.xtex", text: "another sentence", request: "in plain words" }));
const t1 = Date.now();
check("a held call returns when a request arrives", /in plain words/.test(await held) && Date.now() - t1 < 3000);
// A client that gives up takes nothing with it.
const ac = new AbortController();
const dropped = wait1({ seconds: 10 }, { signal: ac.signal }).catch(() => "aborted");
await wait(300); ac.abort(); await dropped; await wait(200);
tab.send(JSON.stringify({ type: "ask", id: "q3", file: "main.xtex", text: "a third sentence", request: "after the abort" }));
await wait(300);
check("a call the client aborted takes no request with it", /after the abort/.test(await wait1({ seconds: 2 })));

// A session on an earlier bridge attaches without saying it takes requests:
// one sent to it is refused with the reason, never dropped.
const old = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => old.on("open", r));
const reached = [];
old.on("message", (m) => reached.push(JSON.parse(String(m)).type));
old.send(JSON.stringify({ type: "attach", code: CODE, id: "sold", name: "old-session" }));
await wait(300);
tab.send(JSON.stringify({ type: "choose", session: "sold" }));
await wait(300);
tab.send(JSON.stringify({ type: "ask", id: "q4", file: "main.xtex", text: "a fourth sentence", request: "to an old session" }));
await wait(400);
check("a session on an earlier bridge: the request is refused with the reason", replies.at(-1)?.type === "ask-refused" && replies.at(-1)?.id === "q4" && /restart/.test(replies.at(-1)?.reason ?? "") && !reached.includes("event"));
old.close();

tab.close();
await other.client.close();
await hub.client.close();
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `RED: ${failed} of ${checks.length} checks failed` : `GREEN: ${checks.length} checks`);
process.exit(failed ? 1 : 0);
