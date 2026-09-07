# Foovox

Instructions for installing and operating this project are in **[AGENTS.md](AGENTS.md)**.
Read that file before running anything.

Two points from it are worth repeating here, because they are the ones where
acting autonomously does real damage:

- **Do not sign in to Claude Code on the user's behalf**, and do not use
  credentials you find on the machine. Ask them to run `claude` themselves.
- **Do not expose the server without asking.** `foovox setup` falls back to a
  **public** Cloudflare URL when Tailscale is absent, and `foovox serve
  tailscale` will take over an existing Tailscale serve on the same machine.

A pairing code grants whatever the session's permission tier allows, up to
running any command the user's account can. Treat one as a shell credential:
never commit, print, or store it.
