#!/usr/bin/env node
// The Vitela agent bridge: an MCP server on stdio for the agent, a local
// WebSocket for the browser tab. Every tool the agent calls runs INSIDE the
// paired Vitela tab — its project, its compiler, its TeX engine — and the
// answer comes back here. Nothing leaves the machine: the socket binds to
// 127.0.0.1 and a pairing code gates the tab. Writes never touch a file
// directly: a change the agent proposes lands as a revision the author
// accepts or rejects in Vitela.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { createServer as createTlsServer } from "node:https";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const PORT = Number(process.env.VITELA_BRIDGE_PORT ?? 4329);
// 127.0.0.1 by default; VITELA_BRIDGE_HOST=0.0.0.0 to reach a dev tab over the tailnet.
const HOST = process.env.VITELA_BRIDGE_HOST ?? "127.0.0.1";
// A certificate turns the socket into wss://, which is what a page served
// over HTTPS — production, in a browser on another machine of the tailnet —
// is allowed to reach. VITELA_BRIDGE_PUBLIC names that address (host:port)
// so the pairing link can carry it.
const CERT = process.env.VITELA_BRIDGE_CERT;
const KEY = process.env.VITELA_BRIDGE_KEY;
const PUBLIC = process.env.VITELA_BRIDGE_PUBLIC ?? "";
const TLS = Boolean(CERT && KEY && existsSync(CERT) && existsSync(KEY));
let socketError = null; // reported by bridge_status instead of crashing the MCP side
// The pairing code is stable per machine: made once, kept in the user's
// config directory, reused on every start — so the code is asked for once
// and the tab remembers it. VITELA_BRIDGE_CODE overrides it; deleting the
// file makes a new one. The socket only listens on this machine, so a
// stable code opens nothing that was not already open.
const CODE = process.env.VITELA_BRIDGE_CODE ?? stableCode();
function stableCode() {
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "vitela-bridge");
  const file = join(dir, "code");
  try {
    if (existsSync(file)) {
      const kept = readFileSync(file, "utf8").trim();
      if (/^\d{6}$/.test(kept)) return kept;
    }
    const made = String(randomInt(100000, 999999));
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, made + "\n", { mode: 0o600 });
    return made;
  } catch {
    return String(randomInt(100000, 999999));
  }
}
const PUBLIC_APP = "https://vitela.artificialfallibility.com/app";

// ── Transport ────────────────────────────────────────────────────────────
// One machine runs ONE shared bridge (the "hub") on the port, and every
// Vitela tab pairs with it — with the same code, whatever paper it holds.
// A second agent session cannot bind the port, so it attaches to the hub as
// a client and its tool calls are relayed there. The hub routes each
// session to the tab of the paper it opened (project_open binds), so two
// sessions drive two papers at once through one code. A lone session with a
// lone tab needs no ceremony: its calls go to the only tab.
import { WebSocket } from "ws";

let nextId = 1;
const pending = new Map(); // hub: call id -> { resolve, reject, timer }

let mode = null; // "hub" | "client"
let hubServer = null; // client: the socket to the hub
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });

// HUB state
const tabs = new Set();       // browser sockets; each carries _project and _session
const sessions = new Set();   // { tabSock, deliver } — the hub's own session and every attached one
const selfSession = { tabSock: null }; // this process's own MCP session
sessions.add(selfSession);

function tabList() { return [...tabs].filter((t) => t.readyState === 1); }

/** Which tab a session's call goes to (option 1: bound by the paper it
 * opened). A bound tab wins; project_open picks the tab already showing that
 * paper, else a free tab; a lone tab serves an unbound session; more than
 * one tab and no binding asks the session to name its paper. */
function pickTab(session, tool, args) {
  const list = tabList();
  if (session.tabSock && tabs.has(session.tabSock) && session.tabSock.readyState === 1) return session.tabSock;
  if (list.length === 0) throw new Error(`no Vitela tab is paired — open Vitela, press Agent, enter the code ${CODE}`);
  if (tool === "project.open") {
    const id = args?.id;
    return (
      list.find((t) => t._project === id && !t._session) ||
      list.find((t) => t._project === id) ||
      list.find((t) => !t._session) ||
      list[0]
    );
  }
  // The project list is the same in every tab (one browser store), so an
  // unbound session may read it from any tab without claiming one.
  if (tool === "projects.list") return list[0];
  if (list.length === 1) return list[0];
  throw new Error("more than one Vitela tab is open — open your paper first with project_open(id); that binds this session to its tab");
}

