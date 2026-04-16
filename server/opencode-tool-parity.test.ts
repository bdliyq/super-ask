import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_SOURCE = join(HERE, "..", "rules", "super-ask-opencode-tool.ts");
const PLUGIN_STUB = `function chain() {
  return {
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  };
}

export function tool(config) {
  return config;
}

tool.schema = {
  string() {
    return chain();
  },
  array() {
    return chain();
  },
};
`;

async function withToolModule<T>(
  fn: (toolDef: { execute: (args: any, context: any) => Promise<string> }) => Promise<T>,
): Promise<T> {
  const originalHome = process.env.HOME;
  const originalServerUrl = process.env.SUPER_ASK_SERVER_URL;
  const originalServer = process.env.SUPER_ASK_SERVER;
  const originalRetries = process.env.SUPER_ASK_RETRIES;
  const originalToken = process.env.SUPER_ASK_AUTH_TOKEN;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalAbortTimeout = AbortSignal.timeout;
  const home = await mkdtemp(join(tmpdir(), "super-ask-opencode-home-"));
  const moduleRoot = await mkdtemp(join(tmpdir(), "super-ask-opencode-module-"));

  try {
    process.env.HOME = home;
    delete process.env.SUPER_ASK_SERVER_URL;
    delete process.env.SUPER_ASK_SERVER;
    delete process.env.SUPER_ASK_RETRIES;
    delete process.env.SUPER_ASK_AUTH_TOKEN;

    await mkdir(join(home, ".super-ask"), { recursive: true });
    await writeFile(join(home, ".super-ask", "token"), "test-token", "utf-8");

    const pluginDir = join(moduleRoot, "node_modules", "@opencode-ai", "plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@opencode-ai/plugin",
          type: "module",
          exports: "./index.js",
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(join(pluginDir, "index.js"), PLUGIN_STUB, "utf-8");

    const source = await readFile(TOOL_SOURCE, "utf-8");
    const toolPath = join(moduleRoot, "super-ask-opencode-tool.ts");
    await writeFile(toolPath, source, "utf-8");

    const imported = (await import(
      `${pathToFileURL(toolPath).href}?cacheBust=${Date.now()}-${Math.random()}`
    )) as {
      default: { execute: (args: any, context: any) => Promise<string> };
    };

    return await fn(imported.default);
  } finally {
    process.env.HOME = originalHome;
    if (originalServerUrl === undefined) {
      delete process.env.SUPER_ASK_SERVER_URL;
    } else {
      process.env.SUPER_ASK_SERVER_URL = originalServerUrl;
    }
    if (originalServer === undefined) {
      delete process.env.SUPER_ASK_SERVER;
    } else {
      process.env.SUPER_ASK_SERVER = originalServer;
    }
    if (originalRetries === undefined) {
      delete process.env.SUPER_ASK_RETRIES;
    } else {
      process.env.SUPER_ASK_RETRIES = originalRetries;
    }
    if (originalToken === undefined) {
      delete process.env.SUPER_ASK_AUTH_TOKEN;
    } else {
      process.env.SUPER_ASK_AUTH_TOKEN = originalToken;
    }
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    Object.defineProperty(AbortSignal, "timeout", {
      value: originalAbortTimeout,
      configurable: true,
      writable: true,
    });
    await rm(home, { recursive: true, force: true });
    await rm(moduleRoot, { recursive: true, force: true });
  }
}

function immediateSleep(delays: number[]): typeof setTimeout {
  return ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    delays.push(delay ?? 0);
    queueMicrotask(() => callback(...args));
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
}

function currentDateStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

test("OpenCode tool retries recoverable network errors indefinitely by default", async () => {
  await withToolModule(async (toolDef) => {
    const delays: number[] = [];
    let askAttempts = 0;
    let ackAttempts = 0;

    globalThis.setTimeout = immediateSleep(delays);
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/super-ask")) {
        askAttempts += 1;
        if (askAttempts <= 7) {
          throw new TypeError("connect ECONNREFUSED");
        }
        return new Response(
          JSON.stringify({ chatSessionId: "sid-network", feedback: "ok" }),
          { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
      }
      if (url.endsWith("/api/ack")) {
        ackAttempts += 1;
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const output = await toolDef.execute(
      { summary: "summary", question: "question" },
      { directory: "/tmp/workspace" },
    );

    assert.match(output, /"chatSessionId":"sid-network"/);
    assert.equal(askAttempts, 8);
    assert.equal(ackAttempts, 1);
    assert.deepEqual(delays, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  });
});

test("OpenCode tool retries fetch timeouts before succeeding", async () => {
  await withToolModule(async (toolDef) => {
    const delays: number[] = [];
    let askAttempts = 0;
    const seenSessionIds: string[] = [];

    globalThis.setTimeout = immediateSleep(delays);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/super-ask")) {
        askAttempts += 1;
        const body = init?.body != null ? JSON.parse(String(init.body)) : {};
        if (typeof body.chatSessionId === "string") {
          seenSessionIds.push(body.chatSessionId);
        }
        if (askAttempts <= 2) {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        return new Response(
          JSON.stringify({ chatSessionId: body.chatSessionId, feedback: "ok" }),
          { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
      }
      if (url.endsWith("/api/ack")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const output = await toolDef.execute(
      { summary: "summary", question: "question" },
      { directory: "/tmp/workspace" },
    );

    assert.match(output, /"feedback":"ok"/);
    assert.equal(askAttempts, 3);
    assert.equal(seenSessionIds.length, 3);
    assert.ok(seenSessionIds[0] && seenSessionIds.every((id) => id === seenSessionIds[0]));
    assert.deepEqual(delays, [10_000, 10_000]);
  });
});

test("OpenCode tool retries shutdown 503 responses before succeeding", async () => {
  await withToolModule(async (toolDef) => {
    const delays: number[] = [];
    let askAttempts = 0;

    globalThis.setTimeout = immediateSleep(delays);
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/super-ask")) {
        askAttempts += 1;
        if (askAttempts === 1) {
          return new Response(
            JSON.stringify({ error: "服务器正在关闭", code: "SERVER_SHUTTING_DOWN" }),
            { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } },
          );
        }
        return new Response(
          JSON.stringify({ chatSessionId: "sid-retry", feedback: "ok" }),
          { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
      }
      if (url.endsWith("/api/ack")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const output = await toolDef.execute(
      { summary: "summary", question: "question" },
      { directory: "/tmp/workspace" },
    );

    assert.match(output, /"chatSessionId":"sid-retry"/);
    assert.equal(askAttempts, 2);
    assert.deepEqual(delays, [10_000]);
  });
});

test("OpenCode tool writes daily log file with full request response retry and ack data", async () => {
  await withToolModule(async (toolDef) => {
    const delays: number[] = [];
    let askAttempts = 0;
    let ackAttempts = 0;

    globalThis.setTimeout = immediateSleep(delays);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/super-ask")) {
        askAttempts += 1;
        if (askAttempts === 1) {
          return new Response(
            JSON.stringify({ error: "服务器正在关闭", code: "SERVER_SHUTTING_DOWN" }),
            { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } },
          );
        }
        return new Response(
          JSON.stringify({ chatSessionId: "sid-log", feedback: "ok" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "X-Ask-Trace": "ask-ok",
            },
          },
        );
      }
      if (url.endsWith("/api/ack")) {
        ackAttempts += 1;
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const output = await toolDef.execute(
      {
        summary: "summary",
        question: "question",
        title: "title",
        options: ["ok"],
        workspaceRoot: "/tmp/workspace",
      },
      { directory: "/tmp/workspace" },
    );

    assert.match(output, /"chatSessionId":"sid-log"/);
    assert.equal(askAttempts, 2);
    assert.equal(ackAttempts, 1);

    const logPath = join(process.env.HOME!, ".super-ask", "logs", `${currentDateStamp()}.log`);
    const logContent = await readFile(logPath, "utf-8");

    assert.match(logContent, /"source":"opencode-tool"/);
    assert.match(logContent, /"event":"request\.attempt"/);
    assert.match(logContent, /"Authorization":"Bearer test-token"/);
    assert.match(logContent, /"summary":"summary"/);
    assert.match(logContent, /"question":"question"/);
    assert.match(logContent, /"workspaceRoot":"\/tmp\/workspace"/);
    assert.match(logContent, /"event":"response\.http_error"/);
    assert.match(logContent, /"SERVER_SHUTTING_DOWN"/);
    assert.match(logContent, /"event":"retry\.wait"/);
    assert.match(logContent, /"event":"response\.success"/);
    assert.match(logContent, /"x-ask-trace":"ask-ok"/);
    assert.match(logContent, /"chatSessionId":"sid-log"/);
    assert.match(logContent, /"feedback":"ok"/);
    assert.match(logContent, /"event":"ack\.success"/);
  });
});

test("OpenCode tool logs ack.error when ack returns non-ok http status", async () => {
  await withToolModule(async (toolDef) => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/super-ask")) {
        return new Response(
          JSON.stringify({ chatSessionId: "sid-ack-error", feedback: "ok" }),
          { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
      }
      if (url.endsWith("/api/ack")) {
        return new Response("ack failed", { status: 503 });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const output = await toolDef.execute(
      { summary: "summary", question: "question" },
      { directory: "/tmp/workspace" },
    );

    assert.match(output, /"chatSessionId":"sid-ack-error"/);

    const logPath = join(process.env.HOME!, ".super-ask", "logs", `${currentDateStamp()}.log`);
    const logContent = await readFile(logPath, "utf-8");

    assert.match(logContent, /"event":"ack\.error"/);
    assert.doesNotMatch(logContent, /"event":"ack\.success"/);
    assert.match(logContent, /"status":503/);
    assert.match(logContent, /"rawResponse":"ack failed"/);
  });
});

test("OpenCode tool fails fast on invalid response payloads", async () => {
  await withToolModule(async (toolDef) => {
    const delays: number[] = [];
    let askAttempts = 0;

    globalThis.setTimeout = immediateSleep(delays);
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/super-ask")) {
        askAttempts += 1;
        return new Response("not-json", { status: 200 });
      }
      if (url.endsWith("/api/ack")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    await assert.rejects(
      toolDef.execute(
        { summary: "summary", question: "question" },
        { directory: "/tmp/workspace" },
      ),
    );
    assert.equal(askAttempts, 1);
    assert.deepEqual(delays, []);
  });
});

test("OpenCode tool uses CLI-aligned request and ack timeouts", async () => {
  await withToolModule(async (toolDef) => {
    const delays: number[] = [];
    const seenTimeouts: number[] = [];

    globalThis.setTimeout = immediateSleep(delays);
    Object.defineProperty(AbortSignal, "timeout", {
      value: (ms: number) => {
        seenTimeouts.push(ms);
        return new AbortController().signal;
      },
      configurable: true,
      writable: true,
    });

    globalThis.fetch = async (input, init) => {
      assert.ok(init?.signal);
      const url = String(input);
      if (url.endsWith("/super-ask")) {
        return new Response(
          JSON.stringify({ chatSessionId: "sid-timeout", feedback: "ok" }),
          { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
      }
      if (url.endsWith("/api/ack")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    await toolDef.execute(
      { summary: "summary", question: "question" },
      { directory: "/tmp/workspace" },
    );

    assert.deepEqual(seenTimeouts, [86_400_000, 5_000]);
  });
});
