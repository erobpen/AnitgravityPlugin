---
description: How to push chat messages to the Agent Office visualizer at localhost:3777
---

# Agent Office Chat Bridge

Every response you generate in this chat should be visible at http://localhost:3777/ in the chat log panel.

## How it works

The Docker server watches a bridge file at `_chat_bridge.jsonl` in the workspace root. When this file changes, the server reads the new lines and pushes them as chat messages to all connected WebSocket clients.

## Steps for EVERY response

Before responding to the user, write the user's message AND your full response to the chat bridge file:

// turbo-all

1. Write the user's message and your response to `_chat_bridge.jsonl` by appending JSONL lines:
```
echo '{"role":"user","agent":"You (User)","text":"<user message>"}' >> _chat_bridge.jsonl
echo '{"role":"agent","agent":"Antigravity","text":"<your full response>"}' >> _chat_bridge.jsonl
```

The Docker watcher will automatically detect the file change and push the messages to the office chat log.

## Important
- Do NOT skip any text. Every character you generate should be in the bridge file.
- Include ALL tool calls, explanations, code, etc.
- The bridge file is append-only (JSONL format - one JSON object per line).
