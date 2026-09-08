# vitela-bridge

The agent bridge for [Vitela](https://vitela.artificialfallibility.com), the editor for ExactTeX.

It is a small program that runs on your machine. Your coding agent talks to it over the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP); it talks to the Vitela tab open in your
browser. Every tool the agent calls runs inside that tab, where the project, the compiler and the TeX engine
already are, and the answer comes back. Nothing leaves your machine.

One rule makes it safe to hand an agent the keys: **the agent never edits text.** A change it proposes lands
in your document as an ExactTeX revision, signed `agent`, that you accept or reject in Vitela's review margin
like any other suggestion.

The situation I built it for: the paper is open in Vitela, the agent is in a terminal, and I want it to cut
the introduction to half. I do not want it writing into my file. I want the cut to arrive as one card in the
margin, with its author on it, and to read it before it touches the text. That is what this does.

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

**Cursor, Windsurf, Zed, Claude Desktop and other MCP clients.** Add this to the client's MCP configuration:

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

1. Start your agent. The bridge starts with it. Ask the agent for the pairing code once, or for the
   pairing link. `bridge_status` returns both: `code`, and a `link` of the form
   `https://vitela.artificialfallibility.com/app?pair=123456` that pairs the tab by itself when opened.
2. Open Vitela, press **Agent** in the header, type the code (or open the link). The card says
   *Connected* and closes.
3. Work. The agent reads the project, runs the check, compiles, verifies the bibliography, and
   proposes changes you accept or reject in the margin. **Reply** on a card writes a note the agent
   reads; it withdraws that proposal and sends a better one.

The code is made once and kept in `~/.config/vitela-bridge/code`, so every start reuses it, and Vitela
remembers it in the browser. After the first time, pressing **Agent** connects by itself. To get a new code,
delete that file or set `VITELA_BRIDGE_CODE`.

This is what `bridge_status` answers on a fresh bridge, before any tab is paired:

```json
{
  "paired": false,
  "role": "the shared bridge",
  "tabs": 0,
  "sessions": [
    {
      "id": "s29643",
      "name": "readme-probe 0.0.0",
      "paper": null
    }
  ],
  "me": "s29643",
  "code": "123456",
  "link": "https://vitela.artificialfallibility.com/app?pair=123456",
  "tls": false,
  "public": null,
  "localLink": "http://localhost:4326/app?pair=123456",
  "port": 4341,
  "host": "127.0.0.1"
}
```

## What a proposal looks like

The agent calls `revision_propose` with the text to replace and the new text. What lands in your file is
ExactTeX's own revision syntax:

```latex
The gain is @sub(change:gain) {dramatic -> consistent} across both corpora.
```

and the sidecar beside the file records who proposed it:

```toml
[[revision]]
id = "change:gain"
kind = "sub"
author = "agent · claude-code 2.1.258 · claude-fable-5-1 (Anthropic)"
```

In Vitela it is a card in the margin, with Accept, Reject and Reply. Accepting rewrites the line to the new
text; rejecting keeps the proposed text in the sidecar's history. A proposal the compiler cannot place is
refused before anything is written, and the refusal says what to do:

```
refused: the compiler could not accept this proposal (XT1002: revision 'change:code' was not found).
Nothing was written — simplify the text (no bare %, no -> in a substitution, balanced braces) and try again.
```

## Several sessions, one bridge

One machine runs one shared bridge, and every tab pairs with it using the same code. Two agent sessions
can drive two papers at once, with no ports or codes to juggle.

1. Start each session as usual; both spawn the bridge with the same port and code. The first to start
   holds the port and becomes the shared bridge; the next finds the port busy and attaches to it.
   Nothing to configure.
2. Open a Vitela tab per paper and pair each with the same code (Agent button, or `…/app?pair=123456`).
3. In each session, open its paper with `project_open(id)`. The bridge binds that session to the tab
   showing that paper; from then on the session's tools go to that tab. A lone session with a lone tab
   needs no `project_open`.

`bridge_status` says whether a session is the shared bridge or attached to it, and how many tabs the
bridge holds. The bridge lives with the session that started it: if that session ends, an attached
session loses it and must be restarted.

## Editing through cards

