// server.mjs
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

// --- CONFIG --------------------------------------------------------------

const PORT = process.env.PORT || 3000;

// Primary coding model: GPT-5.1 Codex-Max via Responses API
// Model name taken from official OpenAI SDK release notes.:contentReference[oaicite:1]{index=1}
const CODE_MODEL = "gpt-5.1-codex-max";

// Fallback model: full GPT-5.1 via Chat Completions (non-mini).
// If OpenAI later exposes a "gpt-5.1-chat-latest" alias, you can swap it here.
const FALLBACK_MODEL = "gpt-5.1";

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "[WARN] OPENAI_API_KEY is not set. API calls will fail until you configure it."
  );
}

// OpenAI client (Node SDK v6+)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // Prefer long timeouts so huge generations have a chance to finish.
  timeout: 10 * 60 * 1000, // 10 minutes
});

// In-memory sessions: sessionId -> { messages: [ { role, content } ] }
const sessions = new Map();

// System prompt to force giant, code-heavy outputs.
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

// --- HELPER FUNCTIONS ----------------------------------------------------

// Ensure a session object exists
function getOrCreateSession(sessionId) {
  if (!sessionId) {
    // Extremely unlikely if frontend is correct, but guard anyway.
    sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  let session = sessions.get(sessionId);
  if (!session) {
    session = { id: sessionId, messages: [] };
    sessions.set(sessionId, session);
  }
  return session;
}

// Extract plain text from Responses API output
function extractTextFromResponse(response) {
  if (!response || !Array.isArray(response.output)) return "";

  const chunks = [];

  for (const item of response.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && typeof part.text === "string") {
          chunks.push(part.text);
        }
      }
    }
  }

  return chunks.join("\n");
}

// Core generation function: try Responses (Codex-Max) twice, then fallback to Chat Completions.
async function generateWithFallback(session) {
  const sessionMessages = session.messages || [];

  // Build unified "input items" for Responses API.
  // The Responses API accepts an array of message-like items for multi-turn context.:contentReference[oaicite:2]{index=2}
  const responsesInput = [
    { role: "system", content: BASE_SYSTEM_PROMPT },
    ...sessionMessages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  let lastError = null;

  // --- 1) Try GPT-5.1 Codex-Max via Responses API (up to 2 attempts) ------
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await openai.responses.create({
        model: CODE_MODEL,
        input: responsesInput,
        reasoning: { effort: "xhigh" }, // maximize planning for big codegen:contentReference[oaicite:3]{index=3}
        temperature: 0.2,
        // Intentional: omit max_output_tokens to let the model push output length
        // up to its internal limits instead of artificially capping it.:contentReference[oaicite:4]{index=4}
        truncation: "disabled",
      });

      const text = extractTextFromResponse(resp);
      if (text && text.trim().length > 0) {
        return {
          text,
          modelUsed: CODE_MODEL,
          fromFallback: false,
        };
      }

      lastError = new Error("Empty or invalid output from Responses API");
      console.error("[ERROR] Responses output empty on attempt", attempt);
    } catch (err) {
      lastError = err;
      console.error(
        `[ERROR] Responses API call failed on attempt ${attempt}:`,
        err?.message || err
      );
    }
  }

  // --- 2) Fallback to GPT-5.1 via Chat Completions -----------------------
  // Build chat-style messages for the fallback.
  // Newer OpenAI chat API supports roles including 'developer' for system-like instructions.:contentReference[oaicite:5]{index=5}
  const chatMessages = [
    { role: "developer", content: BASE_SYSTEM_PROMPT },
    ...sessionMessages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: FALLBACK_MODEL,
      messages: chatMessages,
      temperature: 0.2,
      // Aggressively high; API will clamp to its max if necessary.:contentReference[oaicite:6]{index=6}
      max_completion_tokens: 32000,
      reasoning_effort: "high",
    });

    const text =
      completion.choices?.[0]?.message?.content ||
      "[No content returned from fallback model]";

    return {
      text,
      modelUsed: FALLBACK_MODEL,
      fromFallback: true,
    };
  } catch (err) {
    console.error("[FATAL] Fallback Chat Completions call failed:", err);
    throw lastError || err;
  }
}

// --- EXPRESS APP ---------------------------------------------------------

const app = express();

// Allow very large JSON payloads; you're pushing big prompts + code.
app.use(
  express.json({
    limit: "20mb",
  })
);

// Resolve current directory in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the frontend (index.html in same directory)
app.use(express.static(__dirname));

// Health check (handy for Render)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Chat endpoint: generates huge code output with full session memory
app.post("/api/chat", async (req, res) => {
  res.setTimeout(10 * 60 * 1000); // 10 minutes per request

  try {
    const { sessionId, message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' in request." });
    }

    const session = getOrCreateSession(sessionId);

    // Append user message into session history
    session.messages.push({
      role: "user",
      content: message,
    });

    const result = await generateWithFallback(session);

    // Append assistant output as well for continuity
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
        "Unexpected error in /api/chat. Check server logs for details. (Likely model timeout or token limit.)",
    });
  }
});

// Upload endpoint: send (possibly large) code for review/refactor
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

    // We only treat text-like content as actual source; other formats become metadata.
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
      // Truncate very large text files (keep head + tail) to avoid blowing context.
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
      // Binary/unsupported formats (zip, docx, etc.) – we cannot introspect contents.
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

// Fallback route – serve index.html for any unknown GET (SPA-ish)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`Unhinged Codex Chat server listening on port ${PORT}`);
});
