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
//
// The tab sees the sessions. The hub tells every tab which sessions are on
// this machine and which one is bound to that tab; the author can choose
// one from the tab (`choose`), and a session that opens a paper takes its
// tab from whoever had it — the last to work there wins. The director:
// "the web detects which session is working, and I choose" (2026-09-07).
//
// The port is never the author's problem. A session that cannot attach —
// the process on the port is an older bridge, or hung — asks it to yield;
// a bridge that understands hands the port over and re-attaches as a
// client, its tabs reconnecting on their own; one that does not is a
// vitela-bridge of an earlier version, and only such a process is ended.
import { WebSocket } from "ws";
import { execSync } from "node:child_process";

let nextId = 1;
const pending = new Map(); // hub: call id -> { resolve, reject, timer }

let mode = null; // "hub" | "client"
let hubServer = null; // client: the socket to the hub
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
const STARTED = Date.now();

// A name the author can recognise in the tab: the MCP client (known at the
// handshake), when it started, and the paper it holds. The pid tells two
// sessions of one client apart.
const selfInfo = { id: `s${process.pid}`, name: "agent", since: STARTED, paper: null };
function selfName() {
  const client = typeof server !== "undefined" ? server.server.getClientVersion?.() : null;
  return client?.name ? (client.version ? `${client.name} ${client.version}` : client.name) : "agent";
}

// HUB state
const tabs = new Set();       // browser sockets; each carries _project and _session
const sessions = new Set();   // { tabSock, deliver, info } — the hub's own session and every attached one
const selfSession = { tabSock: null, info: selfInfo }; // this process's own MCP session
sessions.add(selfSession);

function tabList() { return [...tabs].filter((t) => t.readyState === 1); }

function sessionRows(forTab) {
  return [...sessions].map((s) => ({
    id: s.info?.id ?? "?",
    name: s.info?.name ?? "agent",
    since: s.info?.since ?? null,
    paper: s.tabSock?._project ?? s.info?.paper ?? null,
    here: Boolean(forTab && s.tabSock === forTab),
  }));
}
/** Every tab learns which sessions exist and which one is bound to it. */
function tellTabs() {
  for (const t of tabList()) {
    try { t.send(JSON.stringify({ type: "sessions", list: sessionRows(t) })); } catch { /* going away */ }
  }
}
/** Bind a session to a tab. The tab's previous session and the session's
 * previous tab are both released: the last to work on a paper has it. */
function bind(session, tab) {
  if (tab._session && tab._session !== session) tab._session.tabSock = null;
  if (session.tabSock && session.tabSock !== tab) session.tabSock._session = null;
  session.tabSock = tab;
  tab._session = session;
  if (session.info) session.info.paper = tab._project ?? session.info.paper;
  tellTabs();
}
function unbind(session) {
  if (session.tabSock) {
    if (session.tabSock._session === session) session.tabSock._session = null;
    session.tabSock = null;
  }
  tellTabs();
}

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
 * a project_open establishes — or that working on a lone tab establishes.
 * Used by the hub for its own session and for every attached one. */
async function routeForSession(session, tool, args, timeoutMs) {
  const target = pickTab(session, tool, args);
  const value = await askTab(target, tool, args ?? {}, timeoutMs);
  if (tool === "project.open") { target._project = args?.id ?? target._project; bind(session, target); }
  else if (tool !== "projects.list" && !session.tabSock) bind(session, target);
  return value;
}

