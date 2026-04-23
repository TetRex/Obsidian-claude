# VaultPensieve

An Obsidian plugin that integrates AI directly into your vault. Chat with Anthropic, OpenAI, Gemini, or a local Ollama model in a sidebar, run writing commands on your notes, use inline fast answers, and let the AI read and modify your vault through tool calling.

---

## First start

### 1. Install the plugin

Copy these three files into your vault's plugin folder:

```
<your-vault>/.obsidian/plugins/vault-pensieve/
  main.js
  manifest.json
  styles.css
```

Then in Obsidian: **Settings → Community plugins → turn off Restricted mode → enable VaultPensieve**.

### 2. Choose a provider

Open **Settings → VaultPensieve** and choose your AI provider.

---

#### Option A — Anthropic (Claude)

Paste your Anthropic API key into the **API key** field.
Get a key at [console.anthropic.com](https://console.anthropic.com).

Click **Test** to verify the connection.

The plugin currently exposes these Claude models:

| Model | Speed | Cost |
|---|---|---|
| Claude Opus 4.6 | Moderate | $5 / $25 per 1M input/output tokens |
| Claude Sonnet 4.6 | Fast | $3 / $15 per 1M input/output tokens |
| Claude Haiku 4.5 | Fastest | $1 / $5 per 1M input/output tokens |

You can switch Anthropic models directly from the chat sidebar at any time.

---

#### Option B — OpenAI

Paste your OpenAI API key into the **API key** field.

Click **Test** to verify the connection.

The plugin currently exposes these OpenAI models:

| Model | Estimated cost used for tracking |
|---|---|
| GPT-5.5 | $5.00 / $30.00 per 1M input/output tokens |
| GPT-5.4 mini | $0.75 / $4.50 per 1M input/output tokens |
| GPT-5.4 nano | $0.20 / $1.25 per 1M input/output tokens |

You can switch OpenAI models directly from the chat sidebar at any time.

---

#### Option C — Gemini

Paste your Gemini API key into the **API key** field.

The plugin currently exposes these Gemini models:

| Model | Estimated cost used for tracking |
|---|---|
| Gemini 2.5 Pro | $1.25 / $10.00 per 1M input/output tokens |
| Gemini 2.5 Flash | $0.30 / $2.50 per 1M input/output tokens |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40 per 1M input/output tokens |

Click **Test** to verify the connection.

You can switch Gemini models directly from the chat sidebar at any time.

---

#### Option D — Ollama (local, free)

Ollama runs AI models on your own machine. No API key or internet connection required.

1. [Download and install Ollama](https://ollama.com/download) for your OS.
2. Launch Ollama and pull the recommended model: `ollama pull qwen3.6`
3. Click **Test** in settings to confirm Ollama is reachable and that the selected model advertises tool calling support.

The plugin expects Ollama at `http://localhost:11434`. The default model is `qwen3.6`. If the plugin can reach Ollama, installed models appear in a dropdown. If not, you can enter a model name manually. Tool calling requires a model that supports native tool or function calling.

---

### 3. Customize assistant behavior (optional)

Use **Custom system prompt** in **Settings → VaultPensieve** to add instructions that should apply to every request.

This is the primary place to define tone, formatting preferences, writing constraints, or vault-specific behavior.

### 4. Set a spending limit (optional)

In **Settings → VaultPensieve**, set a **Monthly spending limit** in dollars. Requests will be blocked once the limit is reached. The counter resets automatically on the first of each month.

Spend tracking is available for Anthropic, OpenAI, and Gemini models in the built-in lists. It is not currently tracked for Ollama.

---

## Features

### Chat sidebar

Open the chat panel from the ribbon icon or via **Command Palette → Open VaultPensieve**.

- **Model switcher** — change models without leaving the chat. Anthropic, OpenAI, and Gemini use built-in model lists. Ollama shows installed models when reachable
- **Attach note** — click the paperclip to attach the currently open note as context. The note name appears as a chip; click × to detach before sending
- **Chat history** — clock icon shows all saved conversations. Click any entry to resume it; × to delete
- **New chat** — plus icon starts a fresh conversation (current chat is saved automatically)
- **Prompt history** — press ↑/↓ in the input box to navigate previously sent messages
- **Usage bar** — shows current monthly spend vs your limit for providers/models with spend tracking. Turns red when the limit is reached
- **Token count** — each response shows the output token count at the bottom of the bubble
- **Settings shortcut** — gear icon opens the settings page directly

Messages support full Markdown rendering — headings, bold, code blocks, lists, and links all display correctly.

The AI uses vault tools silently in the background. A notice appears whenever a file is created or modified.

### Writing commands

Three writing commands are available via the Command Palette (`Cmd/Ctrl+P`):

| Command | What it does |
|---|---|
| **Continue writing** | Takes text before the cursor and streams a continuation |
| **Summarize note** | Summarizes the full content of the current note |
| **Improve / rewrite selection** | Rewrites the selected text while preserving its meaning |

All three commands open a **preview modal** before applying any changes:
- The original text is shown on top
- The suggestion streams in below in real time
- **Accept** — applies the change to the editor
- **Retry** — generates a new suggestion
- **Cancel** — discards and closes

### Fast answer

Type a line that starts with `::` inside a note, for example:

```md
:: what are the main themes of this note?
```

Press `Enter` and VaultPensieve replaces that line with a formatted inline Q/A block while the answer streams into the note.

### Vault tools (agentic loop)

When asked, the AI can interact with your vault directly:

| Tool | What it does |
|---|---|
| `list_files` | Lists files in a folder |
| `read_note` | Reads the full content of a note |
| `create_note` | Creates a new note with given content |
| `update_note` | Replaces the content of an existing note |
| `search_notes` | Full-text search across all notes |
| `get_vault_structure` | Returns the folder tree |

## How it works

```
User message
    │
    ▼
Build system prompt
  ├─ Base instructions
  └─ Custom system prompt (from settings)
    │
    ▼
AI provider (streaming)
  ├─ Anthropic API
  ├─ OpenAI API
  ├─ Gemini API
  └─ Ollama (/v1/chat/completions)
    │
    ├─ Text chunks → displayed incrementally in the chat bubble
    │
    └─ Tool calls (if any)
         ├─ Execute against app.vault
         ├─ Show Obsidian Notice
         └─ Feed result back → loop until no more tool calls
    │
    ▼
Usage recorded (supported priced models only: tokens → estimated dollars, persisted monthly)
```

---

## Settings reference

| Setting | Description |
|---|---|
| AI provider | Anthropic, OpenAI, Gemini, or Ollama |
| API key | Provider-specific API key for Anthropic, OpenAI, or Gemini. Stored in plugin data, never logged |
| Model | Claude model, OpenAI model, or Gemini model depending on the selected provider |
| Ollama model | Select from models installed in Ollama, or enter a name manually |
| Custom system prompt | Extra instructions appended to every request |
| Monthly spending limit | Block requests above this dollar amount — 0 = no limit (supported tracked models only) |
| Current usage | Estimated dollars spent this calendar month when tracking is available |
| Test connection | Verify your API key or Ollama connection |

---

## Privacy & security

- API keys are stored via Obsidian's plugin data (`data.json`) and are never logged by the plugin
- When using Ollama, note content stays on your machine unless your Ollama server is remote
- When using Anthropic, OpenAI, or Gemini, the request content needed for chat or commands is sent to the selected provider