The bridge tells the agent how to edit when it connects (the MCP server's instructions), and every refusal says what to do instead. The rules, for a human reader:

1. **Few, large cards.** One card per block the author reads as a unit: a paragraph, a section, the front matter, everything before or after a figure. Never a burst of small cards for one change; never one per sentence. A cut or rewrite of a paper is two substitutions, one before the figure and one after it.
2. **A set when several pieces are one change** (`revision_propose_set`): one card, one Accept. Unrelated edits are separate cards.
3. **Anchor on exact live text**, first occurrence; an anchor inside a pending card is refused.
4. **What a card cannot carry**, and the way round: a bare `%` on the last line of a piece (end the piece a line earlier, or escape it as `\%`; a comment line inside a long piece is fine); a `->` inside a substitution (cut the piece around the figure, or send a deletion and an addition as one set); braces that do not balance (cut where they close); an anchor inside a command's argument or a braced group (propose the enclosing block whole, or `force: true` when the cut must start there; force reaches every piece of a set).
5. **Pages and errors are measured in Vitela**: `compile` after the author accepts. Nothing is compiled elsewhere first.
6. **A reply on a card is feedback**: `revisions_list` carries it as `notes`; withdraw and propose again, improved.

## Tools

| Tool | What it does in the tab |
|---|---|
| `bridge_status` | Whether a tab is paired, the pairing code, and the link that pairs a tab when opened. With several sessions: whether this one is the shared bridge or attached to it, and how many tabs it holds |
| `projects_list`, `project_open` | The projects in the tab; switch to one. With several sessions, `project_open` binds this session to the tab showing that paper |
| `files_list`, `file_read` | The open project's files and assets; read one |
| `check` | The ExactTeX check: diagnostics, coverage, bibliography state |
| `compile` | Compile to PDF; page count and diagnostics |
| `claims`, `verify` | The document's external claims; verify them against the public registries and write the dated record |
| `report` | The submission report's data |
| `revision_propose` | Propose an addition, deletion or substitution as a revision the author accepts or rejects. Prose, or a whole structure (a typed table, a figure, a TikZ picture) with `placement: "block"`; braces travel as long as they balance. Signed with the client and version from the MCP handshake and the `model` and `provider` the agent states, so every proposal is traceable. Checked before it is written: an error the document does not already have refuses the proposal and answers with the diagnostic, leaving the file untouched; an advisory travels back beside the answer; `force: true` writes it anyway. Refused at the door, nothing written: a bare `%`, a `->` inside a substitution, an anchor inside a command's argument, a space right after a macro's opening brace (TeX drops it; put the space before the macro), and a file that cannot carry a revision (a .cls, a .sty). Suggestions live in .xtex, .tex and .bib files |
| `revision_propose_set` | Propose several edits as one change: one card, one group in the sidecar, one Accept for all of them. The check runs over the result of the whole set, and an edit that cannot be placed fails the set. Nothing is half-applied |
| `asset_put` | Write an image or PDF into the project (base64, up to 8 MB) so a proposed figure can point at it |
| `page_image` | One page of the compiled PDF as an image, so the agent can judge what only the eye can judge |
| `revision_withdraw` | Take back a proposal the agent made: the construct leaves and the document returns to what it said before |
| `revisions_prune` | Drop sidecar records whose construct is no longer in the text |
| `revisions_list` | Pending revisions and their authors, and the notes the author left on a card with **Reply**: feedback to read, then withdraw and re-propose |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VITELA_BRIDGE_PORT` | `4329` | The local port the tab connects to |
| `VITELA_BRIDGE_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` to reach a tab on another machine of your own network (a dev server over a tailnet, for instance) |
| `VITELA_BRIDGE_CODE` | stable per machine | Fix the pairing code; otherwise it is made once and kept in `~/.config/vitela-bridge/code` |
| `VITELA_BRIDGE_CERT`, `VITELA_BRIDGE_KEY` | unset | A certificate and key. When both are set the bridge listens as `wss://`, which a page served over HTTPS can reach |
| `VITELA_BRIDGE_PUBLIC` | unset | The address (`host:port`) the tab should use for this bridge. `bridge_status` adds it to the pairing link as `&bridge=` |

## From another machine

A Vitela tab served over HTTPS (production, in a browser on your laptop) can only open an encrypted
socket, and "localhost" there is the laptop, not the machine running the agent. Three things make it work
over a tailnet:

1. A certificate for the agent's machine. With Tailscale: `tailscale cert <machine>.<tailnet>.ts.net`
   (it needs HTTPS enabled for the tailnet). Keep the two files somewhere stable.
2. The bridge bound to the network and given the certificate, in `.mcp.json`:

   ```json
   "env": {
     "VITELA_BRIDGE_HOST": "0.0.0.0",
     "VITELA_BRIDGE_CERT": "/path/to/machine.tailnet.ts.net.crt",
     "VITELA_BRIDGE_KEY": "/path/to/machine.tailnet.ts.net.key",
     "VITELA_BRIDGE_PUBLIC": "machine.tailnet.ts.net:4329"
   }
   ```

3. The link from `bridge_status`, opened on the laptop:
   `https://vitela.artificialfallibility.com/app?pair=123456&bridge=machine.tailnet.ts.net:4329`.
   The tab keeps the bridge address, so the next time the Agent button connects on its own.

The certificate expires; renew it with the same command and restart the agent. If the port is already
held by another session's bridge, this one attaches to it (see *Several sessions, one bridge*);
`bridge_status` says which role it has.

The tab connects to the bridge on the machine that serves the page for a plain-`http` dev server, and on
`127.0.0.1` for `localhost` and for the published site.

## License

MIT.

If the bridge is useful to you, a star on this repository helps others find it.
