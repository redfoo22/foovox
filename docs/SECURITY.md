# Security

Foovox lets a phone talk to Claude Code on your machine. Be clear about what
that means before you expose it.

## What an attacker gets

A pairing code is the credential. Whoever redeems one gets a device session,
and that session can do whatever the **permission tier** allows:

| Tier | If a code leaks |
|---|---|
| Chat | A stranger has a conversation. Annoying, not dangerous. |
| Read | A stranger can read any file your user account can read. |
| Build | A stranger can write files in the working directory. |
| Full | A stranger has a shell on your machine. |

The default is Chat, and every session starts there. Tiers are per session and
never persist across a restart.

### Tiers are allow-lists, and that matters

The first version was a deny-list of ten tool names. It was dangerously wrong.
This installation exposes **32 tools**, including `PowerShell` — a shell that
is not called `Bash`. Denying `Bash,Task` left PowerShell untouched, so the
`chat` tier, documented as unable to read, write or run anything, had a working
shell. In testing it read a file and ran a command.

A deny-list has the wrong default: anything it has not heard of is permitted,
so every tool added to Claude Code silently widens every tier. Tiers are now
allow-lists, and the deny list handed to the CLI is computed as *everything the
runtime reports minus what the tier allows*. The tool list is read from the
CLI's own init message, so a tool added by a future release is denied by the
lower tiers automatically.

`npm run verify:tiers` proves it against the real CLI — it runs each tier
against each capability and checks which tools were actually invoked, rather
than what the answer sounded like. That distinction matters: asked to search
the web, the model will happily answer from memory, and an earlier version of
that check scored it as a successful search.

## The layers

1. **Nothing binds a public interface.** Both services bind `127.0.0.1` only.
   Whatever you use to reach them — Tailscale or a tunnel — is the only path.
2. **Pairing codes are one-use.** Burned before the token is issued, so a race
   cannot mint two devices from one code.
3. **Device tokens are httpOnly cookies.** The page can never read them, so an
   XSS on this origin cannot exfiltrate the credential.
4. **Per-device revocation** destroys the credential rather than flagging it.
5. **Rate limiting** on redemption: 10 failures per 15 minutes per source IP.
6. **The WebSocket authenticates at the upgrade** — an unauthenticated socket
   never opens.
7. **Static files cannot escape `public/`** — checked with `path.resolve`,
   tested against `..`, `%2e%2e`, `..%2f`, `public/..` and `....//`.

## Tailscale versus a tunnel

**Tailscale has no public surface at all.** The machine is reachable only from
devices signed into your tailnet. There is no URL to find, scan or brute
force, and the pairing code becomes a second lock rather than the only one.

A **Cloudflare quick tunnel** gives a public HTTPS URL. Anyone who has it
reaches your sign-in page. The pairing code is a real lock, but it is the only
one. Access policies cannot be applied to `trycloudflare.com`, because they
attach to hostnames in your own zone — for a permanent setup, use a named
tunnel on a domain you own and put Cloudflare Access in front of it.

If you can use Tailscale, use Tailscale.

## Where jobs run

Dispatched jobs run in their own working directory with the **Build** tier.
File edits are auto-approved, because nobody is at a keyboard to approve them —
so the working directory is the boundary that matters.

Point it at a project, not your home folder:

```bash
FOOVOX_WORK_DIR=/path/to/a/project foovox start
```

## Secrets on disk

`data/` holds `admin-token.txt` (the right to mint pairing codes) and
`devices.json` (hashed device tokens). Both are written with mode `600`.

**On Windows that mode is a no-op** — protection comes from the profile ACL
instead. It is adequate on a single-user machine and it is not the same thing.

`data/` is gitignored from the first commit.

## Reporting

Open an issue. If it is sensitive, say so and leave out the details.
