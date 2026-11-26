# Antigravity Telegram Bot (`agy-telegram-bot`)

A fast, zero-native-dependency TypeScript bridge between **Telegram** ([grammY](https://grammy.dev/)) and the **Antigravity CLI (`agy`)**, built for Node.js >= 22 (`node:sqlite`, ESM, strict TypeScript).

Control your local `agy` projects, resume conversations, stream live responses, manage MCP servers and skills, inspect generated artifacts, and bind Telegram Forum Topics to dedicated workspaces — all from Telegram.

---

## Feature Matrix

| Feature | Description |
| :--- | :--- |
| **Categories** | Organize projects & chats with default (`💼 Work`, `🏠 Personal`, `🛠️ DevOps`, `🔬 Research`) and custom emoji categories. |
| **Projects** | Browse, pin, categorize, create new projects (`Name \| /path`), and add workspace directories (`--add-dir`) backed by `~/.gemini/config/projects/`. |
| **Chats** | Browse by **Project**, **All**, or **Pinned**; resume, pin, rename, archive, export `.md` transcripts, and view step counts. |
| **Live Streaming + Stop** | Real-time throttled message edits (`STREAM_EDIT_INTERVAL_MS`) showing thinking/streaming status, active tool calls, usage footer, and an inline **🛑 Stop** button (`SIGTERM` -> `SIGKILL`). |
| **Forum Topics** | Bind supergroup Forum Topics to specific projects & isolated conversation threads via `/topic bind <project>` or inline menus. |
| **Model / Effort / Mode** | Switch AI models grouped by family (`/models`), reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`), permission modes (`auto`, `accept-edits`, `plan`), custom agents, sandbox, and `--dangerously-skip-permissions`. |
| **MCP / Plugins / Skills** | List, add, enable/disable, and remove MCP servers (`/mcp`); inspect plugins (`/plugins`); search and browse installed skills (`/skills`). |
| **Artifacts & File Uploads** | Auto-sends newly generated photos/documents from `~/.gemini/antigravity-cli/brain/<id>/`; accepts Telegram photos, documents, voice notes, and audio files as prompt attachments. |
| **FTS5 Search** | Full-text search across `conversation_summaries.db` (`conversations_fts` with automatic `LIKE` fallback). |
| **Security Allowlist** | Restricts access via `ALLOWED_USER_IDS` (private chats show the user's Telegram ID on denial; group chats silently ignore unauthorized users). |

---

## Quick Start

### Prerequisites

- **Linux** (or macOS for manual run)
- **Node.js >= 22** (uses built-in `node:sqlite`)
- **Antigravity CLI (`agy`)** installed and authenticated on the host

### 1. One-Command Installer (`install.sh`)

```bash
git clone <your-repo-url> agy-telegram-bot
cd agy-telegram-bot
bash scripts/install.sh
```

`scripts/install.sh` automatically:
1. Verifies Node.js >= 22 and `agy` CLI availability.
2. Runs `npm ci` and `npm run build`.
3. Launches the interactive `scripts/setup.mjs` wizard if `.env` does not exist (on interactive TTYs).
4. Offers to install, enable, and start `/etc/systemd/system/agy-telegram-bot.service`.

### 2. Manual Setup

```bash
npm ci
npm run build
npm run setup   # Interactive wizard -> creates .env with 0600 permissions
npm start
```

For development with watch mode:

```bash
npm run dev
```

### 3. Docker Compose

1. Create `.env` (via `npm run setup` or by copying `.env.example` to `.env`).
2. Ensure the `agy` binary path on the host matches `AGY_HOST_BIN` (defaults to `/root/.local/bin/agy`) and `${HOME}/.gemini` exists.
3. Build and start:

```bash
docker compose up -d --build
docker compose logs -f
```

`docker-compose.yml` mounts:
- `./data:/app/data` (bot SQLite DB & uploaded attachments)
- `${HOME}/.gemini:/root/.gemini` (`agy` projects, skills, conversation summaries, and brain artifacts)
- `${AGY_HOST_BIN:-/root/.local/bin/agy}:/usr/local/bin/agy:ro` (host `agy` binary)

### 4. systemd Service

`bash scripts/install.sh` can configure systemd for you, or you can customize [`deploy/agy-telegram-bot.service`](deploy/agy-telegram-bot.service) manually:

```bash
sudo cp deploy/agy-telegram-bot.service /etc/systemd/system/agy-telegram-bot.service
# Edit __USER__, __HOME__, __WORKDIR__, and __PATH__ in /etc/systemd/system/agy-telegram-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now agy-telegram-bot.service
sudo journalctl -u agy-telegram-bot -f
```

---

## راهنمای سریع فارسی (Persian Quick Start)

برای راه‌اندازی سریع ربات تلگرام Antigravity روی سرور لینوکس:

1. **پیش‌نیازها:** مطمئن شوید `Node.js >= 22` و ابزار `agy` روی سیستم نصب و لاگین شده باشند.
2. **نصب با یک دستور:**
   ```bash
   cd agy-telegram-bot
   bash scripts/install.sh
   ```
3. **پیکربندی تعاملی:** اسکریپت `setup.mjs` از شما موارد زیر را می‌پرسد و فایل `.env` را با دسترسی امن `0600` ذخیره می‌کند:
   - `BOT_TOKEN` (توکن دریافتی از `@BotFather`)
   - `ALLOWED_USER_IDS` (آیدی عددی اکانت تلگرام شما، با کاما جدا شده)
   - `DEFAULT_MODEL`، `DEFAULT_EFFORT`، `DEFAULT_MODE` و زبان ربات (`BOT_LANG=fa` یا `en`)
4. **اجرا با Docker Compose (اختیاری):**
   ```bash
   docker compose up -d --build
   ```
5. پس از اجرا، در تلگرام دستور `/start` یا `/menu` را بفرستید تا داشبورد کنترل نمایش داده شود. همچنین می‌توانید زبان رابط را از بخش **Settings** به `FA` تغییر دهید.

---

## Telegram Forum Topics Guide

You can turn a Telegram Supergroup with **Topics** enabled into a multi-project workspace where each topic has its own bound project and independent conversation thread:

1. Create a Telegram Supergroup and enable **Topics** in Group Settings.
2. Add your bot to the group as an administrator (so it can read messages and reply in threads).
3. Inside any Forum Topic, bind it using either:
   - **Slash command:** `/topic bind <projectIdOrName>` (e.g. `/topic bind my-api`)
   - **Inline menu:** Open `/projects` inside the topic -> select a project -> tap **📌 Bind Forum Topic**.
4. Send prompts directly inside that topic:
   - `agy` runs with the bound project's workspace directory as `cwd`.
   - The topic tracks its own `conversationId` independently from your DM or other topics.
5. Manage bindings anytime:
   - `/topic` — Show the current topic's binding
   - `/topic list` — List all topic bindings in the group
   - `/topic unbind` — Unbind the current topic
   - `/new` — Start a fresh conversation inside the current topic while keeping its project binding

---

## Slash Commands Reference

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/start` | — | Show the welcome control dashboard |
| `/menu` | — | Open the main control center menu |
| `/projects` | — | Browse, filter, pin, create, and switch projects |
| `/categories` | — | Manage project and chat categories |
| `/chats` | — | Browse, filter (`Project`/`All`/`Pinned`), and resume conversations |
| `/new` | `[prompt]` | Start a new chat (and optionally execute `[prompt]` immediately) |
| `/search` | `[query]` | Full-text search across conversation titles and transcripts |
| `/models` | — | Select AI model grouped by family (with live CLI refresh) |
| `/mode` | `[auto\|accept-edits\|plan]` | Set permission mode (or open Settings if omitted) |
| `/effort` | `[low\|medium\|high\|xhigh\|max]` | Set reasoning effort (or open Settings if omitted) |
| `/settings` | — | Configure model, effort, mode, agent, sandbox, skip-perms, tools, usage, artifacts, and language |
| `/mcp` | — | List, enable/disable, add, and remove MCP servers |
| `/skills` | `[query]` | Browse and search installed Antigravity skills |
| `/plugins` | — | List installed Antigravity plugins |
| `/artifacts` | — | List and download files in the active conversation's `brain/` folder |
| `/transcript` | — | Preview recent turns and export full Markdown transcript (`.md`) |
| `/topic` | `[bind <project>\|unbind\|list]` | Bind, inspect, or unbind Telegram Forum Topics |
| `/plan` | `<prompt>` | Execute a single prompt in `plan` permission mode |
| `/status` | — | Display `agy` CLI version, Node.js version, OS uptime/RAM, active runs, and DB stats |
| `/stop` | — | Abort all currently active `agy` runs |
| `/help` | — | Display the in-bot command guide |

> **Pass-through:** Any plain text message, photo, document, voice note, audio file, or unrecognized `/command` (e.g. `/compact`, `/karpathy-check`) is forwarded directly to `agy`.

---

## Environment Variables Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `BOT_TOKEN` | *(required)* | Telegram Bot API token from `@BotFather`. |
| `ALLOWED_USER_IDS` | *(empty = unrestricted)* | Comma-separated numeric Telegram user IDs allowed to use the bot. Recommended in production. |
| `AGY_BIN` | `agy` | Path or executable name for the Antigravity CLI. |
| `GEMINI_DIR` | `~/.gemini` | Base Gemini configuration directory containing `config/projects` and `config/skills`. |
| `APP_DATA_DIR` | `~/.gemini/antigravity-cli` | Antigravity CLI app data directory containing `conversation_summaries.db` and `brain/`. |
| `DATA_DIR` | `./data` | Directory for the bot's SQLite database (`bot.db`) and uploaded media attachments. |
| `DEFAULT_MODEL` | *(empty — CLI default)* | Default model ID for new user sessions (e.g. `gemini-4-neon-medium`). |
| `DEFAULT_EFFORT` | `medium` | Default reasoning effort: `low`, `medium`, `high`, `xhigh`, or `max`. |
| `DEFAULT_MODE` | `auto` | Default permission mode: `auto`, `accept-edits`, or `plan`. |
| `STREAM_EDIT_INTERVAL_MS` | `1200` | Minimum interval (ms) between live Telegram message edits during streaming (floored at `800` ms). |
| `MAX_TURN_TIMEOUT_MS` | `600000` | Maximum duration (ms) for a single `agy` turn before automatic abort (10 minutes). |
| `BOT_LANG` | `en` | Default interface language (`en` or `fa`). |

---

## Architecture & Testing

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module details.

```bash
npm run typecheck   # TypeScript strict check
npm run build       # Compile src/ -> dist/
npm test            # Run Vitest unit & handler test suite
```
