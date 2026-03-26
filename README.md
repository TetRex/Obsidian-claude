# VaultPensieve

An Obsidian plugin that integrates AI directly into your vault. Chat with Claude or a local Ollama model in a sidebar, run writing commands on your notes, and let the AI read and modify your vault through tool calling.

![Chat sidebar](.github/assets/chat.png)

![Settings panel](.github/assets/settings.png)

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

Two models are available:

| Model | Speed | Cost |
|---|---|---|
| Claude Sonnet 4.6 | Fast | $3 / $15 per 1M tokens |
| Claude Haiku 4.5 | Fastest | $1 / $5 per 1M tokens |

You can switch models directly from the chat sidebar at any time.

---

#### Option B — Ollama (local, free)

Ollama runs AI models on your own machine. No API key or internet connection required.

1. Click **Download Ollama** in settings — this opens the installer for your OS.
2. Install and launch Ollama.
3. In the **Recommended models** list, click **Pull** next to a model to download it.
4. Click **Test** to confirm Ollama is reachable.

Recommended models:

| Model | Size | Notes |
|---|---|---|
| `qwen2.5:7b` | ~4.7 GB | Best tool calling at 7B |
| `qwen2.5:3b` | ~2 GB | Smallest with reliable tool calling |
| `llama3.2:3b` | ~2 GB | Meta's small model, good instructions |
| `llama3.1:8b` | ~4.7 GB | Well-tested, reliable tool use |
| `gemma3:4b` | ~3.3 GB | Google's latest, good quality for the size |
| `phi4-mini` | ~2.5 GB | Microsoft's small model, strong reasoning |

Tool calling (reading/writing notes) requires a model that supports function calling. The models above are tested to work well.

---

### 3. Create your instructions file (optional but recommended)

Go to **Settings → VaultPensieve** and click **Create .instructions.md**.
This creates an `.instructions.md` file at your vault root with a starter template.

Fill in the template to describe your vault — its purpose, writing style, formatting rules, and any behaviours you want to enforce. The AI reads this file automatically on every request.

You can also place an `.instructions.md` inside any subfolder. Instructions are merged from the vault root through every parent folder of the active note, with more specific (local) instructions taking priority.

A `.structure.md` file is also created at vault root. It maps every folder and note in your vault and is kept up to date automatically as files change.

### 4. Set a spending limit (optional, Anthropic only)

In **Settings → VaultPensieve**, set a **Monthly spending limit** in dollars. Requests will be blocked once the limit is reached. The counter resets automatically on the first of each month.

---

## Features

### Chat sidebar

Open the chat panel from the ribbon icon or via **Command Palette → Open VaultPensieve**.

- **Model switcher** — change models without leaving the chat. When using Ollama, all installed models are available in the dropdown
- **Attach note** — click the paperclip to attach the currently open note as context. The note name appears as a chip; click × to detach before sending
- **Chat history** — clock icon shows all saved conversations. Click any entry to resume it; × to delete
- **New chat** — plus icon starts a fresh conversation (current chat is saved automatically)
- **Prompt history** — press ↑/↓ in the input box to navigate previously sent messages
- **Usage bar** — shows current monthly spend vs your limit (Anthropic only). Turns red when the limit is reached
- **Token count** — each response shows the output token count at the bottom of the bubble
- **Settings shortcut** — gear icon opens the settings page directly

Messages support full Markdown rendering — headings, bold, code blocks, lists, and links all display correctly.

The AI uses vault tools silently in the background. A notice appears whenever a file is created or modified.

### Writing commands

Three commands are available via the Command Palette (`Cmd/Ctrl+P`):

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

### .instructions.md system

The AI loads instructions from `.instructions.md` files on every request:

1. `.instructions.md` at vault root (global instructions)
2. `.instructions.md` in each parent folder of the currently active note (local overrides)

Files are merged from global → local. Changes take effect immediately — no restart needed.

---

## How it works

```
User message
    │
    ▼
Build system prompt
  ├─ Base instructions
  ├─ .instructions.md hierarchy (vault root → active note's parent folders)
  └─ Custom system prompt (from settings)
    │
    ▼
AI provider (streaming)
  ├─ Anthropic API  ──or──  Ollama (/v1/chat/completions)
    │
    ├─ Text chunks → displayed incrementally in the chat bubble
    │
    └─ Tool calls (if any)
         ├─ Execute against app.vault
         ├─ Show Obsidian Notice
         └─ Feed result back → loop until no more tool calls
    │
    ▼
Usage recorded (Anthropic only: tokens → dollars, persisted monthly)
```

---

## Settings reference

| Setting | Description |
|---|---|
| AI provider | Anthropic (Claude) or Ollama (local) |
| API key | Your Anthropic API key. Stored in plugin data, never logged |
| Model | Claude Sonnet 4.6 or Haiku 4.5 (Anthropic) |
| Get Ollama | Opens the Ollama installer download for your OS |
| Ollama model | Select from models installed in Ollama, or enter a name manually |
| Recommended models | Pull supported models directly from the settings page |
| Custom system prompt | Extra instructions appended to every request |
| Monthly spending limit | Block requests above this dollar amount — 0 = no limit (Anthropic only) |
| Current usage | Dollars spent this calendar month (Anthropic only) |
| .instructions.md | Create or delete the vault instruction file |
| Test connection | Verify your API key or Ollama connection |

---

## Privacy & security

- The API key is stored via Obsidian's plugin data (`data.json`) and is never logged or exposed
- Note content is only sent to the AI when you explicitly attach a note or the AI calls a vault tool
- When using Ollama, all data stays on your machine — nothing is sent to external servers
