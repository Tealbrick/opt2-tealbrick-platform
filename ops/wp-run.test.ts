// C254: ops/wp-run.ts against a fake Woodpecker (no network, no real token).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { line, parseArgs, run } from "./wp-run.ts";

const TOKEN = "wp-test-token-abcdefgh";
let server: Server;
let url = "";
const calls: { method: string; path: string; body: string; auth: boolean }[] = [];
let polls = 0;
let finalState = "success";

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      calls.push({ method: req.method ?? "", path, body, auth: req.headers.authorization === `Bearer ${TOKEN}` });
      const json = (code: number, b: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (path === "/api/repos/lookup/Tealbrick/opt2-tealbrick-portal-core") return json(200, { id: 7 });
      if (path === "/api/repos/7/pipelines" && req.method === "POST")
        return json(200, { number: 301, status: "pending", event: "manual", branch: "hotfix/sp1", commit: "8593bfb6fd51f4a5d4c2d1dccedb8218e199f0e7" });
      if (path === "/api/repos/7/pipelines/301") {
        polls++;
        return json(200, {
          number: 301,
          status: polls < 2 ? "running" : finalState,
          event: "manual",
          branch: "hotfix/sp1",
          commit: "8593bfb6fd51f4a5d4c2d1dccedb8218e199f0e7",
        });
      }
      return json(404, { message: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe("wp-run", () => {
  test("parseArgs: repo, branch, vars, wait; refusals", () => {
    assert.deepEqual(parseArgs(["Tealbrick/opt2-tealbrick-portal-core", "hotfix/sp1", "--var", "RUN_MODE=full", "--wait"]), {
      slug: "Tealbrick/opt2-tealbrick-portal-core",
      branch: "hotfix/sp1",
      variables: { RUN_MODE: "full" },
      wait: true,
      timeoutMin: 30,
    });
    assert.throws(() => parseArgs(["Tealbrick/x"]), /branch/);
    assert.throws(() => parseArgs(["x", "main"]), /owner\/repo/);
    assert.throws(() => parseArgs(["Tealbrick/x", "a..b"]), /branch/);
    assert.throws(() => parseArgs(["Tealbrick/x", "main", "--var", "lower=1"]), /UPPER_SNAKE/);
    assert.throws(() => parseArgs(["Tealbrick/x", "main", "--token", "t"]), /unknown option/);
    assert.throws(() => parseArgs(["Tealbrick/x", "main", "--timeout-min", "0"]), /1\.\.180/);
  });

  test("run --wait: POSTs one manual pipeline, polls until final, prints number/branch/commit/state only", async () => {
    calls.length = 0;
    polls = 0;
    finalState = "success";
    const lines: string[] = [];
    const p = await run(
      { slug: "Tealbrick/opt2-tealbrick-portal-core", branch: "hotfix/sp1", variables: {}, wait: true, timeoutMin: 5 },
      { url, token: TOKEN, sleepMs: 1 },
      (s) => lines.push(s),
    );
    assert.equal(p.status, "success");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      [
        "GET /api/repos/lookup/Tealbrick/opt2-tealbrick-portal-core",
        "POST /api/repos/7/pipelines",
        "GET /api/repos/7/pipelines/301",
        "GET /api/repos/7/pipelines/301",
      ],
    );
    assert.ok(
      calls.every((c) => c.auth),
      "every call carries the bearer token",
    );
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), { branch: "hotfix/sp1", variables: {} });
    assert.deepEqual(lines, [
      "Tealbrick/opt2-tealbrick-portal-core pipeline 301 (manual hotfix/sp1 8593bfb6fd51): pending",
      "Tealbrick/opt2-tealbrick-portal-core pipeline 301 (manual hotfix/sp1 8593bfb6fd51): running",
      "Tealbrick/opt2-tealbrick-portal-core pipeline 301 (manual hotfix/sp1 8593bfb6fd51): success",
    ]);
    assert.ok(!lines.join("\n").includes(TOKEN), "the token is never printed");
  });

  test("run --wait: a failed pipeline is returned as failure; without --wait only the trigger line", async () => {
    polls = 0;
    finalState = "failure";
    const p = await run(
      { slug: "Tealbrick/opt2-tealbrick-portal-core", branch: "hotfix/sp1", variables: {}, wait: true, timeoutMin: 5 },
      { url, token: TOKEN, sleepMs: 1 },
      () => {},
    );
    assert.equal(p.status, "failure");
    const lines: string[] = [];
    const q = await run(
      { slug: "Tealbrick/opt2-tealbrick-portal-core", branch: "hotfix/sp1", variables: {}, wait: false, timeoutMin: 5 },
      { url, token: TOKEN },
      (s) => lines.push(s),
    );
    assert.equal(q.status, "pending");
    assert.equal(lines.length, 1);
  });

  test("run: an unknown repo is an HTTP error naming the path, not the token", async () => {
    await assert.rejects(
      run({ slug: "Tealbrick/nope", branch: "main", variables: {}, wait: false, timeoutMin: 5 }, { url, token: TOKEN }),
      (e: Error) => /GET \/repos\/lookup\/Tealbrick\/nope: HTTP 404/.test(e.message) && !e.message.includes(TOKEN),
    );
  });

  test("line: compact format", () => {
    assert.equal(
      line("o/r", { number: 1, status: "success", commit: "abcdef0123456789", branch: "main", event: "manual" }),
      "o/r pipeline 1 (manual main abcdef012345): success",
    );
  });
});
