# TwinMind Live Suggestions Assignment (JavaScript)

This is a full JavaScript implementation of the assignment:
- Live mic transcription in ~30s chunks via `whisper-large-v3` on Groq
- 3 live suggestions per refresh via `openai/gpt-oss-120b`
- Click suggestion to get a detailed answer in chat
- User-typed chat in the same continuous session
- Export full session with timestamps
- Editable settings for API key, prompts, and context windows

## Stack

- Frontend: vanilla JS + HTML + CSS
- Backend: Node.js + Express + Multer
- AI APIs: Groq OpenAI-compatible endpoints

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## How to Use

1. Click `Settings` and paste your Groq API key.
2. Keep default model `openai/gpt-oss-120b` (as required).
3. Click `Start Mic` and speak.
4. Transcript chunks append roughly every 30 seconds.
5. Suggestions auto-refresh and can also be refreshed manually.
6. Click any suggestion to open a detailed answer in chat.
7. Ask typed follow-up questions in the chat box.
8. Click `Export Session` to download transcript + suggestions + chat.

## Prompt Strategy

- Live suggestions prompt prioritizes immediate value in the next 1-2 minutes.
- Suggestion output is strictly JSON with exactly 3 items for deterministic UI rendering.
- Detailed answer prompt emphasizes meeting-ready responses, concise bullets, and concrete examples.
- Separate chat prompt supports free-form user questions with transcript and recent chat context.
- Context windows are configurable to tune relevance vs. latency.

## Notes

- API keys are never hardcoded and are stored in browser localStorage.
- No login or server persistence is included by design.
- The exported JSON redacts the API key.

## Deploy

Any Node host works (Vercel/Render/Railway/etc.):
- Build command: `npm install`
- Start command: `npm start`