function askTab(target, tool, args, timeoutMs) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`the tab did not answer ${tool} within ${timeoutMs / 1000}s`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    target.send(JSON.stringify({ type: "call", id, tool, args }));
  });
}

/** Run a tool for a session against the right tab, and remember the binding
 * a project_open establishes. Used by the hub for its own session and for
 * every attached one. */
async function routeForSession(session, tool, args, timeoutMs) {
  const target = pickTab(session, tool, args);
  const value = await askTab(target, tool, args ?? {}, timeoutMs);
  if (tool === "project.open") { session.tabSock = target; target._session = session; target._project = args?.id ?? target._project; }
  return value;
}

function startHub(wss) {
  mode = "hub";
  wss.on("connection", (socket) => {
    let role = null; // "tab" | "session"
    let session = null;
    socket.on("message", (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!role) {
        if (msg.type === "pair" && String(msg.code) === CODE) {
          role = "tab"; socket._project = msg.project ?? null; socket._session = null; tabs.add(socket);
          socket.send(JSON.stringify({ type: "paired" }));
        } else if (msg.type === "attach" && String(msg.code) === CODE) {
          role = "session"; session = { tabSock: null, deliver: (m) => socket.send(JSON.stringify(m)) }; sessions.add(session);
          socket.send(JSON.stringify({ type: "attached" }));
        } else {
          socket.send(JSON.stringify({ type: "refused" })); socket.close();
        }
        return;
      }
      if (role === "tab") {
        if (msg.type === "project") socket._project = msg.project ?? null;
        else if (msg.type === "result" && pending.has(msg.id)) {
          const { resolve, reject, timer } = pending.get(msg.id); clearTimeout(timer); pending.delete(msg.id);
          if (msg.ok) resolve(msg.value); else reject(new Error(msg.error ?? "the tab reported an error"));
        }
        return;
      }
      // role === "session": relay a call to the right tab and answer back
      if (msg.type === "call") {
        routeForSession(session, msg.tool, msg.args, msg.timeout ?? 120_000)
          .then((value) => session.deliver({ type: "call-result", cid: msg.cid, ok: true, value }))
          .catch((error) => session.deliver({ type: "call-result", cid: msg.cid, ok: false, error: String(error?.message ?? error) }));
      }
    });
    socket.on("close", () => {
      if (role === "tab") { tabs.delete(socket); for (const s of sessions) if (s.tabSock === socket) s.tabSock = null; }
      else if (session) sessions.delete(session);
    });
  });
  readyResolve();
}

function startClient() {
  mode = "client";
  const scheme = TLS ? "wss" : "ws";
  const url = `${scheme}://127.0.0.1:${PORT}`;
  const cwaiters = new Map(); // cid -> { resolve, reject, timer }
  const open = () => {
    hubServer = new WebSocket(url, { rejectUnauthorized: false });
    hubServer.on("open", () => { hubServer.send(JSON.stringify({ type: "attach", code: CODE })); });
    hubServer.on("message", (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "attached") { readyResolve(); return; }
      if (msg.type === "refused") { socketError = "the shared bridge refused this code"; return; }
      if (msg.type === "call-result" && cwaiters.has(msg.cid)) {
        const { resolve, reject, timer } = cwaiters.get(msg.cid); clearTimeout(timer); cwaiters.delete(msg.cid);
        if (msg.ok) resolve(msg.value); else reject(new Error(msg.error ?? "the shared bridge reported an error"));
      }
    });
    hubServer.on("close", () => { hubServer = null; });
    hubServer.on("error", (e) => { socketError = String(e?.message ?? e); });
  };
  open();
  clientCall = (tool, args, timeoutMs) => new Promise((resolve, reject) => {
    if (!hubServer || hubServer.readyState !== 1) return reject(new Error("the shared bridge is not reachable"));
    const cid = nextId++;
    const timer = setTimeout(() => { cwaiters.delete(cid); reject(new Error(`the shared bridge did not answer ${tool} within ${timeoutMs / 1000}s`)); }, timeoutMs + 5000);
    cwaiters.set(cid, { resolve, reject, timer });
    hubServer.send(JSON.stringify({ type: "call", cid, tool, args, timeout: timeoutMs }));
  });
}

