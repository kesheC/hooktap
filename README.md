# hooktap

Capture, verify, and replay webhooks locally — with zero runtime dependencies.

hooktap runs a small HTTP server that records every request it receives (headers, body, and the raw bytes), verifies HMAC signatures the way GitHub sends them (`x-hub-signature-256`), and re-sends the exact captured bytes to any URL. It is a testing tool: point your webhook sender at `localhost`, inspect and verify what arrived, then replay it against your real handler without the sender being involved again.

## Features

- **Capture** — `hooktap listen` records requests to a local server. Every capture keeps the exact bytes received (`raw`), not a re-serialization, so signatures stay verifiable.
- **Verify** — `hooktap verify` checks an HMAC signature against the raw bytes with a constant-time comparison, reading the digest from `x-hub-signature-256`, `x-hub-signature`, `x-signature-256`, or `x-signature` (sha256 and sha1 schemes). On mismatch it reports the first differing hex nibble.
- **Sign** — `hooktap sign` prints the signature a sender would attach for a body, so test fixtures do not need crypto code of their own.
- **Replay** — `hooktap replay` re-sends captured request N to any URL, byte-for-byte, with `content-length` recomputed and hop-by-hop headers stripped.
- **Inspect** — `hooktap inspect` prints stored captures, as text or JSON.

## Requirements

- Node.js >= 20.11
- No runtime dependencies. Dev tooling (TypeScript, vitest 4) requires Node 20.19+ or 22.12+ to run from source — see [CONTRIBUTING.md](CONTRIBUTING.md) for the two floors.

## Install

```bash
npm install hooktap
```

Or from a release tarball (GitHub Releases publish `hooktap-<version>.tgz`, a stable-name `hooktap.tgz`, and `SHA256SUMS.txt`).

## Quickstart (library API)

```bash
node demo/demo-capture.mjs
```

```text
captured: POST /hook (#1)
captured: POST /hook (#2)
captured: POST http://127.0.0.1:49713/hook
verify: valid
verify wrong secret: invalid
replayed: 202 accepted
done: capture -> verify -> replay
```

The demo starts a capture server on a fixed port, sends two HMAC-signed POST requests, verifies the first one with the right secret and a wrong one, replays the second capture to a live target server (202 accepted), and writes the two captures to `demo/store.json`. Everything runs against loopback; nothing leaves the machine.

The same flow with the library API directly:

```js
import { createCaptureServer } from "hooktap";
import { hmacVerify } from "hooktap";
import { replayCapture } from "hooktap";

const capture = await createCaptureServer({ port: 0, host: "127.0.0.1" });
// ... send a webhook to capture.url ...
const rec = capture.captures[0];
const result = hmacVerify(secret, rec.headers, rec.raw);
// result.valid, result.scheme, result.firstDiff (first differing hex nibble on mismatch)

await replayCapture(capture.captures[1], "http://127.0.0.1:3000/hook");
await capture.close();
```

`port: 0` picks a free port. Signature verification and replay always use `rec.raw` — the exact bytes received — never the decoded body, because re-serializing JSON would break the HMAC.
## CLI

```bash
$ node dist/cli.js --help
hooktap 0.1.3 - capture, verify and replay webhooks locally

USAGE
  hooktap listen [--port N] [--host H] [--out FILE] [--quiet]
      Run a local capture server. Every request is recorded;
      with --out the store file is updated after each request.

  hooktap verify FILE --secret S [--index N] [--json]
      Verify the HMAC signature of stored capture N (default 0).
      Reads the digest from x-hub-signature-256 / x-hub-signature /
      x-signature-256 / x-signature and compares in constant time.

  hooktap sign --secret S [--scheme sha256|sha1] BODY
      Print the signature a sender would attach for BODY.

  hooktap replay FILE --to URL [--index N]
      Re-send captured request N (default 0) to URL.

  hooktap inspect FILE [--json] [--last N]
      Print stored captures.

  hooktap --help | -h | --version | -V
```

(Installed via npm, the binary is `hooktap`; the transcript above uses `node dist/cli.js` so it reproduces from a plain checkout.)

### listen

