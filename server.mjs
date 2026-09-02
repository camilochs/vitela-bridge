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
import { randomInt } from "node:crypto";
import { z } from "zod";

const PORT = Number(process.env.VITELA_BRIDGE_PORT ?? 4329);
// 127.0.0.1 by default; VITELA_BRIDGE_HOST=0.0.0.0 to reach a dev tab over the tailnet.
const HOST = process.env.VITELA_BRIDGE_HOST ?? "127.0.0.1";
const CODE = process.env.VITELA_BRIDGE_CODE ?? String(randomInt(100000, 999999));

let tab = null; // the paired socket
let nextId = 1;
const pending = new Map();

const wss = new WebSocketServer({ host: HOST, port: PORT });
let socketError = null; // reported by bridge_status instead of crashing the MCP side
wss.on("error", (error) => {
  socketError = error.code === "EADDRINUSE" ? `port ${PORT} is already in use on ${HOST} — set VITELA_BRIDGE_PORT` : String(error.message ?? error);
  process.stderr.write(`vitela-bridge: ${socketError}\n`);
});
wss.on("connection", (socket) => {
  let paired = false;
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!paired) {
      if (msg.type === "pair" && String(msg.code) === CODE) {
        paired = true;
        if (tab && tab !== socket) tab.close();
        tab = socket;
        socket.send(JSON.stringify({ type: "paired" }));
      } else {
        socket.send(JSON.stringify({ type: "refused" }));
        socket.close();
      }
      return;
    }
    if (msg.type === "result" && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.ok) resolve(msg.value);
      else reject(new Error(msg.error ?? "the tab reported an error"));
    }
  });
  socket.on("close", () => {
    if (tab === socket) tab = null;
  });
});

function callTab(tool, args, timeoutMs = 120_000) {
  if (socketError) return Promise.reject(new Error(socketError));
  if (!tab) return Promise.reject(new Error("no Vitela tab is paired — open Vitela, press Agent, enter the code " + CODE));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`the tab did not answer ${tool} within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    tab.send(JSON.stringify({ type: "call", id, tool, args }));
  });
}

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
  description: "Whether a Vitela tab is paired, and the pairing code to type in Vitela (Agent button).",
  inputSchema: {},
}, async () => text({ paired: Boolean(tab), code: CODE, port: PORT, host: HOST, ...(socketError ? { error: socketError } : {}) }));

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
  description: "Propose a change as an ExactTeX revision (@add/@del/@sub) the author accepts or rejects in Vitela. Never edits text directly. `anchor` is exact prose to find in the file (first occurrence in live text); for add, the new text is inserted right after the anchor (placement `inline`, default) or as a paragraph of its own after the anchor's line (placement `paragraph`); for del, the anchor itself is proposed for removal; for sub, the anchor is proposed to become `text`. Always pass `model` (the model you run on, e.g. claude-fable-5-1) and `provider` (e.g. Anthropic): the revision is signed with your client, version and model so the author can trace who proposed what.",
  inputSchema: {
    file: z.string(),
    kind: z.enum(["add", "del", "sub"]),
    anchor: z.string(),
    text: z.string().optional(),
    message: z.string().optional(),
    placement: z.enum(["inline", "paragraph"]).optional(),
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

server.registerTool("revisions_list", {
  description: "Pending revisions in the open project with their authors and status.",
  inputSchema: {},
}, run("revisions.list"));

await server.connect(new StdioServerTransport());
process.stderr.write(`vitela-bridge: listening on ws://${HOST}:${PORT} · pairing code ${CODE}\n`);
// The bridge lives exactly as long as the agent that started it: when the
// agent closes its end of stdio, the socket server would keep the process
// alive on its own, orphaned on the port. Leave with the agent.
process.stdin.on("close", () => {
  wss.close();
  process.exit(0);
});
process.stdin.on("end", () => {
  wss.close();
  process.exit(0);
});
