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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const PORT = Number(process.env.VITELA_BRIDGE_PORT ?? 4329);
// 127.0.0.1 by default; VITELA_BRIDGE_HOST=0.0.0.0 to reach a dev tab over the tailnet.
const HOST = process.env.VITELA_BRIDGE_HOST ?? "127.0.0.1";
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
  description: "Whether a Vitela tab is paired, the pairing code to type in Vitela (Agent button), and a link that pairs the tab by itself when opened. The code is stable on this machine, so the author needs it once; Vitela remembers it afterwards.",
  inputSchema: {},
}, async () => text({
  paired: Boolean(tab),
  code: CODE,
  link: `${PUBLIC_APP}?pair=${CODE}`,
  localLink: `http://localhost:4326/app?pair=${CODE}`,
  port: PORT,
  host: HOST,
  ...(socketError ? { error: socketError } : {}),
}));

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
  description: "Propose a change as an ExactTeX revision (@add/@del/@sub) the author accepts or rejects in Vitela. Never edits text directly. `anchor` is exact prose to find in the file (first occurrence in live text); for add, the new text is inserted right after the anchor (placement `inline`, default), as a paragraph of its own after the anchor's line (placement `paragraph`), or as a block on its own lines (placement `block`) — which is how a structure travels: a typed table `\\table(tab:x) {...}`, a `figure` environment, a `tikzpicture`. Braces are welcome as long as they balance; for del, the anchor itself is proposed for removal; for sub, the anchor is proposed to become `text`. Always pass `model` (the model you run on, e.g. claude-fable-5-1) and `provider` (e.g. Anthropic): the revision is signed with your client, version and model so the author can trace who proposed what. The proposal is checked before it is written: an error the document does not already have refuses it, with the diagnostic — nothing is written, so fix the proposal and send it again. An advisory comes back beside the answer. `force: true` writes it anyway, for a change that only becomes valid with another one.",
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

server.registerTool("revisions_prune", {
  description: "Drop sidecar records whose construct is no longer in the text — the repair for a record left behind when a change removed prose that held another pending one. Returns the ids dropped. It never touches a record whose construct is still there.",
  inputSchema: {},
}, run("revisions.prune"));

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