function startHub(wss) {
  mode = "hub";
  selfInfo.name = selfName();
  wss.on("connection", (socket) => {
    let role = null; // "tab" | "session"
    let session = null;
    socket.on("message", (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!role) {
        if (msg.type === "pair" && String(msg.code) === CODE) {
          role = "tab"; socket._project = msg.project ?? null; socket._session = null; tabs.add(socket);
          socket.send(JSON.stringify({ type: "paired" }));
          // A session that had opened this paper takes the tab back: after a
          // handover the tabs reconnect on their own and find their session.
          const owner = [...sessions].find((s) => !s.tabSock && s.info?.paper && s.info.paper === socket._project);
          if (owner) bind(owner, socket); else tellTabs();
        } else if (msg.type === "attach" && String(msg.code) === CODE) {
          role = "session";
          session = {
            tabSock: null,
            deliver: (m) => socket.send(JSON.stringify(m)),
            info: { id: msg.id ?? `s${nextId++}`, name: msg.name ?? "agent", since: msg.since ?? Date.now(), paper: msg.paper ?? null },
          };
          sessions.add(session);
          socket.send(JSON.stringify({ type: "attached" }));
          const tab = session.info.paper ? tabList().find((t) => t._project === session.info.paper && !t._session) : null;
          if (tab) bind(session, tab); else tellTabs();
        } else if (msg.type === "yield" && String(msg.code) === CODE) {
          // The port goes to the session asking for it; this one follows.
          socket.send(JSON.stringify({ type: "yielded" }));
          handOver();
        } else {
          socket.send(JSON.stringify({ type: "refused" })); socket.close();
        }
        return;
      }
      if (role === "tab") {
        if (msg.type === "project") {
          socket._project = msg.project ?? null;
          if (socket._session?.info) socket._session.info.paper = socket._project;
          tellTabs();
        } else if (msg.type === "choose") {
          // The author picks, from the tab, which session works here.
          const chosen = [...sessions].find((s) => s.info?.id === msg.session);
          if (chosen) bind(chosen, socket); else if (socket._session) unbind(socket._session);
        } else if (msg.type === "result" && pending.has(msg.id)) {
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
      if (role === "tab") { tabs.delete(socket); for (const s of sessions) if (s.tabSock === socket) s.tabSock = null; tellTabs(); }
      else if (session) { unbind(session); sessions.delete(session); tellTabs(); }
    });
  });
  readyResolve();
}

/** The hub steps down: the port is released and this process re-attaches
 * to whoever takes it. Its own binding survives by paper; the tabs close
 * and reconnect on their own to the new hub. */
function handOver() {
  selfInfo.paper = selfSession.tabSock?._project ?? selfInfo.paper;
  for (const t of tabList()) { try { t.close(); } catch { /* going */ } }
  try { if (wss) wss.close(); } catch { /* already down */ }
  try { if (tlsServer) tlsServer.close(); } catch { /* already down */ }
  wss = null; tlsServer = null;
  tabs.clear();
  for (const s of [...sessions]) if (s !== selfSession) sessions.delete(s);
  selfSession.tabSock = null;
  mode = null;
  setTimeout(() => startClient(), 400);
}

/** Attach to the hub, and keep following the port: a hub that hands over
 * or ends is replaced, and this session attaches to the next one. When
 * nothing answers, or the code is refused, take the port (takeOver). */
function startClient() {
  mode = "client";
  const scheme = TLS ? "wss" : "ws";
  const url = `${scheme}://127.0.0.1:${PORT}`;
  const cwaiters = new Map(); // cid -> { resolve, reject, timer }
  let attached = false;
  const open = () => {
    let answered = false;
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    hubServer = ws;
    const silence = setTimeout(() => { if (!answered && mode === "client") { try { ws.close(); } catch { /* down */ } takeOver(); } }, 2500);
    ws.on("open", () => { ws.send(JSON.stringify({ type: "attach", code: CODE, id: selfInfo.id, name: selfName(), since: STARTED, paper: selfInfo.paper })); });
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "attached") { answered = true; attached = true; clearTimeout(silence); socketError = null; readyResolve(); return; }
      if (msg.type === "refused") { answered = true; clearTimeout(silence); socketError = "the shared bridge refused this code"; try { ws.close(); } catch { /* down */ } takeOver(); return; }
      if (msg.type === "call-result" && cwaiters.has(msg.cid)) {
        const { resolve, reject, timer } = cwaiters.get(msg.cid); clearTimeout(timer); cwaiters.delete(msg.cid);
        if (msg.ok) resolve(msg.value); else reject(new Error(msg.error ?? "the shared bridge reported an error"));
      }
    });
    ws.on("close", () => {
      if (hubServer === ws) hubServer = null;
      clearTimeout(silence);
      // The hub went away (it handed over, or its session ended): follow the
      // port — attach again, or take it when nothing listens.
      if (mode === "client" && attached) { attached = false; setTimeout(() => { if (mode === "client") open(); }, 700); }
    });
    ws.on("error", (e) => {
      clearTimeout(silence);
      socketError = String(e?.message ?? e);
      if (mode === "client" && !answered) takeOver();
    });
  };
  open();
  clientCall = (tool, args, timeoutMs) => new Promise((resolve, reject) => {
    if (!hubServer || hubServer.readyState !== 1 || !attached) return reject(new Error(socketError ?? "the shared bridge is not reachable yet — try again in a moment"));
    const cid = nextId++;
    const timer = setTimeout(() => { cwaiters.delete(cid); reject(new Error(`the shared bridge did not answer ${tool} within ${timeoutMs / 1000}s`)); }, timeoutMs + 5000);
    cwaiters.set(cid, { resolve, reject, timer });
    hubServer.send(JSON.stringify({ type: "call", cid, tool, args, timeout: timeoutMs }));
  });
}

