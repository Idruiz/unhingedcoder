// server.mjs
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

// IMPORTANT:
// These model names are placeholders for "future you" when GPT-5.1 Codex exists.
// TODAY, if you only have gpt-4.x, change these to models you actually have
// (for example CODE_MODEL = "gpt-4.1" and FALLBACK_MODEL = "gpt-4.1").
//
const CODE_MODEL = process.env.CODE_MODEL || "gpt-5.1-codex-max";
const FALLBACK_MODEL =
  process.env.FALLBACK_MODEL || "gpt-5.1-chat-latest"; // or "gpt-5.1"

// A “near max” output size for the fallback chat endpoint.
// Adjust down if you still hit context errors.
const MAX_CHAT_COMPLETION_TOKENS = 96000;

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "[WARN] OPENAI_API_KEY is not set. API calls will fail until you configure it."
  );
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 10 * 60 * 1000, // 10 minutes
});

// sessionId -> { id, messages: [{ role, content }] }
const sessions = new Map();

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

- Avoid meta-commentary. Keep explanation compact and put it AFTER the full code when needed.
`.trim();

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function getOrCreateSession(sessionId) {
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
  }
  let s = sessions.get(sessionId);
  if (!s) {
    s = { id: sessionId, messages: [] };
    sessions.set(sessionId, s);
  }
  return s;
}

// Be robust to slightly different Responses API shapes.
function extractTextFromResponse(resp) {
  if (!resp || !resp.output) return "";

  const chunks = [];

  for (const item of resp.output) {
    if (!item) continue;

    // Newer shape: item.content is an array; each element may have .text
    if (Array.isArray(item.content)) {
      for (const c of item.content) {
        if (typeof c.text === "string") {
          chunks.push(c.text);
        } else if (
          c.output_text &&
          typeof c.output_text.text === "string"
        ) {
          chunks.push(c.output_text.text);
        }
      }
    }

    // Some SDKs expose a convenience output_text field.
    if (item.output_text && typeof item.output_text.text === "string") {
      chunks.push(item.output_text.text);
    }
  }

  // Absolute fallback if library also provides resp.output_text.text
  if (resp.output_text && typeof resp.output_text.text === "string") {
    chunks.push(resp.output_text.text);
  }

  return chunks.join("").trim();
}

// Try Responses (CODE_MODEL) twice, then chat (FALLBACK_MODEL) once.
async function generateWithFallback(session) {
  const sessionMessages = session.messages || [];

  const responsesInput = [
    { role: "system", content: BASE_SYSTEM_PROMPT },
    ...sessionMessages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  let lastError = null;

  // -------------------- 1) Responses API (CODE_MODEL) --------------------
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(
        `[Responses] Attempt ${attempt} with model=${CODE_MODEL} for session=${session.id}`
      );

      const resp = await openai.responses.create({
        model: CODE_MODEL,
        input: responsesInput,
        reasoning: { effort: "xhigh" },
        // No explicit max_output_tokens → let model push as far as it can.
        // Leave truncation at default ("disabled") so we see real errors.
      });

      const text = extractTextFromResponse(resp);
      if (text) {
        console.log(
          `[Responses] Success on attempt ${attempt} (length=${text.length})`
        );
        return {
          text,
          modelUsed: CODE_MODEL,
          fromFallback: false,
        };
      }

      lastError = new Error("Empty output from Responses API");
      console.error(
        `[Responses] Empty output on attempt ${attempt}`,
        JSON.stringify(resp, null, 2)
      );
    } catch (err) {
      lastError = err;
      console.error(
        `[Responses] Error on attempt ${attempt}:`,
        err?.message || err
      );
    }
  }

  // -------------------- 2) Chat Completions fallback ---------------------
  const chatMessages = [
    { role: "system", content: BASE_SYSTEM_PROMPT },
    ...sessionMessages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  try {
    console.log(
      `[ChatFallback] Calling chat.completions with model=${FALLBACK_MODEL}`
    );

    const completion = await openai.chat.completions.create({
      model: FALLBACK_MODEL,
      messages: chatMessages,
      max_completion_tokens: MAX_CHAT_COMPLETION_TOKENS,
    });

    const text =
      completion.choices?.[0]?.message?.content ||
      "[No content returned from fallback model]";

    console.log(
      `[ChatFallback] Success (length=${text.length})`
    );

    return {
      text,
      modelUsed: FALLBACK_MODEL,
      fromFallback: true,
    };
  } catch (err) {
    console.error("[ChatFallback] FAILED:", err?.message || err);
    // Preserve the original Responses error if there was one.
    throw lastError || err;
  }
}

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------

const app = express();

app.use(
  express.json({
    limit: "20mb", // large text blobs
  })
);

// Resolve __dirname under ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files (index.html, prompt-architect.html, etc.)
app.use(express.static(__dirname));

// Health check for Render
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ------------------------- /api/chat --------------------------------------

app.post("/api/chat", async (req, res) => {
  res.setTimeout(10 * 60 * 1000); // 10 minutes

  try {
    const { sessionId, message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res
        .status(400)
        .json({ error: "Missing 'message' in request body." });
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
        err?.message ||
        "Unexpected error in /api/chat (check server logs for details).",
    });
  }
});

// ------------------------- /api/upload ------------------------------------

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
      return res
        .status(400)
        .json({ error: "Missing 'fileName' in request body." });
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
        err?.message ||
        "Unexpected error in /api/upload (likely file too large or model timeout).",
    });
  }
});

// Fallback route – send index.html for unknown GETs
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Unhinged Codex server listening on port ${PORT}`);
});