let clientCall = null;

let wss = null;
function bringUp() {
  if (TLS) {
    const tls = createTlsServer({ cert: readFileSync(CERT), key: readFileSync(KEY) });
    tls.on("error", (error) => {
      if (error.code === "EADDRINUSE") { startClient(); } else { socketError = String(error.message ?? error); process.stderr.write(`vitela-bridge: ${socketError}\n`); }
    });
    tls.listen(PORT, HOST, () => { wss = new WebSocketServer({ server: tls }); startHub(wss); });
  } else {
    const s = new WebSocketServer({ host: HOST, port: PORT });
    s.on("listening", () => { wss = s; startHub(s); });
    s.on("error", (error) => {
      if (error.code === "EADDRINUSE") { startClient(); }
      else { socketError = String(error.message ?? error); process.stderr.write(`vitela-bridge: ${socketError}\n`); }
    });
  }
}
bringUp();

async function callTab(tool, args, timeoutMs = 120_000) {
  if (socketError && mode !== "hub") return Promise.reject(new Error(socketError));
  await ready;
  if (mode === "client") return clientCall(tool, args ?? {}, timeoutMs);
  return routeForSession(selfSession, tool, args ?? {}, timeoutMs);
}

function tabCount() { return tabList().length; }

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (error) => ({ content: [{ type: "text", text: `error: ${error.message ?? error}` }], isError: true });
const run = (tool, timeout) => async (args) => {
  try {
    return text(await callTab(tool, args ?? {}, timeout));
  } catch (error) {
    return fail(error);
  }
};

/**
 * Who proposed a change, for the sidecar: never a bare "agent". The MCP
 * client names itself at the handshake (Claude Code and its version, Cursor,
 * ...) and that part is read here, not asked; the model and its provider
 * only the agent can state, so the tool takes them as arguments. The
 * author string reads, for instance:
 *   agent · claude-code 2.1.250 · claude-fable-5-1 (Anthropic)
 */
function authorOf(args) {
  const client = server.server.getClientVersion?.();
  const parts = ["agent"];
  if (client?.name) parts.push(client.version ? `${client.name} ${client.version}` : client.name);
  if (args.model) parts.push(args.provider ? `${args.model} (${args.provider})` : String(args.model));
  return parts.join(" \u00b7 ");
}

const server = new McpServer({ name: "vitela-bridge", version: "0.1.0" });

server.registerTool("bridge_status", {
  description: "Whether a Vitela tab is paired, the pairing code to type in Vitela (Agent button), and a link that pairs the tab by itself when opened. The code is stable on this machine, so the author needs it once; Vitela remembers it afterwards.",
  inputSchema: {},
}, async () => {
  await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
  return text({
    paired: mode === "hub" ? tabCount() > 0 : Boolean(hubServer && hubServer.readyState === 1),
    role: mode === "client" ? "attached to the shared bridge on this machine" : "the shared bridge",
    tabs: mode === "hub" ? tabCount() : undefined,
    code: CODE,
    link: `${PUBLIC_APP}?pair=${CODE}${PUBLIC ? `&bridge=${encodeURIComponent(PUBLIC)}` : ""}`,
    tls: TLS,
    public: PUBLIC || null,
    localLink: `http://localhost:4326/app?pair=${CODE}`,
    port: PORT,
    host: HOST,
    ...(socketError ? { error: socketError } : {}),
  });
});

server.registerTool("projects_list", {
  description: "The projects in the paired Vitela tab: id, name, root file, last update.",
  inputSchema: {},
}, run("projects.list"));

server.registerTool("project_open", {
  description: "Switch the tab to a project by id (from projects_list).",
  inputSchema: { id: z.string() },
}, run("project.open"));

