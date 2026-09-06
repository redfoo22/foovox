import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Device pairing and sessions — how a human logs in.
 *
 * Principals already are user accounts: identity, credential, roles, grants,
 * revocation. What was missing is the *ceremony* — nobody types a 64-character
 * hex token into a phone, and a bearer token pasted into localStorage never
 * expires and cannot be scoped to one device.
 *
 * Deliberately **no passwords.** Two reasons. First, the existing credential
 * hashing is SHA-256, which is correct for random 32-byte tokens (nothing to
 * brute-force) and dangerously wrong for human-chosen passwords, which need a
 * slow KDF. Second, a password is a thing that can be phished, reused, and
 * leaked. Pairing reuses the one-use invite pattern already proven for
 * planets, aimed at humans instead.
 *
 * The flow:
 *   1. Someone with `administer` (or the principal themselves) mints a pairing
 *      code — one-use, short-lived.
 *   2. The phone redeems it and receives a **device token**: long-lived,
 *      per-device, individually revocable.
 *   3. That token authenticates, and can be carried as a cookie or a bearer.
 *
 * Per-device revocation is the thing a single principal token cannot give you:
 * "revoke my old phone" without also locking out my laptop.
 */

const HOUR = 60 * 60 * 1000;

function hash(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export class DeviceStore {
  constructor({
    path: filePath = null,
    log = null,
    pairingTtlMs = 10 * 60 * 1000,
    deviceTtlMs = 90 * 24 * HOUR,
    maxRedeemFailures = 10,
    failureWindowMs = 15 * 60 * 1000,
  } = {}) {
    this.path = filePath;
    this.log = log;
    this.pairingTtlMs = pairingTtlMs;
    this.deviceTtlMs = deviceTtlMs;
    this.maxRedeemFailures = maxRedeemFailures;
    this.failureWindowMs = failureWindowMs;
    this.pairings = new Map(); // codeHash -> { principalId, label, expiresAt }
    this.devices = new Map(); // deviceId -> device
    /*
     * Codes that really were redeemed, so "already used" can be said honestly.
     *
     * Without this, a code that is merely *unknown* and one that was genuinely
     * spent are indistinguishable, and both reported themselves as "already
     * used". That is the worst possible wording for the common case, because it
     * tells someone their code was taken by somebody else when in fact the
     * server had simply forgotten it. Pruned by `sweep`.
     */
    this.redeemed = new Map(); // codeHash -> when (ms)
    // Redemption is the one endpoint an attacker can hammer, so it is the one
    // that needs a limiter. Keyed by source so one bad actor cannot lock out
    // everyone else.
    this.failures = new Map(); // key -> { count, first }
    this.load();
  }

  load() {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      /*
       * Outstanding pairing codes have to survive a restart.
       *
       * They used to live only in memory while devices were written to disk, so
       * every restart silently discarded every unclaimed code — and since an
       * unknown code reported itself as "already used", the codes looked stolen
       * rather than lost. Handing someone ten codes to keep is meaningless if
       * the next deploy voids them.
       *
       * Only the SHA-256 of each code is stored, exactly as for device tokens.
       * The file cannot be read back into working codes.
       */
      const now = Date.now();
      for (const record of parsed?.pairings ?? []) {
        if (!record?.codeHash || Number(record.expiresAt) <= now) continue;
        this.pairings.set(String(record.codeHash), {
          principalId: String(record.principalId),
          label: String(record.label ?? 'device'),
          expiresAt: Number(record.expiresAt),
        });
      }
      for (const record of parsed?.redeemed ?? []) {
        if (record?.codeHash) this.redeemed.set(String(record.codeHash), Number(record.at ?? 0));
      }
      for (const record of parsed?.devices ?? []) {
        if (!record?.deviceId) continue;
        this.devices.set(String(record.deviceId), {
          deviceId: String(record.deviceId),
          principalId: String(record.principalId),
          label: String(record.label ?? 'device'),
          tokenHash: record.tokenHash ? String(record.tokenHash) : null,
          created: String(record.created ?? new Date().toISOString()),
          lastSeen: String(record.lastSeen ?? record.created ?? new Date().toISOString()),
          expiresAt: Number(record.expiresAt ?? 0),
          revoked: Boolean(record.revoked),
          userAgent: record.userAgent ? String(record.userAgent).slice(0, 200) : null,
        });
      }
    } catch {
      // Fail closed: no devices load, so nobody is authenticated by a corrupt
      // file. Pairing again is cheap; silently trusting garbage is not.
    }
  }

  save() {
    if (!this.path) return;
    const devices = [...this.devices.values()];
    const pairings = [...this.pairings.entries()].map(([codeHash, p]) => ({ codeHash, ...p }));
    const redeemed = [...this.redeemed.entries()].map(([codeHash, at]) => ({ codeHash, at }));
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ devices, pairings, redeemed }, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, this.path);
  }

  /** Mint a one-use pairing code for a principal. Raw code returned once. */
  /**
   * `ttlMs` overrides the default life of this one code.
   *
   * Ten minutes is right for adding a device to your own account: you are
   * holding both screens. It is wrong for inviting a person — you text them a
   * link and they read it when they next look at their phone, which is not
   * within ten minutes. Single use is what makes a longer window acceptable;
   * the code stops working the instant it is claimed, and an unclaimed one is
   * visible as pending so it can be revoked.
   */
  createPairing({ principalId, label = 'device', ttlMs = null }) {
    const id = String(principalId ?? '').trim();
    if (!id) throw new Error('principalId is required');
    const life = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
      ? Number(ttlMs)
      : this.pairingTtlMs;
    // Short and typeable: this gets read off a screen or tapped from a link,
    // and it is one-use, so length is not what is defending it.
    const code = randomBytes(9).toString('base64url');
    this.pairings.set(hash(code), {
      principalId: id,
      label: String(label).slice(0, 60),
      expiresAt: Date.now() + life,
    });
    // Written out immediately: a code that exists only in memory is void the
    // moment the process restarts, which is what happened to a whole batch.
    this.save();
    this.log?.append('device:pairing_created', { principalId: id, label, ttlMs: life });
    return { code, expiresAt: new Date(Date.now() + life).toISOString() };
  }

  noteFailure(key) {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || now - entry.first > this.failureWindowMs) {
      this.failures.set(key, { count: 1, first: now });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  isRateLimited(key) {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.first > this.failureWindowMs) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.maxRedeemFailures;
  }

  /**
   * Exchange a pairing code for a device token.
   * `source` is whatever identifies the caller for rate limiting (an IP).
   */
  redeemPairing(code, { userAgent = null, source = 'unknown' } = {}) {
    if (this.isRateLimited(source)) {
      throw new Error('too many failed attempts, try again later');
    }
    const codeHash = hash(code);
    const pairing = this.pairings.get(codeHash);
    if (!pairing) {
      this.noteFailure(source);
      const spent = this.redeemed.get(codeHash);
      this.log?.append('device:pairing_failed', {
        source, reason: spent ? 'already redeemed' : 'unknown code',
      });
      /*
       * Say which, accurately. These are different problems with different
       * fixes, and reporting both as "already used" sent someone looking for a
       * stranger on their account when the code had simply never been seen —
       * every unclaimed code was being dropped on restart.
       */
      throw new Error(spent
        ? `pairing code was already used on ${new Date(spent).toISOString()}`
        : 'pairing code is not valid — ask for a new one');
    }
    if (Date.now() > pairing.expiresAt) {
      this.pairings.delete(codeHash);
      this.noteFailure(source);
      throw new Error('pairing code has expired');
    }
    // One-use: burn before issuing, so a race cannot mint two devices.
    this.pairings.delete(codeHash);
    this.redeemed.set(codeHash, Date.now());

    const deviceId = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    const device = {
      deviceId,
      principalId: pairing.principalId,
      label: pairing.label,
      tokenHash: hash(token),
      created: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      expiresAt: Date.now() + this.deviceTtlMs,
      revoked: false,
      userAgent: userAgent ? String(userAgent).slice(0, 200) : null,
    };
    this.devices.set(deviceId, device);
    this.save();
    this.log?.append('device:paired', {
      deviceId, principalId: device.principalId, label: device.label,
    });
    return { deviceId, token, principalId: device.principalId, label: device.label };
  }

  /** Authenticate a device token. Returns the device, or null. */
  authenticate(token) {
    if (!token) return null;
    const supplied = hash(token);
    for (const device of this.devices.values()) {
      if (device.revoked || !device.tokenHash) continue;
      if (!safeEqualHex(supplied, device.tokenHash)) continue;
      if (device.expiresAt && Date.now() > device.expiresAt) {
        // Expired is not revoked: say so distinctly, or a stale session looks
        // like a permissions bug.
        this.log?.append('device:expired', { deviceId: device.deviceId });
        return null;
      }
      device.lastSeen = new Date().toISOString();
      return device;
    }
    return null;
  }

  revokeDevice(deviceId) {
    const device = this.devices.get(String(deviceId ?? ''));
    if (!device) throw new Error(`unknown device: ${deviceId}`);
    device.revoked = true;
    device.tokenHash = null; // destroy the credential, do not merely flag it
    this.save();
    this.log?.append('device:revoked', { deviceId: device.deviceId, principalId: device.principalId });
    return this.publicView(device);
  }

  /** Revoke every device for a principal — "I lost my phone and my laptop". */
  revokeAllFor(principalId) {
    const id = String(principalId ?? '');
    const hit = [...this.devices.values()].filter((d) => d.principalId === id && !d.revoked);
    for (const device of hit) {
      device.revoked = true;
      device.tokenHash = null;
    }
    if (hit.length) {
      this.save();
      this.log?.append('device:revoked_all', { principalId: id, count: hit.length });
    }
    return hit.length;
  }

  publicView(device) {
    if (!device) return null;
    const { tokenHash, ...rest } = device;
    return { ...rest, expiresAt: device.expiresAt ? new Date(device.expiresAt).toISOString() : null };
  }

  listFor(principalId) {
    const id = String(principalId ?? '');
    return [...this.devices.values()]
      .filter((d) => d.principalId === id)
      .map((d) => this.publicView(d));
  }

  /** Drop expired pairings so a long-running Sun does not accumulate them. */
  sweep() {
    const now = Date.now();
    let dropped = 0;
    for (const [key, pairing] of this.pairings) {
      if (now > pairing.expiresAt) {
        this.pairings.delete(key);
        dropped += 1;
      }
    }
    // Keep the record of spent codes long enough to explain a stale one, then
    // let it go. A month is far longer than anyone stares at an old code.
    for (const [key, at] of this.redeemed) {
      if (now - at > 30 * 24 * HOUR) this.redeemed.delete(key);
    }
    if (dropped) this.save();
    return dropped;
  }

  /** Outstanding codes for a principal — how many are left, revealing none. */
  pendingFor(principalId) {
    const id = String(principalId ?? '');
    return [...this.pairings.values()]
      .filter((p) => p.principalId === id && p.expiresAt > Date.now())
      .map((p) => ({ label: p.label, expiresAt: new Date(p.expiresAt).toISOString() }));
  }
}

/** Parse a cookie header into a map. Small enough not to warrant a dependency. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    if (key) out[key] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

/**
 * The session cookie.
 *
 * httpOnly so page scripts cannot read it (an XSS then cannot exfiltrate the
 * credential), SameSite=Strict so another site cannot ride it, and Secure
 * whenever we are on HTTPS.
 */
export function sessionCookie(token, { secure = true, maxAgeMs = 90 * 24 * HOUR } = {}) {
  const bits = [
    `foovox_device=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie() {
  return 'foovox_device=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}