/** Take the port. Ask the occupant to yield: a bridge of this version hands
 * over and follows; one that refuses or answers nothing is an older
 * vitela-bridge, and only such a process is ended. Then bind. */
let takingOver = false;
function takeOver() {
  if (takingOver || mode === "hub") return;
  takingOver = true;
  const finish = () => { mode = null; hubServer = null; setTimeout(bringUp, 600); };
  const scheme = TLS ? "wss" : "ws";
  let done = false;
  const ws = new WebSocket(`${scheme}://127.0.0.1:${PORT}`, { rejectUnauthorized: false });
  const settle = (ended) => {
    if (done) return;
    done = true;
    clearTimeout(giveUp);
    try { ws.close(); } catch { /* down */ }
    if (ended) endOldBridge();
    finish();
  };
  const giveUp = setTimeout(() => settle(true), 2000);
  ws.on("open", () => ws.send(JSON.stringify({ type: "yield", code: CODE })));
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "yielded") settle(false);
    else if (msg.type === "refused") settle(true);
  });
  ws.on("error", () => settle(true));
}
/** End the process on the port — only when it is a vitela-bridge of ours. */
function endOldBridge() {
  try {
    const pids = execSync(`lsof -t -iTCP:${PORT} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] }).toString().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      if (Number(pid) === process.pid) continue;
      const cmd = execSync(`ps -o command= -p ${pid}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
      if (/vitela-bridge/.test(cmd) && /server\.mjs/.test(cmd)) {
        process.kill(Number(pid), "SIGTERM");
        process.stderr.write(`vitela-bridge: an older bridge held :${PORT} (pid ${pid}); it was ended and this session takes the port\n`);
      }
    }
  } catch { /* no lsof here, or nothing to end */ }
}

let clientCall = null;