server.registerTool("files_list", {
  description: "Files and assets of the open project.",
  inputSchema: {},
}, run("files.list"));

server.registerTool("file_read", {
  description: "Read one text file of the open project.",
  inputSchema: { path: z.string() },
}, run("file.read"));

server.registerTool("check", {
  description: "Run the ExactTeX check on the open project (with its verification record if present): diagnostics, coverage, bibliography state.",
  inputSchema: {},
}, run("check"));

server.registerTool("compile", {
  description: "Compile the open project to PDF in the tab; returns page count and diagnostics. The first compile of a session can take a minute.",
  inputSchema: {},
}, run("compile", 400_000));

server.registerTool("claims", {
  description: "Inventory of the document's external claims: bibliography entries, urls, dois, repositories, with spans.",
  inputSchema: {},
}, run("claims"));

server.registerTool("verify", {
  description: "Verify the open project's external claims against the public registries (network), writing the dated record; returns the run's metrics and the record summary.",
  inputSchema: {},
}, run("verify", 300_000));

server.registerTool("report", {
  description: "The submission report data: diagnostics, dead floats, bibliography state, external claims with verdicts, coverage.",
  inputSchema: {},
}, run("report"));

server.registerTool("revision_propose", {
  description: "Propose a change as an ExactTeX revision (@add/@del/@sub) the author accepts or rejects in Vitela. Never edits text directly. The tab rehearses the accept and the reject of every proposal before writing it and refuses one the compiler cannot resolve — a bare `%` (a TeX comment) in the text, a `->` in either half of a substitution — with nothing written; escape a percent as `\\%`. `file` must be an .xtex or .tex source: a .bib, .cls or .sty cannot carry a revision and the tab refuses it. `anchor` is exact prose to find in the file (first occurrence in live text); for add, the new text is inserted right after the anchor (placement `inline`, default), as a paragraph of its own after the anchor's line (placement `paragraph`), or as a block on its own lines (placement `block`) — which is how a structure travels: a typed table `\\table(tab:x) {...}`, a `figure` environment, a `tikzpicture`. Braces are welcome as long as they balance; for del, the anchor itself is proposed for removal; for sub, the anchor is proposed to become `text`. Always pass `model` (the model you run on, e.g. claude-fable-5-1) and `provider` (e.g. Anthropic): the revision is signed with your client, version and model so the author can trace who proposed what. The proposal is checked before it is written: an error the document does not already have refuses it, with the diagnostic — nothing is written, so fix the proposal and send it again. An advisory comes back beside the answer. `force: true` writes it anyway, for a change that only becomes valid with another one.",
  inputSchema: {
    file: z.string(),
    kind: z.enum(["add", "del", "sub"]),
    anchor: z.string(),
    text: z.string().optional(),
    message: z.string().optional(),
    placement: z.enum(["inline", "paragraph", "block"]).optional(),
    force: z.boolean().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
  },
}, async (args) => {
  try {
    return text(await callTab("revision.propose", { ...(args ?? {}), author: authorOf(args ?? {}) }));
  } catch (error) {
    return fail(error);
  }
});

server.registerTool("revision_propose_set", {
  description: "Propose a change that needs several edits as ONE revision the author accepts or rejects whole: the preamble line a figure needs and the figure itself, the removal of an old table and the arrival of its replacement, a table and the sentence that introduces it. `message` is what the author reads on the card; `edits` are the same fields `revision_propose` takes (file, kind, anchor, text, placement), applied in order, each against the text the ones before it leave. They arrive as one card in the margin, one group in the sidecar, and one row in revisions_list; Accept resolves them all in one pass, Reject removes them all. The check runs over the result of the whole set, so an edit that cannot be placed, or a set that would break the document, fails before anything is written — nothing half-applied, ever. Pass `model` and `provider` as for revision_propose; `force: true` writes past an error the set would introduce.",
  inputSchema: {
    message: z.string(),
    edits: z.array(z.object({
      file: z.string(),
      kind: z.enum(["add", "del", "sub"]),
      anchor: z.string(),
      text: z.string().optional(),
      placement: z.enum(["inline", "paragraph", "block"]).optional(),
    })).min(2),
    force: z.boolean().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
  },
}, async (args) => {
  try {
    return text(await callTab("revision.propose_set", { ...(args ?? {}), author: authorOf(args ?? {}) }));
  } catch (error) {
    return fail(error);
  }
});