```bash
$ rm -f demo/store.json demo/listen.log
$ node dist/cli.js listen --port 49713 --out demo/store.json 2> demo/listen.log & SERVER=$!
$ until grep -q listening demo/listen.log 2>/dev/null; do sleep 0.2; done
$ curl -s -X POST http://127.0.0.1:49713/hook -H 'content-type: application/json' -d '{"event":"ping"}'; echo
{"captured":1}
$ cat demo/listen.log
hooktap listening on http://127.0.0.1:49713 (store: demo/store.json)
send a webhook: curl -X POST http://127.0.0.1:49713/hook -H 'content-type: application/json' -d '{"event":"ping"}'
press Ctrl-C to stop
captured: POST /hook (#1)
$ kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null
```

(The capture line appears when a request arrives; the banner and hint lines go to stderr, redirected to `demo/listen.log` here so stdout stays parseable.) With `--out FILE` the store file is rewritten after every request, so a Ctrl-C never loses captures. Each sender receives `{"captured":N}` with status 200.

### sign and verify

```bash
$ node dist/cli.js sign --secret demo-secret '{"action":"opened","number":1}'
sha256=bf9cf1e6445293e5090ad05b4dbcd8465544a4a7abce79c0910c5cad9d86d9f0
```

```bash
$ rm -f demo/store.json && node demo/demo-capture.mjs > /dev/null 2>&1
$ node dist/cli.js verify demo/store.json --secret demo-secret
signature: x-hub-signature-256
scheme:    sha256
valid:     yes
computed:  bf9cf1e6445293e5090ad05b4dbcd8465544a4a7abce79c0910c5cad9d86d9f0
received:  sha256=bf9cf1e6445293e5090ad05b4dbcd8465544a4a7abce79c0910c5cad9d86d9f0
```

With the wrong secret, verification fails and reports where the digests first diverge:

```bash
$ node dist/cli.js verify demo/store.json --secret nope
signature: x-hub-signature-256
scheme:    sha256
valid:     NO
computed:  7c5ec444c093a5addec014a4dfc5a3373be22add9087c23f1974814414441355
received:  sha256=bf9cf1e6445293e5090ad05b4dbcd8465544a4a7abce79c0910c5cad9d86d9f0
first diff at hex nibble 0
```

Exit codes: verify prints `valid: yes` and exits 0 on match, `valid: NO` and exits 1 on mismatch. `--json` emits the machine-readable result instead (`{"valid":false,...,"firstDiff":0}`).

### replay

```bash
$ node -e "require('http').createServer((q,s)=>{s.writeHead(202);s.end('accepted')}).listen(3000)" &
$ sleep 1
$ node dist/cli.js replay demo/store.json --to http://127.0.0.1:3000/hook --index 1
status: 202
body:  accepted
$ kill %1 2>/dev/null
```

Replay re-sends the exact captured bytes: same method, same headers, same body — delivered to the path of the `--to` URL (the captured path is not reused) — with `host`, `connection`, and other hop-by-hop headers stripped and `content-length` recomputed. Missing `--to` is an error (`error: --to URL is required`, exit 2). Byte-for-byte fidelity applies to UTF-8 text payloads; binary payloads are not guaranteed to round-trip (see the on-disk format note below).

### inspect

```bash
$ node dist/cli.js inspect demo/store.json
#0  POST /hook
  from 127.0.0.1  at 2026-11-04T20:51:36.795Z
  signature x-hub-signature-256: sha256=bf9cf1e6445293e5090ad05b4dbcd8465544a4a7abce79c0910c5cad9d86d9f0
  body: { "action": "opened", "number": 1 }
#1  POST /hook
  from 127.0.0.1  at 2026-11-04T20:51:36.803Z
  signature x-hub-signature-256: sha256=e4a9a8486ed495de6751638dc69003d50db693847117e1f267de413b8e76e7c8
  body: { "ref": "refs/heads/main" }

2 capture(s) in demo/store.json
```

`--json` prints the full store as JSON; `--last N` trims the output to the most recent N captures.
## On-disk format

A capture store is a JSON file:

```json
{
  "formatVersion": 1,
  "captures": [
    {
      "method": "POST",
      "url": "/hook",
      "headers": { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": "sha256=…" },
      "body": { "action": "opened", "number": 1 },
      "raw": "{\"action\":\"opened\",\"number\":1}",
      "receivedAt": "2026-11-04T20:51:36.795Z",
      "remote": "127.0.0.1"
    }
  ]
}
```

