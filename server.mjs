// server.mjs
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

// Primary model: full GPT-5.1 via Chat Completions (not mini).
// This is stable and available via the standard chat endpoint.
const CHAT_MODEL = "gpt-5.1";

// OPTIONAL: Codex via Responses API as secondary fallback.
// Leave this as null to completely disable Responses.
// If you KNOW your account has gpt-5.1 Codex, set this to "gpt-5.1-codex-max".
const CODEX_MODEL = null; // "gpt-5.1-codex-max";

// OpenAI client
if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "[WARN] OPENAI_API_KEY is not set. API calls will fail until you configure it."
  );
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 10 * 60 * 1000, // 10 minutes for monster generations
});

// In-memory sessions: sessionId -> { id, messages: [ { role, content } ] }
const sessions = new Map();

// System prompt: maximize code, minimize yapping.
const BASE_SYSTEM_PROMPT = `
You are an elite senior software engineer and code generation engine.

GOALS:
- Generate extremely large, production-quality codebases from detailed prompts.
- When asked to "refactor", "review", or "improve" code, output the FULL revised code, not just comments.
- Prefer complete multi-file style outputs inline (clear file headers in comments) rather than vague advice.

BEHAVIOR:
- Treat each conversation as a coding session with full memory of prior messages.
- Assume the user wants the MAXIMUM safe amount of code the API will allow in a single response.
- Do NOT summarize unless explicitly asked. Prioritize code over explanation.
- When refactoring uploaded code, output the improved version in full.
- Use clear file separators like:
// file: src/server.ts
// file: src/components/App.tsx

- Keep explanation short and put it AFTER the full code when needed.
`.trim();

// ---------------------------------------------------------------------------
// SESSION HELPERS
// ---------------------------------------------------------------------------

function getOrCreateSession(sessionId) {
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  let session = sessions.get(sessionId);
  if (!session) {
    session = { id: sessionId, messages: [] };
    sessions.set(sessionId, session);
  }
  return session;
}

// ---------------------------------------------------------------------------
// MODEL CALLS
// ---------------------------------------------------------------------------

async function generateWithChat(session) {
  const messages = [
    { role: "system", content: BASE_SYSTEM_PROMPT },
    ...(session.messages || []),
  ];

  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages,
        // Ask for a ridiculous amount; API will clamp to its max.
    max_output_tokens: 100000,
  });

  const text =
    completion.choices?.[0]?.message?.content ||
    "[No content returned by chat completion]";

  return {
    text,
    modelUsed: CHAT_MODEL,
    fromFallback: false,
  };
}

// Only used if CODEX_MODEL is non-null AND chat path fails.
// This is defensive so Codex can never silently kill the app.
async function generateWithResponses(session) {
  if (!CODEX_MODEL) {
    throw new Error(
      "Responses fallback requested but CODEX_MODEL is not configured."
    );
  }

  const input = [
    { role: "system", content: BASE_SYSTEM_PROMPT },
    ...(session.messages || []),
  ];

  const resp = await openai.responses.create({
    model: CODEX_MODEL,
    input,
        max_output_tokens: 100000,
  });

  const chunks = [];
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (typeof part.text === "string") {
            chunks.push(part.text);
          }
        }
      }
    }
  }

  const text = chunks.join("\n").trim();

  if (!text) {
    throw new Error("Responses API returned empty output.");
  }

  return {
    text,
    modelUsed: CODEX_MODEL,
    fromFallback: true,
  };
}

// Primary -> fallback wrapper
async function generateWithFallback(session) {
  let lastError = null;

  // 1) Try chat.completions (GPT-5.1)
  try {
    return await generateWithChat(session);
  } catch (err) {
    lastError = err;
    console.error("[ERROR] Chat completion failed:", err?.message || err);
  }

  // 2) Try Responses (Codex) only if configured
  if (CODEX_MODEL) {
    try {
      return await generateWithResponses(session);
    } catch (err) {
      lastError = err;
      console.error("[ERROR] Responses fallback failed:", err?.message || err);
    }
  }

  // 3) All paths failed
  throw lastError || new Error("All model calls failed.");
}

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------

const app = express();

app.use(
  express.json({
    limit: "20mb", // allow huge prompts/uploads
  })
);

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static frontend (index.html + prompt-architect.html)
app.use(express.static(__dirname));

// Health check for Render
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// /api/chat : main Unhinged chat endpoint
// ---------------------------------------------------------------------------

