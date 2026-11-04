// Capture signed webhook requests locally, verify their HMAC, and replay the
// exact bytes to a live target. Run: node demo/demo-capture.mjs
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { createCaptureServer } from "../dist/server.js";
import { hmacVerify } from "../dist/verify.js";
import { replayCapture } from "../dist/replay.js";

const target = createServer((req, res) => {
  res.writeHead(202, { "content-type": "text/plain" });
  res.end("accepted");
});
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));

const secret = "demo-secret";
const sign = (body) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

const capture = await createCaptureServer({ port: 49713, host: "127.0.0.1", outPath: "demo/store.json" });
const base = capture.url;

const body1 = JSON.stringify({ action: "opened", number: 1 });
await fetch(base + "/hook", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-event": "push",
    "x-hub-signature-256": sign(body1),
  },
  body: body1,
});
const body2 = JSON.stringify({ ref: "refs/heads/main" });
await fetch(base + "/hook", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-hub-signature-256": sign(body2),
  },
  body: body2,
});

const rec = capture.captures[0];
console.log("captured:", rec.method, "http://127.0.0.1:49713" + rec.url);
const good = hmacVerify(secret, rec.headers, rec.raw);
const bad = hmacVerify("nope", rec.headers, rec.raw);
console.log("verify:", good.valid ? "valid" : "INVALID");
console.log("verify wrong secret:", bad.valid ? "VALID(!)" : "invalid");

const replayed = await replayCapture(capture.captures[1], "http://127.0.0.1:" + target.address().port + "/hook");
console.log("replayed:", replayed.status, replayed.body);

await capture.close();
await new Promise((resolve) => target.close(resolve));
console.log("done: capture -> verify -> replay");