`body` is decoded for readability (JSON bodies become objects); `raw` is the exact utf8 text received. Verification and replay read `raw`. `formatVersion` is 1; loaders reject files with a different version instead of guessing.

One fidelity limit: `raw` is stored as UTF-8 text, so byte-for-byte capture and replay hold for UTF-8 text payloads. A request body that is not valid UTF-8 (gzip, protobuf, or other binary payloads) does not survive the store round-trip and its replay is not guaranteed to be byte-identical.

## Library API

| Export | Signature | Notes |
| --- | --- | --- |
| `createCaptureServer` | `(options: {port, host, outPath?}) => Promise<CaptureServer>` | `port: 0` picks a free port; returns `{port, url, captures, close()}` |
| `hmacVerify` | `(secret, headers, raw) => VerifyResult` | secret first; `VerifyResult = {valid, scheme, headerName, headerValue, computed, firstDiff?}` |
| `signBody` | `(secret, body, scheme?) => string` | `sha256=`-prefixed hex digest |
| `replayCapture` | `(record, targetUrl, timeoutMs?) => Promise<ReplayResult>` | second argument is a URL string |
| `loadCaptures` / `saveCaptures` | `(path)` / `(store, path)` | ENOENT is reported with `.code` preserved |
| `describeRecord` | `(record) => string` | one-line summary |

## Development

```bash
npm install
npm test          # pretest builds first; offline, no network
npm run coverage  # thresholds 80/70/85/80
npm run dev -- --help
npm run build
```

All tests run offline against loopback servers; none touch the network.

## Security notes

- Signature comparison uses `timingSafeEqual` — not early-exit string comparison.
- Verification reads the digest from the standard GitHub webhook headers; unknown headers are ignored, not trusted.
- Captures are written to disk as plain JSON. Do not point `listen --out` at a shared directory: webhook payloads can contain secrets that only the signature protects on the wire, not at rest.
- `hmacVerify` verifies bytes, it does not authenticate the sender. GitHub's webhook secret proves the payload was signed by whoever holds the secret — combine verification with TLS or network-level controls for real sender authentication.

## License

[MIT](LICENSE)
---

# hooktap（中文说明）

在本地捕获、验签、重放 webhook —— 零运行时依赖。

hooktap 运行一个小型 HTTP 服务器，记录它收到的每个请求（请求头、请求体，以及收到的原始字节），按 GitHub 发送 webhook 的方式验证 HMAC 签名（`x-hub-signature-256`），并把捕获到的原始字节原样重发到任意 URL。它是一个测试工具：把 webhook 发送方指向 `localhost`，检查并验证到达的内容，然后把同样的字节重放给真实处理器——不需要发送方再次参与。

## 功能

- **捕获（Capture）** —— `hooktap listen` 记录发到本地服务器的请求。每条捕获保留收到的原始字节（`raw`），不是重新序列化的结果，所以签名始终可验证。
- **验签（Verify）** —— `hooktap verify` 用常时比较（constant-time comparison）校验 HMAC 签名与原始字节，摘要读取自 `x-hub-signature-256`、`x-hub-signature`、`x-signature-256` 或 `x-signature`（支持 sha256 与 sha1）。不匹配时报告第一个不同的十六进制半字节（nibble）。
- **签名（Sign）** —— `hooktap sign` 打印发送方为一个请求体附加的签名，测试夹具不需要自己写加密代码。
- **重放（Replay）** —— `hooktap replay` 把第 N 条捕获逐字节重发到 `--to` 指定 URL 的路径（不沿用捕获时的路径），方法、请求头、请求体保持原样，`content-length` 重新计算，逐跳（hop-by-hop）请求头被剔除。字节级保真对 UTF-8 文本载荷成立；二进制载荷不保证（见磁盘格式一节的说明）。
- **检查（Inspect）** —— `hooktap inspect` 打印存储的捕获，文本或 JSON 两种格式。

## 环境要求

- Node.js >= 20.11
- 零运行时依赖。开发工具链（TypeScript、vitest 4）从源码运行需要 Node 20.19+ 或 22.12+——两个地板见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安装

```bash
npm install hooktap
```

或从 Release tarball 安装（GitHub Releases 发布 `hooktap-<version>.tgz`、稳定名 `hooktap.tgz` 与 `SHA256SUMS.txt`）。

