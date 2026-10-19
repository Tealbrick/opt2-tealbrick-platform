import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig, redact, report } from "./wp-failed.ts";

const TOKEN = "wp-test-token-abcdefgh";
// fake secrets are assembled at runtime so the repo's secret scan (gitleaks) never sees a key-shaped literal
const SK = ["sk", "live", "abcdefgh12345678"].join("_");
const GHP = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
const WHSEC = ["whsec", "abcdefgh123"].join("_");
const GPAT = ["github", "pat", "11ABCDEFG0123456789", "abcdefghijkl"].join("_");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
let server: Server;
let url = "";
const methods: string[] = [];
let authOk = true;

before(async () => {
  server = createServer((req, res) => {
    methods.push(req.method ?? "");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) authOk = false;
    const u = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === "/api/repos/lookup/Tealbrick/opt2-tealbrick-sdk") return json(200, { id: 18, full_name: "Tealbrick/opt2-tealbrick-sdk" });
    if (u.pathname === "/api/repos/18/pipelines") return json(200, [{ number: 202, status: "failure", commit: "22e154d24803c94b26475c2e79297b04825b9a72" }]);
    if (u.pathname === "/api/repos/18/pipelines/202")
      return json(200, {
        number: 202,
        status: "failure",
        event: "push",
        branch: "main",
        commit: "22e154d24803c94b26475c2e79297b04825b9a72",
        workflows: [
          {
            id: 1,
            name: "ci",
            state: "failure",
            children: [
              { id: 11, name: "setup", state: "success", exit_code: 0 },
              { id: 12, name: "unit", state: "failure", exit_code: 1 },
              { id: 13, name: "image-check", state: "skipped" },
            ],
          },
        ],
      });
    if (u.pathname === "/api/repos/18/logs/202/12")
      return json(
        200,
        Array.from({ length: 50 }, (_, i) => ({ data: b64(`line ${i}\n`) })).concat([
          { data: b64(`token ${GHP} leaked\n`) },
          { data: b64(`auth: Bearer ${TOKEN}\n`) },
          { data: b64(`key ${SK} and ${WHSEC} and ${GPAT}\n`) },
        ]),
      );
    json(404, { message: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe("ops/wp-failed", () => {
  test("finds the pipeline by commit, lists non-skipped steps, prints the failed step's last 40 lines redacted; GET only", async () => {
    const out = await report("Tealbrick/opt2-tealbrick-sdk", "22e154d", { url, token: TOKEN });
    const text = out.join("\n");
    assert.match(out[0] as string, /pipeline 202 .*: failure/);
    assert.match(text, /ci\/setup: success \(exit 0\)/);
    assert.match(text, /ci\/unit: failure \(exit 1\)/);
    assert.doesNotMatch(text, /image-check/);
    assert.match(text, /last 40 log lines of ci\/unit/);
    assert.doesNotMatch(text, /line 12\b/); // older than the last 40
    assert.match(text, /line 49/);
    // redaction fires on every pattern and on the token itself (L34: bad case)
    for (const secret of [GHP, TOKEN, SK, WHSEC, GPAT]) assert.doesNotMatch(text, new RegExp(secret));
    assert.match(text, /\[redacted\]/);
    assert.ok(
      methods.every((m) => m === "GET"),
      methods.join(","),
    );
    assert.equal(authOk, true);
  });
  test("by pipeline number; a bad ref is refused before any request", async () => {
    const out = await report("Tealbrick/opt2-tealbrick-sdk", "202", { url, token: TOKEN });
    assert.match(out[0] as string, /pipeline 202/);
    await assert.rejects(report("Tealbrick/opt2-tealbrick-sdk", "main", { url, token: TOKEN }), /commit sha/);
  });
  test("redact is quiet on ordinary text (L34 good case)", () => {
    assert.equal(redact("pnpm test: 120 passed, sk_ is a prefix, Bearer x"), "pnpm test: 120 passed, sk_ is a prefix, Bearer x");
  });
  test("loadConfig reads hosts.env and the token file and never returns more than it needs", () => {
    const dir = mkdtempSync(join(tmpdir(), "wpf-"));
    try {
      writeFileSync(join(dir, "hosts.env"), "OTHER=1\nWOODPECKER_URL=https://wp.example/\n");
      writeFileSync(join(dir, "woodpecker-token"), `${TOKEN}\n`);
      const c = loadConfig({}, dir);
      assert.deepEqual(c, { url: "https://wp.example", token: TOKEN });
      assert.equal(loadConfig({ WOODPECKER_URL: "https://env.example" }, dir).url, "https://env.example");
      rmSync(join(dir, "woodpecker-token"));
      assert.throws(() => loadConfig({}, dir), /no Woodpecker token file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("redact strips terminal control sequences (ANSI colours, OSC titles)", () => {
  assert.equal(redact("\u001b[1;3mREDACTED\u001b[0m ok \u001b]0;title\u0007done"), "REDACTED ok done");
});
