<p align="center">
  <img src="src/assets/logo.webp" alt="Prudii Mail" width="88" />
</p>

<h1 align="center">Prudii Mail</h1>

<p align="center">
  <strong>Email that's private, secure, fast — yours.</strong>
</p>

<p align="center">
  <a href="https://prudii.com">Website</a>
  ·
  <a href="https://prudii.com/#download">Download</a>
  ·
  <a href="https://github.com/sLuCHaa/prudii-app/releases">Releases</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555" alt="Platforms" />
  <img src="https://img.shields.io/badge/built%20with-Rust%20%2B%20Tauri%20%2B%20React-1a7fd6" alt="Built with" />
  <img src="https://img.shields.io/badge/license-source--available-orange" alt="License" />
</p>

---

> // I looked at every email client on Windows. They all sucked. So I built my own.

Prudii keeps your mail where it belongs — on your machine. No cloud, no tracking, no telemetry. Just you and your inbox.

## Heads up

This is a hobby project. I build it in my spare time, on energy drinks and good vibes — there's no big company behind it. It's free and it works today. Paid plans (Premium, Team) are on the roadmap but a long way off yet, so don't hold your breath for those. The free version isn't going anywhere either way — this isn't one of those "free until you need it" things.

## What it does

It's an email client. It does email. Here's the short version.

- **Everything local** — your emails stay on your machine. Not in the cloud. Period.
- **Full-text search** — searches all your emails instantly. Offline.
- **Encrypted passwords** — Windows DPAPI, macOS Keychain, Linux keyring. Other apps can't touch them.
- **Multiple accounts** — Gmail, Outlook, GMX, whatever. All in one inbox.
- **Tracker blocker** — detects and strips tracking pixels, hidden images, and 70+ known tracker domains. Automatically.
- **Local AI** — summaries and reply suggestions via Ollama. Runs on your machine. No cloud, no API keys.
- **Fast** — Rust + Tauri. Starts in seconds.
- **Looks good** — dark mode, light mode, resizable panes. No ugly crap.
- **Backup & restore** — ZIP in, ZIP out.
- **7 languages** — English, Deutsch, Español, Français, Português, 中文, Русский.

**Works with** Gmail · Outlook / Microsoft 365 · iCloud · Fastmail · ProtonMail (via Bridge) · GMX · any standard IMAP/SMTP server.

## I don't store your data

There's no server for your mail. Paid plans check a license — that's the only thing that ever talks to prudii.com, and even then your emails stay local. I don't want your data. That's it.

- No server. Everything local.
- No tracking. No telemetry.
- Passwords encrypted (DPAPI / Keychain / keyring).
- External images blocked, tracking pixels stripped.
- AI runs locally via Ollama. No cloud.
- Direct IMAP/SMTP. No proxy.

## Local AI, on your machine

Optional summaries and reply suggestions run through [Ollama](https://ollama.com) on `localhost` — your own computer. Instead of shipping your email to OpenAI or Google, nothing leaves your network. No API keys, no subscriptions, no cloud. Smart replies come in three tones: professional, friendly, concise. Pick one and go.

## Download it

Grab it from the [website](https://prudii.com/#download) or the [Releases](https://github.com/sLuCHaa/prudii-app/releases) page. It's free. If you like it, support me. If you don't, get something else. No hard feelings.

## Build it yourself

You'll need Node.js 20+, pnpm, Rust (stable), and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev      # run it in dev mode (Vite + Rust backend)
pnpm tauri build    # produce a production build / installer
pnpm bump 1.2.3     # sync the version across package.json, Cargo.toml, tauri.conf.json
```

### Gmail OAuth client secret

The Google OAuth client secret is **not** in this repo. It's injected at compile time from either the `PRUDII_GOOGLE_CLIENT_SECRET` environment variable or a git-ignored `src-tauri/.env.local` (`PRUDII_GOOGLE_CLIENT_SECRET=...`). Builds without it still compile — Gmail sign-in just won't work in that build.

## Under the hood

- **Frontend** — React 19, TypeScript, Vite, Tailwind CSS 4, Zustand, TanStack Query, TipTap, i18next
- **Backend** — Rust, Tauri 2, SQLite + FTS5, Tokio, Lettre (SMTP), mail-parser

```
src/                 # React frontend
  components/        # UI (accounts, ai, compose, layout, settings, ui)
  hooks/             # Custom React hooks
  stores/            # Zustand stores
  lib/               # Utilities (tauri.ts, i18n.ts, sanitize.ts, ...)
  locales/           # i18n JSON files
src-tauri/           # Rust backend
  src/commands/      # Tauri command handlers
  src/db/            # SQLite (schema.sql)
  src/imap/          # IMAP
  src/gmail/         # Gmail API
  src/outlook/       # Outlook Graph API
  src/smtp/          # SMTP
  src/ai/            # Ollama integration
scripts/             # Version sync
```

## Why "Prudii"?

*Prudii* is Mando'a for *shadow* — from the Mandalorian language. Just you and your inbox, in the shadows.

## License

The source is public so you can read it and confirm it does what I say it does. It's **not** open source, though: look and build it for yourself, but no redistribution, no commercial use, and no ripping out the license check. Full terms in [LICENSE](LICENSE).

## Related repositories

The website and license server live in a separate private repo. Changes here are synced into it via `git subtree`.

---

<p align="center"><sub>Built with Rust, Tauri, React, and too many energy drinks.</sub></p>