## 快速开始（库 API）

```bash
node demo/demo-capture.mjs
```

```text
captured: POST /hook (#1)
captured: POST /hook (#2)
captured: POST http://127.0.0.1:49713/hook
verify: valid
verify wrong secret: invalid
replayed: 202 accepted
done: capture -> verify -> replay
```

演示脚本在固定端口启动捕获服务器，发送两个 HMAC 签名的 POST 请求，用正确和错误的密钥分别验签第一条，把第二条捕获重放到一个活的目标服务器（202 accepted），并把两条捕获写入 `demo/store.json`。全部流量走 loopback，没有任何请求离开本机。

直接用库 API 的等价写法：

```js
import { createCaptureServer } from "hooktap";
import { hmacVerify } from "hooktap";
import { replayCapture } from "hooktap";

const capture = await createCaptureServer({ port: 0, host: "127.0.0.1" });
// ... 向 capture.url 发送 webhook ...
const rec = capture.captures[0];
const result = hmacVerify(secret, rec.headers, rec.raw);
// result.valid、result.scheme、result.firstDiff（不匹配时第一个不同的十六进制半字节）

await replayCapture(capture.captures[1], "http://127.0.0.1:3000/hook");
await capture.close();
```

`port: 0` 自动挑选空闲端口。验签与重放始终使用 `rec.raw`——收到的原始字节——绝不使用解码后的 body，因为重新序列化 JSON 会破坏 HMAC。

## CLI

与英文版相同的五个命令：`listen`（捕获，`--out FILE` 每次捕获即落盘，Ctrl-C 不丢数据）、`verify`（验签，正确退出码 0、失败 1，`--json` 输出机器可读结果）、`sign`（打印签名，`--scheme sha256|sha1`）、`replay`（重放，缺 `--to` 报 `error: --to URL is required` 退出码 2）、`inspect`（`--json` / `--last N`）。完整帮助与逐条转录见上方英文节。

## 磁盘格式

捕获存储是一个 JSON 文件：`formatVersion`（当前为 1，版本不符时加载器直接拒绝而不是猜测）+ `captures` 数组。每条记录里 `body` 是解码后的可读形式（JSON body 解析为对象），`raw` 是收到的原始 utf8 文本；验签与重放读 `raw`。

一条保真限制：`raw` 以 UTF-8 文本存储，字节级保真的捕获与重放只对 UTF-8 文本载荷成立；非合法 UTF-8 的请求体（gzip、protobuf 等二进制载荷）经存储往返会失真，重放不保证逐字节一致。

## 库 API

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `createCaptureServer` | `(options: {port, host, outPath?}) => Promise<CaptureServer>` | `port: 0` 自动选端口；返回 `{port, url, captures, close()}` |
| `hmacVerify` | `(secret, headers, raw) => VerifyResult` | secret 在第一位；`VerifyResult = {valid, scheme, headerName, headerValue, computed, firstDiff?}` |
| `signBody` | `(secret, body, scheme?) => string` | 带 `sha256=` 前缀的十六进制摘要 |
| `replayCapture` | `(record, targetUrl, timeoutMs?) => Promise<ReplayResult>` | 第二个参数是 URL 字符串 |
| `loadCaptures` / `saveCaptures` | `(path)` / `(store, path)` | ENOENT 以 `.code` 保留并报告 |
| `describeRecord` | `(record) => string` | 单行摘要 |

## 开发

```bash
npm install
npm test          # pretest 先构建；离线，不访问网络
npm run coverage  # 阈值 80/70/85/80
npm run dev -- --help
npm run build
```

所有测试都在 loopback 服务器上离线运行，不触碰网络。

## 安全说明

- 签名比较使用 `timingSafeEqual`——不是提前退出的字符串比较。
- 验签从标准 GitHub webhook 头读取摘要；未知请求头被忽略而非信任。
- 捕获以明文 JSON 落盘。不要把 `listen --out` 指向共享目录：webhook 载荷可能包含只有在传输中受签名保护、落盘后不受保护的机密。
- `hmacVerify` 验证的是字节，不是发送方身份。GitHub 的 webhook secret 只证明载荷由持有 secret 的一方签名——真实发送方认证需要配合 TLS 或网络层控制。

## 许可证

[MIT](LICENSE)