app.post("/api/chat", async (req, res) => {
  res.setTimeout(10 * 60 * 1000); // 10 minutes

  try {
    const { sessionId, message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' in request." });
    }

    const session = getOrCreateSession(sessionId);

    session.messages.push({
      role: "user",
      content: message,
    });

    const result = await generateWithFallback(session);

    session.messages.push({
      role: "assistant",
      content: result.text,
    });

    res.json({
      assistantText: result.text,
      modelUsed: result.modelUsed,
      fromFallback: result.fromFallback,
      sessionId: session.id,
    });
  } catch (err) {
    console.error("[/api/chat] Unhandled error:", err);
    res.status(500).json({
      error:
        "Unexpected error in /api/chat. Check server logs on Render for details.",
    });
  }
});

// ---------------------------------------------------------------------------
// /api/upload : send a code file for review / refactor
// ---------------------------------------------------------------------------

app.post("/api/upload", async (req, res) => {
  res.setTimeout(10 * 60 * 1000);

  try {
    const {
      sessionId,
      fileName,
      fileType,
      fileSize,
      fileContent,
      instructions,
    } = req.body || {};

    if (!fileName) {
      return res.status(400).json({ error: "Missing 'fileName' in request." });
    }

    const session = getOrCreateSession(sessionId);
    const humanSize =
      typeof fileSize === "number"
        ? `${(fileSize / 1024).toFixed(1)} KB`
        : "unknown size";

    let messageForModel = "";

    if (
      typeof fileContent === "string" &&
      fileContent.trim().length > 0 &&
      fileContent.length <= 200000
    ) {
      // Normal sized text code file
      messageForModel = `
The user uploaded a code file for review/refactor.

File name: ${fileName}
MIME type: ${fileType || "unknown"}
Size: ${humanSize}

Here is the full (or near full) content of the file:

${fileContent}

USER REQUEST / CONTEXT:
${instructions || "Refactor and improve this code. Fix bugs and improve structure."}

Please refactor and improve this code. Output the full improved version, not just bullet points.
      `.trim();
    } else if (
      typeof fileContent === "string" &&
      fileContent.trim().length > 0
    ) {
      // Very large text file: keep head + tail and tell the model what we did
      const MAX_CHARS = 200000;
      const half = Math.floor(MAX_CHARS / 2);
      const head = fileContent.slice(0, half);
      const tail = fileContent.slice(-half);
      const omitted = fileContent.length - MAX_CHARS;

      messageForModel = `
The user uploaded a very large code file for review/refactor.

File name: ${fileName}
MIME type: ${fileType || "unknown"}
Size: ${humanSize}
Original length (chars): ${fileContent.length}
NOTE: Content has been truncated to fit within model limits. Approximately ${omitted} characters omitted.

--- BEGIN TRUNCATED CONTENT (HEAD) ---
${head}
--- MIDDLE OMITTED ---
${tail}
--- END TRUNCATED CONTENT ---

USER REQUEST / CONTEXT:
${instructions || "Refactor and improve this code. Fix bugs and improve structure."}

Please refactor and improve this code. Focus on architecture, clarity, and obvious issues based on the visible portions. Output full revised code where possible.
      `.trim();
    } else {
      // Binary / unknown formats
      messageForModel = `
The user uploaded a non-text or unsupported file for refactoring.

File name: ${fileName}
MIME type: ${fileType || "unknown"}
Size: ${humanSize}

The raw contents are not available in this minimal webapp (e.g. .zip or .docx).
Based on the user's description, provide high-level advice on how to refactor and improve the codebase, focusing on architecture, modularization, testing, and maintainability.

USER REQUEST / CONTEXT:
${instructions || "High-level refactor strategy for this codebase."}
      `.trim();
    }

    session.messages.push({
      role: "user",
      content: messageForModel,
    });

    const result = await generateWithFallback(session);

    session.messages.push({
      role: "assistant",
      content: result.text,
    });

    res.json({
      assistantText: result.text,
      modelUsed: result.modelUsed,
      fromFallback: result.fromFallback,
      sessionId: session.id,
    });
  } catch (err) {
    console.error("[/api/upload] Unhandled error:", err);
    res.status(500).json({
      error:
        "Unexpected error in /api/upload. Likely file too large or model timeout.",
    });
  }
});

// ---------------------------------------------------------------------------
// SPA-style fallback: always serve index.html for unknown GETs
// ---------------------------------------------------------------------------

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Unhinged Codex server listening on port ${PORT}`);
});
