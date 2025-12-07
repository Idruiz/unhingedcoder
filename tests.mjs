// tests.mjs
//
// Loud integration tests for:
// - Backend: server.mjs (health, chat, upload)
// - Frontend: index.html, prompt-architect.html
//
// Run with:  OPENAI_API_KEY=sk-... node tests.mjs

import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;

if (!process.env.OPENAI_API_KEY) {
  console.error(`
========================================================================
🔥 FATAL: OPENAI_API_KEY is NOT set in the environment.
   These tests call the real OpenAI API through your backend.
   Export OPENAI_API_KEY before running:
   - macOS/Linux:  export OPENAI_API_KEY="sk-..."
   - Windows PS:   $env:OPENAI_API_KEY="sk-..."
========================================================================
`);
  process.exit(1);
}

let serverProcess = null;

// ---------------------------- UTILITIES ---------------------------------

function banner(title) {
  console.log(`
========================================================================
🚨 TEST BLOCK: ${title}
========================================================================`);
}

function httpRequestJson({ method, path: reqPath, body }) {
  const url = new URL(reqPath, BASE_URL);

  const options = {
    method,
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    headers: {
      "Content-Type": "application/json",
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (err) {
          console.error("🔥 JSON parse error for response:", raw);
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      console.error("🔥 HTTP request error:", err.message || err);
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function waitForServerReady(timeoutMs = 30000) {
  banner("WAITING FOR BACKEND TO COME ONLINE");
  const start = Date.now();

  // Hit /health repeatedly until it responds or timeout
  while (Date.now() - start < timeoutMs) {
    try {
      const { status, body } = await httpRequestJson({
        method: "GET",
        path: "/health",
      });
      console.log("Health check status:", status, "body:", body);
      if (status === 200 && body && body.status === "ok") {
        console.log("✅ Backend /health responded OK. Moving on.");
        return;
      }
    } catch (err) {
      console.log("... /health not ready yet:", err.message || err);
    }
    await delay(1000);
  }

  throw new Error("Backend did not become ready within timeout.");
}

async function startServer() {
  banner("STARTING BACKEND SERVER (server.mjs)");

  if (serverProcess) {
    console.log("⚠️  Server already running, skipping start.");
    return;
  }

  serverProcess = spawn("node", ["server.mjs"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (data) => {
    process.stdout.write(`(server stdout) ${data}`);
  });
  serverProcess.stderr.on("data", (data) => {
    process.stderr.write(`(server stderr) ${data}`);
  });

  serverProcess.on("exit", (code, signal) => {
    console.log(
      `⚠️  Backend server process exited. code=${code} signal=${signal}`
    );
  });

  await waitForServerReady();
}

function stopServer() {
  banner("STOPPING BACKEND SERVER");
  if (serverProcess) {
    try {
      serverProcess.kill();
      console.log("✅ Sent kill signal to backend server.");
    } catch (err) {
      console.error("🔥 Failed to kill server process:", err);
    }
    serverProcess = null;
  } else {
    console.log("ℹ️  No server process to stop.");
  }
}

// Start server ONCE before all tests
await startServer();

// Ensure we stop the server on exit
process.on("exit", () => {
  stopServer();
});

// ---------------------------- BACKEND TESTS ------------------------------

test("BACKEND :: /health screams OK", async () => {
  banner("BACKEND /health");

  const { status, body } = await httpRequestJson({
    method: "GET",
    path: "/health",
  });

  console.log("🔍 /health response:", status, body);
  assert.strictEqual(status, 200);
  assert.ok(body && body.status === "ok", "Body.status should be 'ok'");
});

test("BACKEND :: /api/chat returns assistantText and sessionId", async () => {
  banner("BACKEND /api/chat");

  const payload = {
    sessionId: "test-session-chat",
    message:
      "Test prompt: briefly describe what this Unhinged Codex server is supposed to do.",
  };

  const { status, body } = await httpRequestJson({
    method: "POST",
    path: "/api/chat",
    body: payload,
  });

  console.log("🔍 /api/chat status:", status);
  console.log(
    "🔍 /api/chat body keys:",
    body ? Object.keys(body) : "no body"
  );

  assert.strictEqual(
    status,
    200,
    "Expected HTTP 200 from /api/chat but got " + status
  );

  assert.ok(body.sessionId, "Expected a sessionId in response.");
  assert.ok(
    typeof body.assistantText === "string" &&
      body.assistantText.trim().length > 0,
    "Expected non-empty assistantText."
  );

  const snippet = body.assistantText.slice(0, 400);
  console.log(`
----------- /api/chat ASSISTANT SNIPPET (first 400 chars) ---------------
${snippet}
-------------------------------------------------------------------------`);
});

test("BACKEND :: /api/upload handles text code and returns refactor output", async () => {
  banner("BACKEND /api/upload");

  const fakeFileContent = `
function add(a, b){
return a+ b // intentionally sloppy formatting
}
`;

  const payload = {
    sessionId: "test-session-upload",
    fileName: "test-code.js",
    fileType: "text/javascript",
    fileSize: fakeFileContent.length,
    fileContent: fakeFileContent,
    instructions: "Clean this up and make it more robust.",
  };

  const { status, body } = await httpRequestJson({
    method: "POST",
    path: "/api/upload",
    body: payload,
  });

  console.log("🔍 /api/upload status:", status);
  console.log(
    "🔍 /api/upload body keys:",
    body ? Object.keys(body) : "no body"
  );

  assert.strictEqual(
    status,
    200,
    "Expected HTTP 200 from /api/upload but got " + status
  );
  assert.ok(body.sessionId, "Expected sessionId from /api/upload.");
  assert.ok(
    typeof body.assistantText === "string" &&
      body.assistantText.trim().length > 0,
    "Expected non-empty assistantText from /api/upload."
  );

  const snippet = body.assistantText.slice(0, 400);
  console.log(`
----------- /api/upload ASSISTANT SNIPPET (first 400 chars) -------------
${snippet}
-------------------------------------------------------------------------`);
});

// ---------------------------- FRONTEND TESTS -----------------------------

test("FRONTEND :: index.html (Unhinged) has core anchors", async () => {
  banner("FRONTEND index.html STRUCTURE CHECK");

  const filePath = path.join(__dirname, "index.html");
  const html = fs.readFileSync(filePath, "utf8");

  function assertContains(id) {
    const needle = `id="${id}"`;
    console.log(`🔎 Checking index.html for ${needle}`);
    assert.ok(
      html.includes(needle),
      `Expected index.html to contain ${needle}`
    );
  }

  assertContains("messages");
  assertContains("prompt");
  assertContains("send-btn");
  assertContains("file-input");
  assertContains("upload-btn");
  assertContains("clear-session-btn");
  assertContains("open-architect-btn");

  console.log("✅ index.html appears to have all core anchors in place.");
});

test("FRONTEND :: prompt-architect.html has preview + controls", async () => {
  banner("FRONTEND prompt-architect.html STRUCTURE CHECK");

  const filePath = path.join(__dirname, "prompt-architect.html");
  const html = fs.readFileSync(filePath, "utf8");

  function assertContains(id) {
    const needle = `id="${id}"`;
    console.log(`🔎 Checking prompt-architect.html for ${needle}`);
    assert.ok(
      html.includes(needle),
      `Expected prompt-architect.html to contain ${needle}`
    );
  }

  assertContains("preview");
  assertContains("regen-btn");
  assertContains("copy-btn");
  assertContains("reset-btn");
  assertContains("projectTitle");
  assertContains("overallGoal");
  assertContains("fileList");

  console.log(
    "✅ prompt-architect.html appears to have its core elements wired."
  );
});

console.log(`
========================================================================
✅ All tests have been scheduled. Node's test runner will execute them now.
========================================================================
`);
