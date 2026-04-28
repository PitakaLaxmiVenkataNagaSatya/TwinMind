import express from "express";
import multer from "multer";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function required(value, message) {
  if (!value) {
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
}

function buildTranscriptContext(entries, limit) {
  const slice = entries.slice(-limit);
  return slice.map((item) => `[${item.timestamp}] ${item.text}`).join("\n");
}

async function groqChatCompletions({ apiKey, model, messages, temperature = 0.3, maxTokens = 700 }) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Groq chat error: ${response.status} ${text}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

app.post("/api/transcribe", upload.single("audio"), async (req, res, next) => {
  try {
    const headerKey = (req.header("x-groq-api-key") || "").trim();
    const apiKey = headerKey || process.env.GROQ_API_KEY;
    required(apiKey, "Missing Groq API key.");
    required(req.file, "Missing audio file.");

    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" });
    const formData = new FormData();
    formData.append("file", blob, req.file.originalname || "chunk.webm");
    formData.append("model", "whisper-large-v3");
    formData.append("response_format", "verbose_json");
    formData.append("language", "en");

    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!groqRes.ok) {
      const text = await groqRes.text();
      const error = new Error(`Groq transcription error: ${groqRes.status} ${text}`);
      error.status = groqRes.status;
      throw error;
    }

    const data = await groqRes.json();
    res.json({
      text: data.text || "",
      duration: data.duration || null,
      language: data.language || null
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/suggestions", async (req, res, next) => {
  try {
    const apiKey = req.header("x-groq-api-key") || process.env.GROQ_API_KEY;
    required(apiKey, "Missing Groq API key.");

    const {
      transcriptEntries = [],
      settings = {}
    } = req.body || {};

    const contextLimit = Number(settings.suggestionContextWindow) || 30;
    const prompt = settings.liveSuggestionPrompt || "";
    const model = settings.chatModel || "openai/gpt-oss-120b";
    const transcriptContext = buildTranscriptContext(transcriptEntries, contextLimit);

    required(transcriptContext.trim(), "Transcript is empty. Speak first to generate suggestions.");

    const basePrompt = `
You are an AI meeting copilot producing live suggestions in real-time.

${prompt}

Return strict JSON only in this exact shape:
{
  "suggestions": [
    { "title": "short title", "preview": "useful preview text under 240 chars", "type": "question|talking_point|answer|fact_check|clarify", "reason": "brief reason tied to transcript context" },
    { "title": "...", "preview": "...", "type": "...", "reason": "..." },
    { "title": "...", "preview": "...", "type": "...", "reason": "..." }
  ]
}

Rules:
- Always return exactly 3 suggestions.
- Prioritize immediacy and usefulness in a live meeting.
- Mix types when appropriate.
- Avoid generic filler.
- Previews must be directly actionable.
`.trim();

    const completion = await groqChatCompletions({
      apiKey,
      model,
      temperature: Number(settings.suggestionTemperature ?? 0.4),
      maxTokens: Number(settings.suggestionMaxTokens ?? 700),
      messages: [
        {
          role: "system",
          content: basePrompt
        },
        {
          role: "user",
          content: `Recent transcript context:\n${transcriptContext}`
        }
      ]
    });

    const text = completion.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const cleaned = text
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    }

    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [];
    if (suggestions.length !== 3) {
      throw new Error("Model did not return exactly 3 suggestions.");
    }

    res.json({
      suggestions: suggestions.map((item, index) => ({
        id: `sg-${Date.now()}-${index}`,
        title: String(item.title || "Suggestion"),
        preview: String(item.preview || ""),
        type: String(item.type || "clarify"),
        reason: String(item.reason || "")
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat", async (req, res, next) => {
  try {
    const apiKey = req.header("x-groq-api-key") || process.env.GROQ_API_KEY;
    required(apiKey, "Missing Groq API key.");

    const {
      question = "",
      transcriptEntries = [],
      chatHistory = [],
      settings = {},
      mode = "typed_question"
    } = req.body || {};

    required(String(question).trim(), "Question is empty.");

    const contextLimit = Number(
      mode === "suggestion_click" ? settings.answerContextWindow : settings.chatContextWindow
    ) || 60;
    const prompt =
      mode === "suggestion_click"
        ? (settings.detailedAnswerPrompt || "")
        : (settings.chatPrompt || "");
    const model = settings.chatModel || "openai/gpt-oss-120b";
    const transcriptContext = buildTranscriptContext(transcriptEntries, contextLimit);
    const recentChat = Array.isArray(chatHistory) ? chatHistory.slice(-8) : [];
    const chatContext = recentChat
      .map((item) => `${item.role.toUpperCase()}: ${item.content}`)
      .join("\n");

    const completion = await groqChatCompletions({
      apiKey,
      model,
      temperature: Number(settings.chatTemperature ?? 0.3),
      maxTokens: Number(settings.chatMaxTokens ?? 900),
      messages: [
        {
          role: "system",
          content: `
You are a high-agency meeting copilot.
${prompt}
Keep answers useful, concrete, and concise.
If uncertain, say what you are inferring.
          `.trim()
        },
        {
          role: "user",
          content: `
Transcript context:
${transcriptContext || "(no transcript yet)"}

Recent chat:
${chatContext || "(no prior chat yet)"}

User question:
${question}
          `.trim()
        }
      ]
    });

    const answer = completion.choices?.[0]?.message?.content || "";
    res.json({ answer });
  } catch (error) {
    next(error);
  }
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || "Unexpected server error"
  });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