let wss = null;
let tlsServer = null;
let bindAttempts = 0;
function bringUp() {
  // Right after a takeover the port may take a moment to free: try a few
  // times before settling for attaching.
  const busy = () => { if (takingOver && ++bindAttempts <= 4) setTimeout(bringUp, 700); else { takingOver = false; bindAttempts = 0; startClient(); } };
  const up = () => { takingOver = false; bindAttempts = 0; };
  if (TLS) {
    const tls = createTlsServer({ cert: readFileSync(CERT), key: readFileSync(KEY) });
    tls.on("error", (error) => {
      if (error.code === "EADDRINUSE") busy(); else { socketError = String(error.message ?? error); process.stderr.write(`vitela-bridge: ${socketError}\n`); }
    });
    tls.listen(PORT, HOST, () => { up(); tlsServer = tls; wss = new WebSocketServer({ server: tls }); startHub(wss); });
  } else {
    const s = new WebSocketServer({ host: HOST, port: PORT });
    s.on("listening", () => { up(); wss = s; startHub(s); });
    s.on("error", (error) => {
      if (error.code === "EADDRINUSE") busy();
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

// What an agent reads when it connects: how a paper is edited through
// cards. Written after a day in which a paper was cut to a demo with
// fifteen cards where two would do, and every limit of a card was found by
// hitting it (2026-09-07). The rules live here so no author has to say them.
const EDITING_PROTOCOL = `How to edit a paper in Vitela (read this before proposing).

The author works in the review margin: every proposal is a CARD they accept, reject or reply to. Cards are the unit of the author's attention, so:

1. Few, large cards. One card per block the author reads as a unit: a section, a paragraph, the front matter, the whole body before a figure. Never a burst of small cards for one change. To cut or rewrite a paper: one substitution for everything before the figure, one for everything after it (a figure's arrows keep it out of a substitution). Never one card per sentence.
2. A set when several pieces are ONE change (revision_propose_set): one card, one Accept. Use it when the pieces only make sense together (a preamble line and the figure that needs it; the front matter and the body). Do not use it to bundle unrelated edits.
3. Anchor on exact live text. An anchor is prose as it stands in the file, first occurrence; one that lies inside a pending card is refused — withdraw or wait.
4. What a card cannot carry, and what to do instead: a bare % on the LAST line of a piece (end the piece a line earlier, or escape it as \\%); a -> inside a substitution (cut the piece before and after the figure, or send a deletion and an addition as one set); braces that do not balance (cut where they close); an anchor inside a command's argument or a braced group (propose the enclosing block whole, or pass force: true when the cut must start there). Each refusal says what to do; follow it once, do not iterate blindly.
5. Pages, length and errors are measured in Vitela: call compile after the author accepts, read pages and errors. Do not compile elsewhere before proposing.
6. The author's reply on a card is feedback: revisions_list carries it as notes. Withdraw the card and propose again, improved. Never repeat a refused proposal unchanged.
7. Never write text: read, check, compile, propose. The document changes only when the author accepts.`;

const server = new McpServer({ name: "vitela-bridge", version: "0.1.0" }, { instructions: EDITING_PROTOCOL });

server.registerTool("bridge_status", {
  description: "Whether a Vitela tab is paired, the pairing code to type in Vitela (Agent button), and a link that pairs the tab by itself when opened. The code is stable on this machine, so the author needs it once; Vitela remembers it afterwards.",
  inputSchema: {},
}, async () => {
  await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
  return text({
    paired: mode === "hub" ? tabCount() > 0 : Boolean(hubServer && hubServer.readyState === 1),
    role: mode === "client" ? "attached to the shared bridge on this machine" : "the shared bridge",
    tabs: mode === "hub" ? tabCount() : undefined,
    sessions: mode === "hub" ? sessionRows(null).map((r) => ({ id: r.id, name: r.name, paper: r.paper })) : undefined,
    me: selfInfo.id,
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
  description: "Switch the tab to a project by id (from projects_list). With several sessions on one bridge, this binds the session to the tab showing that project.",
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
  description: "Propose a change as an ExactTeX revision (@add/@del/@sub) the author accepts or rejects in Vitela as ONE card. Never edits text directly. Granularity is the rule the author feels most: one card per block they read as a unit (a paragraph, a section, the front matter, everything before or after a figure) — never a burst of small cards, never one per sentence; a cut or rewrite of a paper is two substitutions, one before the figure and one after it. The tab rehearses the accept and the reject of every proposal before writing it and refuses what the compiler cannot resolve, with nothing written and a message that says what to do instead: a bare `%` on the LAST line of a piece (end the piece a line earlier, or escape it as `\\%` — a comment line inside a long piece is fine), a `->` in either half of a substitution (cut the piece around the figure, or send a deletion and an addition as one set), braces that do not balance (cut where they close). `file` must be an .xtex, .tex or .bib source: a .cls, a .sty or a verification record cannot carry a revision and the tab refuses it. Also refused at the door, nothing written: an anchor inside a command's argument or a braced group (propose the enclosing block whole — a caption, a figure — or pass `force: true` when the cut must start there), and a space right after a macro's opening brace (`\\rfive{ and}`: TeX drops that space and the words glue; put the space before the macro). `anchor` is exact prose to find in the file (first occurrence in live text); for add, the new text is inserted right after the anchor (placement `inline`, default), as a paragraph of its own after the anchor's line (placement `paragraph`), or as a block on its own lines (placement `block`) — which is how a structure travels: a typed table `\\table(tab:x) {...}`, a `figure` environment, a `tikzpicture`. Braces are welcome as long as they balance; for del, the anchor itself is proposed for removal; for sub, the anchor is proposed to become `text`. Always pass `model` (the model you run on, e.g. claude-fable-5-1) and `provider` (e.g. Anthropic): the revision is signed with your client, version and model so the author can trace who proposed what. The proposal is checked before it is written: an error the document does not already have refuses it, with the diagnostic — nothing is written, so fix the proposal and send it again. An advisory comes back beside the answer. `force: true` writes it anyway, for a change that only becomes valid with another one.",
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
  description: "Propose a change that needs several edits as ONE revision the author accepts or rejects whole: the preamble line a figure needs and the figure itself, the removal of an old table and the arrival of its replacement, a table and the sentence that introduces it. `message` is what the author reads on the card; `edits` are the same fields `revision_propose` takes (file, kind, anchor, text, placement), applied in order, each against the text the ones before it leave. They arrive as one card in the margin, one group in the sidecar, and one row in revisions_list; Accept resolves them all in one pass, Reject removes them all. The check runs over the result of the whole set, so an edit that cannot be placed, or a set that would break the document, fails before anything is written — nothing half-applied, ever. Keep the pieces few and large (see revision_propose): a set is one change in several places, not a burst of small edits. Pass `model` and `provider` as for revision_propose; `force: true` reaches every piece — it writes past an error the set would introduce, and lets a piece start inside a braced group when the cut must fall there.",
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
  description: "Pending revisions in the open project with their authors and status. Each row carries any `notes` the author left on that card (the Reply button writes them): read them as feedback and RE-PROPOSE the change improved — withdraw the old proposal (revision_withdraw) and propose a better one that answers the note.",
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
  try { if (tlsServer) tlsServer.close(); } catch { /* already down */ }
  try { if (hubServer) hubServer.close(); } catch { /* already down */ }
  process.exit(0);
}
process.stdin.on("close", leave);
process.stdin.on("end", leave);