server.registerTool("asset_put", {
  description: "Write an image or PDF into the open project so a figure can point at it: `path` is the file name inside the project (subfolders allowed, no ..), `base64` its bytes. Only pdf, png, jpg and svg, up to 8 MB. The file appears in the author's tree at once; the figure that uses it still travels as a revision the author accepts.",
  inputSchema: { path: z.string(), base64: z.string() },
}, run("asset.put"));

server.registerTool("page_image", {
  description: "Look at the compiled PDF: one page as an image, rendered in the tab from the document the reader sees. Use it to judge what only the eye can judge — a table wider than its column, a figure that broke across pages, a float that landed far from its text, a caption that overflows. `page` is 1-based; `scale` 0.5 to 3 (1.5 reads well). Compile first.",
  inputSchema: { page: z.number().optional(), scale: z.number().optional() },
}, async (args) => {
  try {
    const shot = await callTab("page.image", args ?? {}, 180_000);
    return {
      content: [
        { type: "text", text: `page ${shot.page} of ${shot.pages} · ${shot.width}×${shot.height}px` },
        { type: "image", data: shot.base64, mimeType: "image/png" },
      ],
    };
  } catch (error) {
    return fail(error);
  }
});

server.registerTool("file_delete", {
  description: "Remove a file the AGENT wrote by mistake — today only a `.xtexrev.broken` left behind by an earlier version of this bridge. It refuses every other path: the author's documents, bibliographies, class files and sidecars are the author's, deleted from the file tree and never by an agent.",
  inputSchema: { path: z.string() },
}, run("file.delete"));

server.registerTool("revision_withdraw", {
  description: "Take back a proposal the agent itself made: the construct leaves the text and the document returns to what it said before — an addition's text goes, a deletion's and a substitution's original text stays — and the sidecar record goes with it. Only a revision whose author is an agent can be withdrawn; the author's own changes are the author's. Use it when a proposal was wrong, or when the compiler can no longer resolve it, instead of asking the author to repair it by hand.",
  inputSchema: { id: z.string() },
}, run("revision.withdraw"));

server.registerTool("revisions_prune", {
  description: "Drop sidecar records whose construct is no longer in the text — the repair for a record left behind when a change removed prose that held another pending one. Returns the ids dropped. It never touches a record whose construct is still there.",
  inputSchema: {},
}, run("revisions.prune"));

server.registerTool("revisions_list", {
  description: "Pending revisions in the open project with their authors and status.",
  inputSchema: {},
}, run("revisions.list"));

await server.connect(new StdioServerTransport());
await Promise.race([ready, new Promise((r) => setTimeout(r, 3000))]);
if (mode === "client") {
  process.stderr.write(`vitela-bridge: another session holds the bridge on :${PORT} — attached to it, same code ${CODE}\n`);
  process.stderr.write(`vitela-bridge: open your paper with project_open(id); this session binds to that tab\n`);
} else {
  process.stderr.write(`vitela-bridge: shared bridge on ${TLS ? "wss" : "ws"}://${HOST}:${PORT} · pairing code ${CODE}\n`);
  const origin = PUBLIC ? `https://${PUBLIC.split(":")[0]}` : "http://localhost:4326";
  process.stderr.write(`vitela-bridge: pair every tab with code ${CODE} (Agent button), or open ${origin}/app?pair=${CODE}\n`);
}
// The bridge lives exactly as long as the agent that started it: when the
// agent closes its end of stdio, the socket server would keep the process
// alive on its own, orphaned on the port. Leave with the agent.
function leave() {
  try { if (wss) wss.close(); } catch { /* already down */ }
  try { if (hubServer) hubServer.close(); } catch { /* already down */ }
  process.exit(0);
}
process.stdin.on("close", leave);
process.stdin.on("end", leave);
