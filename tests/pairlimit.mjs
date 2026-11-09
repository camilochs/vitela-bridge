// Guessing the pairing code: five wrong codes are refused and answered;
// from the sixth in the same minute the hub closes the socket without a
// word, even for the right code. Seen red before the limit (seven
// answers, the right code accepted after six wrong ones).
//   node tests/pairlimit.mjs     (BRIDGE=path/to/another/server.mjs runs it against that one)
import { spawn } from "node:child_process";
import WebSocket from "ws";
const PORT = 4393, CODE = "246810";
const bridge = spawn(process.execPath, [process.env.BRIDGE ?? new URL("../server.mjs", import.meta.url).pathname], { env: { ...process.env, VITELA_BRIDGE_PORT: String(PORT), VITELA_BRIDGE_CODE: CODE, VITELA_BRIDGE_HOST: "127.0.0.1" }, stdio: ["pipe", "pipe", "pipe"] });
await new Promise((r) => bridge.stderr.on("data", (d) => { if (/shared bridge on/.test(String(d))) r(); }));
const attempt = (code) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`); let answer = null;
  ws.on("open", () => ws.send(JSON.stringify({ type: "pair", code })));
  ws.on("message", (m) => { answer = JSON.parse(String(m)).type; });
  ws.on("close", () => resolve(answer ?? "closed-silently"));
  ws.on("error", () => resolve("error"));
  setTimeout(() => { if (ws.readyState === WebSocket.OPEN) { answer = answer ?? "paired-open"; ws.close(); } }, 800);
});
const answers = [];
for (let i = 0; i < 6; i++) answers.push(await attempt(String(100000 + i)));
answers.push(await attempt(CODE));
bridge.kill();
const refused = answers.filter((a) => a === "refused").length, silent = answers.filter((a) => a === "closed-silently").length;
console.log("answers:", answers.join(", "));
const ok = refused === 5 && silent === 2 && !answers.includes("paired") && !answers.includes("paired-open");
console.log(ok ? "GREEN" : "RED: expected 5 refused, then 2 closed without a word (the right code included)");
process.exit(ok ? 0 : 1);
