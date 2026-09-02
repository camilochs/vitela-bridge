# vitela-bridge

The agent bridge for [Vitela](https://vitela.artificialfallibility.com), the editor for ExactTeX.

It is a small program that runs on your machine. Your coding agent talks to it over the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP); it talks to the Vitela tab open in your
browser. Every tool the agent calls runs inside that tab — the project, the compiler and the TeX engine are
all there — and the answer comes back. Nothing leaves your machine.

One rule makes it safe to hand an agent the keys: **the agent never edits text.** A change it proposes lands
in your document as an ExactTeX revision, signed `agent`, that you accept or reject in Vitela's review margin
like any other suggestion.

The full guide, with screenshots: <https://vitela.artificialfallibility.com/agent>.

## Install

Node 20 or newer. No install step: `npx` fetches and runs it.

**Claude Code**

```sh
claude mcp add vitela-bridge -- npx -y github:camilochs/vitela-bridge
```

**Codex**

```sh
codex mcp add vitela-bridge -- npx -y github:camilochs/vitela-bridge
```

**Cursor, Windsurf, Zed, Claude Desktop and other MCP clients** — add to the client's MCP configuration:

```json
{
  "mcpServers": {
    "vitela-bridge": {
      "command": "npx",
      "args": ["-y", "github:camilochs/vitela-bridge"]
    }
  }
}
```

## Pair

1. Start your agent. The bridge starts with it. Ask the agent for the pairing code once — or for the
   pairing link (`bridge_status` returns both: `code`, and `link` of the form
   `https://vitela.artificialfallibility.com/app?pair=123456`, which pairs the tab by itself when opened).
2. Open Vitela, press **Agent** in the header, type the code (or open the link). The card says
   *Connected* and closes.
3. Work. The agent reads the project, runs the check, compiles, verifies the bibliography, and
   proposes changes you accept or reject in the margin.

The code is stable on this machine — made once, kept in `~/.config/vitela-bridge/code`, reused on every
start — and Vitela remembers it in the browser, so after the first time pressing **Agent** connects by
itself. To get a new code, delete that file or set `VITELA_BRIDGE_CODE`.

## Tools

| Tool | What it does in the tab |
|---|---|
| `bridge_status` | Whether a tab is paired, the pairing code, and the link that pairs a tab when opened |
| `projects_list`, `project_open` | The projects in the tab; switch to one |
| `files_list`, `file_read` | The open project's files and assets; read one |
| `check` | The ExactTeX check: diagnostics, coverage, bibliography state |
| `compile` | Compile to PDF; page count and diagnostics |
| `claims`, `verify` | The document's external claims; verify them against the public registries and write the dated record |
| `report` | The submission report's data |
| `revision_propose` | Propose an addition, deletion or substitution as a revision the author accepts or rejects — prose, or a whole structure (a typed table, a figure, a TikZ picture) with `placement: "block"`; braces travel as long as they balance. Signed with the client and version (read from the MCP handshake) and the `model` and `provider` the agent states — e.g. `agent · claude-code 2.1.250 · claude-fable-5-1 (Anthropic)` — so every proposal is traceable. Checked before it is written: an error the document does not already have refuses the proposal and answers with the diagnostic, leaving the file untouched; an advisory travels back beside the answer; `force: true` writes it anyway |
| `revision_propose_set` | Propose several edits as one change: one card, one group in the sidecar, one Accept for all of them. The check runs over the result of the whole set, and an edit that cannot be placed fails the set — nothing half-applied |
| `asset_put` | Write an image or PDF into the project (base64, up to 8 MB) so a proposed figure can point at it |
| `revisions_prune` | Drop sidecar records whose construct is no longer in the text |
| `revisions_list` | Pending revisions and their authors |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VITELA_BRIDGE_PORT` | `4329` | The local port the tab connects to |
| `VITELA_BRIDGE_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` to reach a tab on another machine of your own network (a dev server over a tailnet, for instance) |
| `VITELA_BRIDGE_CODE` | stable per machine | Fix the pairing code; otherwise it is made once and kept in `~/.config/vitela-bridge/code` |

The tab connects to the bridge on the machine that serves the page for a plain-`http` dev server, and on
`127.0.0.1` for `localhost` and for the published site.

## License

MIT.

If the bridge is useful to you, a star on this repository helps others find it — and tells us it is worth the care.
