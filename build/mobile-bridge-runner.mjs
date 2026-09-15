// src/main/mobile/lan-mobile-bridge.ts
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { join as join3 } from "node:path";
import QRCode from "qrcode";
import WebSocket from "ws";

// src/main/mobile/cloudflared-tunnel.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var CLOUDFLARED_VERSION = "2026.8.2";
var CLOUDFLARED_DOWNLOAD_ATTEMPTS = 3;
var CLOUDFLARED_DOWNLOAD_TIMEOUT_MS = 3e4;
var CLOUDFLARED_ASSETS = {
  "darwin-arm64": {
    asset: "cloudflared-darwin-arm64.tgz",
    isTarGz: true,
    sha256: "9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442"
  },
  "darwin-x64": {
    asset: "cloudflared-darwin-amd64.tgz",
    isTarGz: true,
    sha256: "f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4"
  },
  "win32-x64": {
    asset: "cloudflared-windows-amd64.exe",
    isTarGz: false,
    sha256: "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5"
  },
  "linux-x64": {
    asset: "cloudflared-linux-amd64",
    isTarGz: false,
    sha256: "fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2"
  },
  "linux-arm64": {
    asset: "cloudflared-linux-arm64",
    isTarGz: false,
    sha256: "7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790"
  }
};
function extractTryCloudflareUrl(text) {
  const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
  return match && match[0].toLowerCase() !== "https://api.trycloudflare.com" ? match[0] : null;
}
async function findCloudflaredOnPath() {
  const cmd = platform() === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(cmd, ["cloudflared"], { timeout: 3e3 });
    const resolved = stdout.trim().split(/\r?\n/)[0];
    return resolved && existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}
function resolveCurrentAssetSpec(osPlatform = platform(), osArch = arch()) {
  const normalizedArch = osArch === "x64" || osArch === "amd64" ? "x64" : osArch;
  const key = `${osPlatform}-${normalizedArch}`;
  const spec = CLOUDFLARED_ASSETS[key];
  return spec ? { key, spec } : null;
}
async function sha256OfFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}
async function ensureCloudflaredBinary(options) {
  if (options.customPath && existsSync(options.customPath)) {
    return options.customPath;
  }
  const find = options.findOnPath ?? findCloudflaredOnPath;
  const onPath = await find();
  if (onPath) return onPath;
  const target = resolveCurrentAssetSpec(options.osPlatform, options.osArch);
  if (!target) {
    throw new Error(`Unsupported platform/architecture for cloudflared: ${options.osPlatform ?? platform()}-${options.osArch ?? arch()}`);
  }
  const binaryName = (options.osPlatform ?? platform()) === "win32" ? "cloudflared.exe" : "cloudflared";
  const targetBinaryPath = join(options.cacheDir, binaryName);
  if (existsSync(targetBinaryPath)) {
    return targetBinaryPath;
  }
  await mkdir(options.cacheDir, { recursive: true });
  for (const entry of await readdir(options.cacheDir)) {
    if (entry.startsWith(".download-")) {
      await rm(join(options.cacheDir, entry), { force: true }).catch(() => void 0);
    }
  }
  const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${target.spec.asset}`;
  const tempDownloadPath = join(options.cacheDir, `.download-${Date.now()}-${target.spec.asset}`);
  try {
    const download = options.download ?? downloadCloudflaredWithRetry;
    await download(downloadUrl, tempDownloadPath);
    const actualSha256 = await sha256OfFile(tempDownloadPath);
    if (actualSha256 !== target.spec.sha256) {
      await rm(tempDownloadPath, { force: true }).catch(() => void 0);
      throw new Error(
        `cloudflared checksum mismatch: expected ${target.spec.sha256}, got ${actualSha256}`
      );
    }
    if (target.spec.isTarGz) {
      await execFileAsync("tar", ["-xzf", tempDownloadPath, "-C", options.cacheDir]);
      await rm(tempDownloadPath, { force: true }).catch(() => void 0);
    } else {
      await rm(targetBinaryPath, { force: true }).catch(() => void 0);
      const { rename } = await import("node:fs/promises");
      await rename(tempDownloadPath, targetBinaryPath);
    }
    if ((options.osPlatform ?? platform()) !== "win32") {
      await chmod(targetBinaryPath, 493);
    }
    return targetBinaryPath;
  } catch (error) {
    await rm(tempDownloadPath, { force: true }).catch(() => void 0);
    throw new Error(`Failed to obtain cloudflared binary: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function isRetryableDownloadError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code ?? "") : "";
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT/.test(message);
}
async function downloadCloudflaredWithRetry(url, destination, options) {
  const download = options?.download ?? downloadFileWithRedirects;
  const attempts = options?.attempts ?? CLOUDFLARED_DOWNLOAD_ATTEMPTS;
  const sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await download(url, destination);
      return;
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true }).catch(() => void 0);
      if (attempt === attempts || !isRetryableDownloadError(error)) throw error;
      await sleep(200 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
function downloadFileWithRedirects(url, destination, maxRedirects = 5, timeoutMs = CLOUDFLARED_DOWNLOAD_TIMEOUT_MS) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (maxRedirects <= 0) {
      return rejectPromise(new Error("Too many redirects while downloading cloudflared"));
    }
    const request = httpsGet(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolvePromise(
          downloadFileWithRedirects(res.headers.location, destination, maxRedirects - 1, timeoutMs)
        );
      }
      if (res.statusCode !== 200) {
        res.resume();
        return rejectPromise(new Error(`Download failed with status ${res.statusCode}`));
      }
      const fileStream = createWriteStream(destination);
      res.once("aborted", () => {
        fileStream.destroy(
          Object.assign(new Error("cloudflared download response was aborted"), { code: "ECONNRESET" })
        );
      });
      void pipeline(res, fileStream).then(() => resolvePromise(), rejectPromise);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        Object.assign(new Error(`cloudflared download timed out after ${timeoutMs / 1e3}s`), {
          code: "ETIMEDOUT"
        })
      );
    });
    request.once("error", rejectPromise);
  });
}
function terminateChildProcess(child, graceMs = 2e3) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, graceMs).unref?.();
}
async function startCloudflareQuickTunnel(options) {
  const { port: port2, binaryPath, timeoutMs = 3e4, log } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    let resolved = false;
    const child = spawn(binaryPath, ["tunnel", "--url", `http://127.0.0.1:${port2}`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const timeoutTimer = setTimeout(() => {
      if (!resolved) {
        cleanup();
        rejectPromise(new Error(`Cloudflare Quick Tunnel timed out after ${timeoutMs / 1e3}s`));
      }
    }, timeoutMs);
    let capturedUrl = null;
    const handleOutput = (chunk) => {
      const text = chunk.toString();
      const extracted = extractTryCloudflareUrl(text);
      if (extracted && !capturedUrl) {
        capturedUrl = extracted;
        log?.(`[cloudflared] Tunnel online: ${capturedUrl}`);
        resolved = true;
        clearTimeout(timeoutTimer);
        resolvePromise({
          provider: "cloudflare",
          url: capturedUrl,
          process: child,
          stop: async () => {
            cleanup();
          }
        });
      }
    };
    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);
    child.once("error", (err) => {
      if (!resolved) {
        clearTimeout(timeoutTimer);
        rejectPromise(err);
      }
    });
    child.once("close", (code, signal) => {
      if (!resolved) {
        clearTimeout(timeoutTimer);
        rejectPromise(new Error(`cloudflared exited unexpectedly with code ${code}, signal ${signal}`));
      }
    });
    const cleanup = () => {
      try {
        terminateChildProcess(child);
      } catch {
      }
    };
  });
}

// src/main/mobile/internet-tunnel.ts
async function startTunnelWithFallback(options) {
  try {
    if (options.forceCloudflareFailure) {
      throw new Error("Cloudflare failure forced by DSH_TUNNEL_FORCE_PINGGY");
    }
    return await options.startCloudflare();
  } catch (cloudflareError) {
    const cloudflareMessage = errorMessage(cloudflareError);
    options.log?.(`[tunnel] Cloudflare unavailable, falling back to Pinggy: ${cloudflareMessage}`);
    try {
      return await options.startPinggy();
    } catch (pinggyError) {
      throw new Error(
        `Unable to create an internet tunnel. Cloudflare: ${cloudflareMessage}; Pinggy: ${errorMessage(pinggyError)}`
      );
    }
  }
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/main/mobile/pinggy-tunnel.ts
import { execFile as execFile2, spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { mkdir as mkdir2 } from "node:fs/promises";
import { arch as arch2, platform as platform2 } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
var PINGGY_HOST = "free.pinggy.io";
var PINGGY_USER = "dsh";
function extractPinggyUrl(text) {
  const matches = text.matchAll(
    /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:pinggy(?:-free)?\.link|pinggy\.online)/gi
  );
  for (const match of matches) return match[0];
  return null;
}
async function findSshOnPath(osPlatform = platform2()) {
  const cmd = osPlatform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync2(cmd, ["ssh"], { timeout: 3e3 });
    const resolved = stdout.trim().split(/\r?\n/)[0];
    return resolved && existsSync2(resolved) ? resolved : null;
  } catch {
    return null;
  }
}
function buildPinggySshArgs(options) {
  return [
    "-p",
    "443",
    "-R",
    `0:127.0.0.1:${options.port}`,
    "-i",
    options.identityPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${options.knownHostsPath}`,
    "-o",
    `User=${PINGGY_USER}`,
    PINGGY_HOST
  ];
}
function pinggyIdentityPath(knownHostsPath) {
  return join2(dirname2(knownHostsPath), "pinggy-id");
}
async function ensurePinggyIdentity(options) {
  if (existsSync2(options.identityPath)) return options.identityPath;
  await mkdir2(dirname2(options.identityPath), { recursive: true });
  if (options.createIdentity) {
    await options.createIdentity(options.identityPath);
  } else {
    const keygenPath = resolveSshKeygen(options.sshPath);
    await execFileAsync2(keygenPath, ["-t", "ed25519", "-f", options.identityPath, "-N", "", "-q"], {
      timeout: 1e4
    });
  }
  if (!existsSync2(options.identityPath)) {
    throw new Error(`ssh-keygen did not create Pinggy identity: ${options.identityPath}`);
  }
  return options.identityPath;
}
function resolveSshKeygen(sshPath) {
  if (sshPath) {
    const sibling = join2(dirname2(sshPath), platform2() === "win32" ? "ssh-keygen.exe" : "ssh-keygen");
    if (existsSync2(sibling)) return sibling;
  }
  return "ssh-keygen";
}
async function startPinggyTunnel(options) {
  const { port: port2, knownHostsPath, timeoutMs = 3e4, log } = options;
  const sshPath = options.sshPath ?? await findSshOnPath();
  if (!sshPath) {
    throw new Error(`OpenSSH client was not found for ${platform2()}-${arch2()}`);
  }
  if (!existsSync2(sshPath)) throw new Error(`OpenSSH client does not exist: ${sshPath}`);
  await mkdir2(dirname2(knownHostsPath), { recursive: true });
  const identityPath = await ensurePinggyIdentity({
    identityPath: options.identityPath ?? pinggyIdentityPath(knownHostsPath),
    sshPath,
    createIdentity: options.createIdentity
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let output = "";
    const child = spawn2(
      sshPath,
      buildPinggySshArgs({ port: port2, knownHostsPath, identityPath }),
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    const cleanup = () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, 2e3).unref?.();
        }
      } catch {
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      cleanup();
      rejectPromise(error);
    };
    const timeoutTimer = setTimeout(() => {
      const detail = lastOutputLine(output);
      fail(
        new Error(
          `Pinggy Tunnel timed out after ${timeoutMs / 1e3}s${detail ? `: ${detail}` : ""}`
        )
      );
    }, timeoutMs);
    const handleOutput = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-16384);
      const capturedUrl = extractPinggyUrl(output);
      if (!capturedUrl || settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      log?.(`[pinggy] Tunnel online: ${capturedUrl}`);
      resolvePromise({
        provider: "pinggy",
        url: capturedUrl,
        process: child,
        stop: async () => cleanup()
      });
    };
    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);
    child.once("error", (error) => fail(error));
    child.once("close", (code, signal) => {
      const detail = lastOutputLine(output);
      fail(
        new Error(
          `Pinggy exited unexpectedly with code ${code}, signal ${signal}${detail ? `: ${detail}` : ""}`
        )
      );
    });
  });
}
function lastOutputLine(output) {
  const lines = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 300);
}

// src/main/mobile/lan-mobile-pages.ts
function renderMobilePage({ locale }) {
  const zh = locale === "zh";
  return `<!doctype html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)">
  <meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="DSH Mobile">
  <link rel="icon" href="/app-icon">
  <link rel="apple-touch-icon" href="/app-icon">
  <title>DSH Mobile</title>
  <style>
    :root{color-scheme:light;--paper:#fff;--sidebar:#f7f8fa;--ink:#18191c;--muted:#81858c;--line:#e5e7eb;--card:#fff;--hover:#f2f3f5;--surface:#f7f7f5;--brand:#4d6bfe}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#141416;--sidebar:#19191b;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--card:#1d1d20;--hover:#29292d;--surface:#202023;--brand:#6f86ff}}
    *{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    button,input,textarea,select{font:inherit}.shell{max-width:760px;height:var(--app-height,100dvh);margin:auto;padding:calc(6px + env(safe-area-inset-top)) 14px calc(8px + env(safe-area-inset-bottom));display:flex;flex-direction:column}
    header{height:48px;display:flex;flex:none;align-items:center;justify-content:space-between;padding:0 3px}.brand{font-size:15px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}.brand img{width:35px;height:20px;object-fit:contain}.brand .dark-logo{display:none}@media(prefers-color-scheme:dark){.brand .light-logo{display:none}.brand .dark-logo{display:block}}.status{width:8px;height:8px;border-radius:50%;margin-right:4px;background:#35a867;box-shadow:0 0 0 0 rgba(53,168,103,.42);animation:connectedPulse 1.8s ease-out infinite}.status.connecting{background:var(--muted);animation:none}.status.error-state{background:#e34d59;animation:none}@keyframes connectedPulse{70%{box-shadow:0 0 0 7px rgba(53,168,103,0)}100%{box-shadow:0 0 0 0 rgba(53,168,103,0)}}
    .view{display:none;min-height:0}.view.active{display:flex;flex:1;flex-direction:column}.toolbar{display:flex;flex:none;gap:8px;align-items:center;padding:12px 0}.toolbar select{flex:1;min-width:0}#sessionsView{padding-top:2px}.session-hero{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 2px 11px}.session-heading{min-width:0}.session-heading h1{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.035em;font-weight:650}.session-heading p{margin:0 0 1px;color:var(--muted);font-size:10.5px}.workspace-panel{flex:none;border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:9px}.workspace-label{display:block;margin:0 2px 4px;color:var(--muted);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}.session-actions{display:flex;gap:7px}.session-actions select{flex:1;min-width:0;height:39px;background:var(--card);font-weight:500}.icon-button{display:grid;place-items:center;width:39px;height:39px;padding:0;background:var(--card)}.icon-button.refreshing svg{animation:spin .65s linear infinite}.new-session{display:flex;align-items:center;gap:5px;height:36px;flex:none;border-color:var(--ink);border-radius:11px;padding:6px 11px;background:var(--ink);color:var(--paper);font-weight:600}.new-session:hover{background:var(--ink);opacity:.86}.new-session:disabled{cursor:default;opacity:.35}.new-session svg{display:block}.workspace-hint{color:var(--muted);font-size:12px;line-height:1.4;padding:7px 2px 1px}.workspace-hint[hidden]{display:none}.list-heading{display:flex;align-items:center;justify-content:space-between;padding:14px 2px 6px}.list-heading strong{font-size:13px;font-weight:650}.session-count{display:grid;place-items:center;min-width:24px;height:20px;border-radius:999px;background:var(--surface);color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}body.chat-open header{display:none}body.chat-open .shell{padding:env(safe-area-inset-top) 14px 0}#chatView{position:relative}.chat-toolbar{position:absolute;inset:0 0 auto;z-index:2;min-height:40px;padding:0;background:transparent;pointer-events:none}.back{display:grid;place-items:center;flex:none;width:40px;height:40px;border:1px solid var(--line)!important;border-radius:50%;padding:0!important;background:var(--card)!important;box-shadow:0 2px 8px rgba(0,0,0,.06);pointer-events:auto}.back:hover{background:var(--hover)!important}.back svg{display:block}
    select,button,textarea{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:10px 12px}button{cursor:pointer}button:hover{background:var(--hover)}button.primary{display:flex;align-items:center;justify-content:center;gap:6px;flex:none;min-width:68px;height:40px;border:1px solid var(--ink);border-radius:13px;padding:0 11px 0 13px;background:var(--ink);color:var(--paper);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 10%,transparent),0 2px 5px rgba(0,0,0,.14);transition:transform .14s ease,opacity .14s ease,box-shadow .14s ease}.primary svg{display:block;flex:none}.primary:hover:not(:disabled){background:var(--ink);opacity:.88;transform:translateY(-1px)}.primary:active:not(:disabled){transform:translateY(0);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 8%,transparent),0 1px 2px rgba(0,0,0,.12)}.primary:disabled{cursor:default;border-color:var(--line);background:var(--surface);color:var(--muted);box-shadow:none}button.quiet{background:transparent}
    .list{display:grid;grid-template-columns:minmax(0,1fr);min-width:0;align-content:start;gap:8px;overflow-y:auto;padding:0 0 12px}.row{width:100%;min-width:0;display:flex;align-items:center;gap:11px;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:15px;padding:12px;transition:background .16s ease,transform .16s ease}.row:hover,.row:active{background:var(--surface);transform:translateY(-1px)}.session-mark{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:11px;background:var(--surface);color:var(--ink)}.row-copy{min-width:0;flex:1}.row strong{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row time{display:block;margin-top:2px;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.row-chevron{flex:none;color:var(--muted);opacity:.7}.empty{display:flex;min-height:190px;align-items:center;justify-content:center;flex-direction:column;padding:42px 18px;text-align:center;color:var(--muted)}.empty-mark{display:grid;place-items:center;width:44px;height:44px;margin-bottom:12px;border-radius:14px;background:var(--surface);color:var(--ink)}.empty strong{color:var(--ink);font-size:14px}.empty span:last-child{max-width:220px;margin-top:4px;font-size:12px}.messages{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:0;padding:18px 4px}.chat-open .messages{padding-top:4px;padding-bottom:84px}.message{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink);line-height:1.65}.message.user{align-self:flex-end;max-width:82%;background:var(--hover);border-radius:22px;padding:9px 15px;margin:8px 0 14px}.message.assistant{align-self:stretch;padding:0 4px;margin:0}.message .role{display:none}
    .markdown{white-space:normal}.markdown>*:first-child{margin-top:0}.markdown>*:last-child{margin-bottom:0}.markdown p{margin:0 0 10px}.markdown h1,.markdown h2,.markdown h3{line-height:1.3;margin:18px 0 8px}.markdown h1{font-size:22px}.markdown h2{font-size:19px}.markdown h3{font-size:16px}.markdown ul{margin:8px 0;padding-left:22px}.markdown pre{overflow:auto;background:var(--hover);border:1px solid var(--line);border-radius:10px;padding:12px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.markdown code{background:var(--hover);border-radius:5px;padding:2px 5px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}.markdown pre code{padding:0;background:none}.markdown a{color:var(--brand)}.table-wrap{width:100%;overflow-x:auto;margin:10px 0;-webkit-overflow-scrolling:touch}.markdown table{width:100%;min-width:420px;border-collapse:collapse;font-size:13px;line-height:1.5}.markdown th,.markdown td{padding:9px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}.markdown th{background:var(--hover);font-weight:600}.thinking,.tool{position:relative;margin:0;white-space:normal}.thinking summary,.tool summary{position:relative;min-height:34px;cursor:pointer;list-style:none;border-radius:6px;padding:5px 2px;color:var(--ink);font-size:14px;line-height:24px;display:flex;align-items:center;gap:0;overflow:hidden}.thinking summary:hover,.tool summary:hover{background:var(--hover)}.thinking summary::-webkit-details-marker,.tool summary::-webkit-details-marker{display:none}.activity-leading{width:16px;height:16px;display:grid;place-items:center;flex:none;margin-right:6px;color:var(--muted)}.activity-leading svg{display:block}.activity-title{flex:none;font-weight:400}.activity-dot{width:2px;height:2px;margin:0 8px;border-radius:50%;background:var(--muted);opacity:.7;flex:none}.activity-summary{position:relative;min-width:0;flex:1;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.activity-chevron{width:16px;height:16px;display:grid;place-items:center;flex:none;color:var(--muted);transition:transform .14s ease}.thinking[open] .activity-chevron,.tool[open] .activity-chevron{transform:rotate(90deg)}.thinking-body{padding:3px 0 7px 22px;color:var(--muted);font-size:13px;line-height:22px}.tool-body{padding:3px 0 8px 20px;color:var(--muted);font-size:12px}.tool-body strong{display:block;margin:7px 0 3px;font-weight:500}.tool-status.error,.tool[data-state=error] .activity-leading{color:#e34d59}.tool pre{max-height:260px;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;margin:0 0 4px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px;padding:10px 12px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.thinking[data-state=running] .activity-summary:after,.tool[data-state=running] .activity-summary:after{content:'';position:absolute;inset:0 auto 0 -240px;width:240px;pointer-events:none;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--paper) 72%,transparent),transparent);animation:activitySweep 2.6s ease-out infinite}.streaming:after{content:' ';display:inline-block;width:6px;height:15px;margin-left:2px;vertical-align:-2px;background:var(--brand);animation:pulse .7s infinite alternate}.turn-status{height:26px;display:inline-flex;align-items:center;margin:0 4px 6px;pointer-events:none;color:transparent;-webkit-text-fill-color:transparent;background:linear-gradient(90deg,var(--brand) 0%,var(--brand) 40%,color-mix(in srgb,var(--brand) 35%,var(--paper)) 50%,var(--brand) 60%,var(--brand) 100%);background-position:100% 0;background-size:250% 100%;-webkit-background-clip:text;background-clip:text;font-size:14px;font-weight:600;white-space:nowrap;animation:deepDiveShimmer 1.8s linear infinite}
    [hidden]{display:none!important}.message:empty{display:none}.composer{position:absolute;z-index:2;inset:auto 0 0;padding:10px 0 5px;background:transparent;pointer-events:none}.composer-inner{min-height:58px;display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:23px;padding:8px 8px 8px 16px;background:var(--card);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 70%,transparent),0 2px 8px rgba(0,0,0,.06),0 14px 34px rgba(0,0,0,.06);pointer-events:auto;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.composer-inner:focus-within{border-color:color-mix(in srgb,var(--ink) 28%,var(--line));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 72%,transparent),0 3px 10px rgba(0,0,0,.08),0 18px 38px rgba(0,0,0,.08);transform:translateY(-1px)}.composer textarea{flex:1;height:40px;min-height:40px;max-height:150px;overflow-y:auto;resize:none;border:0;outline:0;border-radius:0;padding:9px 0;background:transparent;color:var(--ink);caret-color:var(--brand);font-size:16px;letter-spacing:-.01em}.composer textarea::placeholder{color:var(--muted);opacity:.68}.composer .primary,.primary.cancel{width:40px;min-width:40px;border-radius:50%;padding:0;background:var(--ink);border-color:var(--ink)}.settings-trigger{display:grid;place-items:center;width:40px;min-width:40px;height:40px;border-radius:50%;padding:0;background:var(--surface);color:var(--muted)}.settings-trigger[aria-expanded=true]{border-color:var(--ink);background:var(--ink);color:var(--paper)}.session-settings{position:absolute;right:8px;bottom:76px;width:min(350px,calc(100vw - 28px));max-height:min(62vh,470px);overflow-y:auto;border:1px solid var(--line);border-radius:18px;padding:15px;background:var(--card);box-shadow:0 8px 26px rgba(0,0,0,.1),0 24px 60px rgba(0,0,0,.12);pointer-events:auto}.settings-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.settings-head strong{font-size:15px;font-weight:650}.settings-close{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:50%;padding:0;background:transparent;color:var(--muted);font-size:20px;line-height:1}.setting-field{display:block;margin-top:11px}.setting-field>span{display:block;margin:0 2px 5px;color:var(--muted);font-size:11px;font-weight:600}.setting-field select{width:100%;height:42px;background:var(--surface)}.setting-field select:disabled{opacity:.55}.setting-note{margin:5px 2px 0;color:var(--muted);font-size:11px;line-height:1.4}.settings-error{min-height:17px;margin-top:7px;color:#e34d59;font-size:11px}.settings-loading{padding:14px 2px;color:var(--muted);font-size:12px}.todo-dock{margin:0 0 8px;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden;pointer-events:auto}.todo-header{width:100%;height:38px;display:flex;align-items:center;gap:8px;border:0;border-radius:0;padding:0 11px;background:transparent;text-align:left}.todo-lead,.todo-chevron{display:grid;place-items:center;flex:none;color:var(--muted)}.todo-title{flex:none;font-size:13px;font-weight:600}.todo-progress{min-width:0;flex:1;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.todo-list{display:grid;gap:7px;max-height:180px;overflow-y:auto;margin:0;padding:1px 12px 10px;list-style:none}.todo-item{min-width:0;display:flex;align-items:center;gap:9px;color:var(--muted);font-size:13px}.todo-glyph{display:grid;place-items:center;width:16px;height:16px;flex:none}.todo-item[data-status=completed] .todo-glyph{color:#35a867}.todo-item[data-status=in_progress] .todo-glyph{color:var(--brand);animation:spin 1s linear infinite}.todo-content{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.turn-running .messages{padding-bottom:116px}.todo-open .messages{padding-bottom:130px}.turn-running.todo-open .messages{padding-bottom:162px}.todo-expanded .messages{padding-bottom:min(42vh,300px)}.turn-running.todo-expanded .messages{padding-bottom:min(42vh,332px)}.turn-running .session-settings{bottom:108px}.todo-open .session-settings{bottom:122px}.turn-running.todo-open .session-settings{bottom:154px}.todo-expanded .session-settings{bottom:min(42vh,292px)}.turn-running.todo-expanded .session-settings{bottom:min(42vh,324px)}.primary[hidden]{display:none}.question-composer{position:absolute;z-index:3;inset:auto 0 0;padding:10px 0 5px;pointer-events:none}.question-shell{max-height:min(70vh,580px);display:flex;flex-direction:column;border:1px solid var(--line);border-radius:23px;background:var(--card);box-shadow:0 4px 16px rgba(0,0,0,.08),0 22px 54px rgba(0,0,0,.1);overflow:hidden;pointer-events:auto}.question-top{display:flex;align-items:center;gap:9px;flex:none;padding:13px 16px 10px;border-bottom:1px solid var(--line)}.question-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--surface);color:var(--ink)}.question-context{min-width:0;flex:1}.question-context strong{display:block;font-size:13px;font-weight:650}.question-context span{display:block;color:var(--muted);font-size:11px}.question-close{width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:50%;padding:0;background:transparent;color:var(--muted)}.question-body{min-height:0;overflow-y:auto;padding:14px 16px 4px;-webkit-overflow-scrolling:touch}.question-title{margin:0;font-size:17px;line-height:1.45;letter-spacing:-.015em;font-weight:620}.question-detail{margin-top:7px;color:var(--muted);font-size:13px}.question-options{display:grid;gap:7px;margin-top:13px}.question-option{width:100%;display:flex;align-items:flex-start;gap:10px;border:1px solid var(--line);border-radius:13px;padding:10px 11px;background:var(--card);text-align:left}.question-option.selected{border-color:var(--ink);background:var(--surface)}.option-control{display:grid;place-items:center;width:19px;height:19px;flex:none;margin-top:1px;border:1px solid var(--muted);border-radius:50%;font-size:11px}.multi .option-control{border-radius:6px}.question-option.selected .option-control{border-color:var(--ink);background:var(--ink);color:var(--paper)}.option-copy{min-width:0;flex:1}.option-label{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px}.recommendation{border-radius:999px;background:var(--surface);color:var(--muted);padding:1px 6px;font-size:10px}.option-description{display:block;margin-top:2px;color:var(--muted);font-size:12px;line-height:1.45}.custom-label{display:block;margin:13px 1px 5px;color:var(--muted);font-size:11px;font-weight:600}.question-custom{width:100%;min-height:54px;max-height:110px;resize:vertical;border:1px solid var(--line);border-radius:13px;padding:10px 11px;background:var(--surface);outline:none}.question-custom:focus{border-color:color-mix(in srgb,var(--ink) 35%,var(--line))}.question-error{min-height:18px;padding:5px 16px 0;color:#e34d59;font-size:11px}.question-actions{display:flex;align-items:center;gap:7px;flex:none;padding:8px 12px 12px}.question-actions button{height:38px;padding:0 12px;border-radius:11px}.question-actions .spacer{flex:1}.question-actions .submit-answer{border-color:var(--ink);background:var(--ink);color:var(--paper);font-weight:600}.question-actions button:disabled{opacity:.45;cursor:default}.question-open .messages{padding-bottom:min(64vh,520px)}.error{color:#e34d59;font-size:13px;margin:8px 0}.toast{position:fixed;left:50%;top:calc(64px + env(safe-area-inset-top));z-index:5;transform:translate(-50%,-8px);background:var(--ink);color:var(--paper);border-radius:999px;padding:6px 11px;font-size:12px;opacity:0;pointer-events:none;transition:.18s ease}.toast.show{opacity:1;transform:translate(-50%,0)}.loading{display:grid;gap:12px;padding:22px 4px}.skeleton{height:14px;border-radius:7px;background:var(--hover);animation:pulse 1.1s ease-in-out infinite alternate}.skeleton:nth-child(2){width:82%}.skeleton:nth-child(3){width:64%}@keyframes pulse{to{opacity:.35}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes activitySweep{0%{left:-240px}90%,to{left:100%}}@keyframes deepDiveShimmer{to{background-position:0 0}}@media(display-mode:standalone){.chat-open .messages{padding-bottom:calc(84px + env(safe-area-inset-bottom))}.chat-open.turn-running .messages{padding-bottom:calc(116px + env(safe-area-inset-bottom))}.chat-open.todo-open .messages{padding-bottom:calc(130px + env(safe-area-inset-bottom))}.chat-open.turn-running.todo-open .messages{padding-bottom:calc(162px + env(safe-area-inset-bottom))}.chat-open.todo-expanded .messages{padding-bottom:min(42vh,calc(300px + env(safe-area-inset-bottom)))}.chat-open.turn-running.todo-expanded .messages{padding-bottom:min(42vh,calc(332px + env(safe-area-inset-bottom)))}.chat-open.question-open .messages{padding-bottom:min(64vh,520px)}.composer,.question-composer{padding-bottom:calc(5px + env(safe-area-inset-bottom))}}@media(prefers-reduced-motion:reduce){.skeleton,.status,.icon-button.refreshing svg,.thinking[data-state=running] .activity-summary:after,.tool[data-state=running] .activity-summary:after,.turn-status,.todo-item[data-status=in_progress] .todo-glyph{animation:none}.composer-inner,.primary{transition:none}}
    /* Keep the popover anchored to its trigger; composer docks may grow behind it. */
    #composer .session-settings{z-index:1;bottom:76px}
    .messages .turn-status{align-self:flex-start;flex:none;margin:3px 4px}
  </style>
</head>
<body><main class="shell">
  <div id="toast" class="toast" role="status"></div>
  <header><div class="brand"><img class="light-logo" src="/brand-logo/light" alt=""><img class="dark-logo" src="/brand-logo/dark" alt=""><span>DSH Desktop</span></div><div id="status" class="status connecting" role="status" aria-label="${zh ? "\u6B63\u5728\u8FDE\u63A5" : "Connecting"}"></div></header>
  <section id="sessionsView" class="view active">
    <div class="session-hero"><div class="session-heading"><p>${zh ? "\u79FB\u52A8\u5DE5\u4F5C\u53F0" : "Mobile workspace"}</p><h1>${zh ? "\u7EE7\u7EED\u5BF9\u8BDD" : "Continue working"}</h1></div><button id="newSession" class="new-session" disabled><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>${zh ? "\u65B0\u4F1A\u8BDD" : "New session"}</button></div>
    <div class="workspace-panel"><label class="workspace-label" for="workspace">${zh ? "\u5F53\u524D\u5DE5\u4F5C\u533A" : "Current workspace"}</label><div class="session-actions"><select id="workspace" aria-label="${zh ? "\u5F53\u524D\u5DE5\u4F5C\u533A" : "Current workspace"}"></select><button id="refresh" class="icon-button" aria-label="${zh ? "\u5237\u65B0" : "Refresh"}"><svg width="17" height="17" viewBox="0 0 20 20" fill="none"><path d="M16 7.5A6.5 6.5 0 1 0 16 13M16 7.5V3.5M16 7.5H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><div id="workspaceHint" class="workspace-hint"></div></div>
    <div class="list-heading"><strong>${zh ? "\u6700\u8FD1\u4F1A\u8BDD" : "Recent sessions"}</strong><span id="sessionCount" class="session-count">0</span></div>
    <div id="sessions" class="list"></div><div id="listError" class="error"></div>
  </section>
  <section id="chatView" class="view">
    <div class="toolbar chat-toolbar"><button id="back" class="quiet back" aria-label="${zh ? "\u8FD4\u56DE\u4F1A\u8BDD\u5217\u8868" : "Back to sessions"}"><svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 3L5.5 8L10.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <div id="messages" class="messages"></div><div id="chatError" class="error"></div>
    <div id="questionComposer" class="question-composer" hidden></div>
    <div id="composer" class="composer"><div id="sessionSettings" class="session-settings" hidden></div><section id="todoDock" class="todo-dock" aria-label="${zh ? "\u4EFB\u52A1" : "To-dos"}" hidden></section><div class="composer-inner"><textarea id="prompt" rows="1" placeholder="${zh ? "\u7ED9\u667A\u80FD\u4F53\u53D1\u6D88\u606F" : "Message the agent"}"></textarea><button id="settings" class="settings-trigger" aria-label="${zh ? "\u4F1A\u8BDD\u8BBE\u7F6E" : "Session settings"}" aria-expanded="false"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 5h7M13 5h2M3 13h2M8 13h7M10 3v4M6 11v4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg></button><button id="send" class="primary" aria-label="${zh ? "\u53D1\u9001" : "Send"}" disabled><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12V4M8 4 4.75 7.25M8 4l3.25 3.25" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button id="cancel" class="primary cancel" aria-label="${zh ? "\u505C\u6B62\u751F\u6210" : "Stop generating"}" hidden><svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg></button></div></div>
  </section>
</main>
<script>
const L=${JSON.stringify({
    noSessions: zh ? "\u8FD8\u6CA1\u6709\u4F1A\u8BDD" : "No sessions yet",
    emptyHint: zh ? "\u521B\u5EFA\u4E00\u4E2A\u65B0\u4F1A\u8BDD\uFF0C\u4ECE\u8FD9\u91CC\u7EE7\u7EED\u7535\u8111\u4E0A\u7684\u5DE5\u4F5C\u3002" : "Start a session and continue your desktop work here.",
    untitled: zh ? "\u672A\u547D\u540D\u4F1A\u8BDD" : "Untitled session",
    failed: zh ? "\u8BF7\u6C42\u5931\u8D25" : "Request failed",
    chooseWorkspace: zh ? "\u8BF7\u5148\u9009\u62E9\u4E00\u4E2A\u5DE5\u4F5C\u533A\u3002" : "Choose a workspace first.",
    running: zh ? "\u8FD0\u884C\u4E2D" : "Running",
    done: zh ? "\u5B8C\u6210" : "Done",
    toolFailed: zh ? "\u5931\u8D25" : "Failed",
    input: zh ? "\u8F93\u5165" : "Input",
    output: zh ? "\u8F93\u51FA" : "Output",
    noWorkspaces: zh ? "\u6682\u65E0\u5DE5\u4F5C\u533A\uFF0C\u8BF7\u5148\u5728 DSH Desktop \u4E2D\u521B\u5EFA\u7B2C\u4E00\u4E2A\u5DE5\u4F5C\u533A\u3002" : "No workspaces yet. Create your first workspace in DSH Desktop.",
    refreshed: zh ? "\u5DF2\u5237\u65B0" : "Updated",
    justNow: zh ? "\u521A\u521A" : "Now",
    minute: zh ? " \u5206\u949F\u524D" : "m ago",
    hour: zh ? " \u5C0F\u65F6\u524D" : "h ago",
    day: zh ? " \u5929\u524D" : "d ago",
    questionNeeded: zh ? "\u9700\u8981\u4F60\u7684\u56DE\u7B54" : "Your input is needed",
    questionProgress: zh ? "\u4E2A\u95EE\u9898" : "questions",
    customAnswer: zh ? "\u6216\u8005\u8F93\u5165\u5176\u4ED6\u56DE\u7B54" : "Or enter another answer",
    customPlaceholder: zh ? "\u8F93\u5165\u4F60\u7684\u56DE\u7B54\u2026" : "Type your answer\u2026",
    skip: zh ? "\u8DF3\u8FC7" : "Skip",
    previous: zh ? "\u4E0A\u4E00\u4E2A" : "Back",
    next: zh ? "\u4E0B\u4E00\u4E2A" : "Next",
    submitAnswer: zh ? "\u63D0\u4EA4\u56DE\u7B54" : "Submit answers",
    cancelQuestions: zh ? "\u53D6\u6D88\u8FD9\u6B21\u63D0\u95EE" : "Cancel this request",
    chooseAnswer: zh ? "\u8BF7\u9009\u62E9\u4E00\u4E2A\u9009\u9879\u3001\u8F93\u5165\u56DE\u7B54\uFF0C\u6216\u8DF3\u8FC7\u3002" : "Choose an option, enter an answer, or skip.",
    recommended: zh ? "\u63A8\u8350" : "Recommended",
    answering: zh ? "\u6B63\u5728\u63D0\u4EA4\u2026" : "Submitting\u2026",
    presetStandard: zh ? "\u6807\u51C6\u6A21\u5F0F" : "Standard mode",
    presetCode: zh ? "PTC \u6A21\u5F0F" : "PTC mode",
    presetMinimal: zh ? "\u6781\u7B80\u6A21\u5F0F" : "Minimal mode",
    presetCordis: zh ? "\u521B\u9020\u6A21\u5F0F" : "Creator mode",
    customPreset: zh ? "\u81EA\u5B9A\u4E49" : "Custom",
    sessionSettings: zh ? "\u4F1A\u8BDD\u8BBE\u7F6E" : "Session settings",
    preset: zh ? "Preset" : "Preset",
    model: zh ? "\u6A21\u578B" : "Model",
    reasoningEffort: zh ? "\u601D\u8003\u5F3A\u5EA6" : "Reasoning effort",
    presetLocked: zh ? "\u53D1\u9001\u9996\u6761\u6D88\u606F\u540E\uFF0CPreset \u5DF2\u9501\u5B9A\u3002" : "Preset is locked after the first message.",
    presetEditable: zh ? "\u4EC5\u53EF\u5728\u53D1\u9001\u7B2C\u4E00\u6761\u6D88\u606F\u524D\u66F4\u6539\u3002" : "Can be changed before the first message only.",
    settingsLoading: zh ? "\u6B63\u5728\u8BFB\u53D6\u6A21\u578B\u4E0E Preset\u2026" : "Loading models and presets\u2026",
    settingsUpdated: zh ? "\u4F1A\u8BDD\u8BBE\u7F6E\u5DF2\u66F4\u65B0" : "Session settings updated",
    noModels: zh ? "\u5F53\u524D\u6CA1\u6709\u53EF\u9009\u6A21\u578B" : "No models are available",
    defaultEffort: zh ? "\u9ED8\u8BA4" : "Default",
    todoTitle: zh ? "\u4EFB\u52A1" : "To-dos",
    todoDone: zh ? "\u5DF2\u5B8C\u6210" : "completed",
    todoActive: zh ? "\u8FDB\u884C\u4E2D" : "in progress",
    todoPending: zh ? "\u5F85\u5904\u7406" : "pending"
  })};
  const HISTORY_POLL_ACTIVE_MS=250,HISTORY_POLL_IDLE_MS=750,HISTORY_POLL_IDLE_CAP_MS=5000,PENDING_SYNC_DEBOUNCE_MS=150;
  let idlePollMs=HISTORY_POLL_IDLE_MS;
  let activeSession=null,poll=null,sessionStream=null,streamConnected=false,streamEvents=[],streamProjections=null,streamRenderFrame=null,streamNeedsFullPaint=false,streamRevision=0,pendingSyncTimer=null,workspaces=[],presets=[],sessionSummaries=[],archivedSessionIds=[],historyBusy=false,lastHistoryKey='',lastDurableMessages=[],optimisticPrompts=[],latestUserTextCounts=new Map(),agentRunning=false,awaitingTurnStartedAt=0,pendingQuestion=null,questionIndex=0,questionDrafts={},questionBusy=false,sessionBlank=true,currentPreset=null,modelCatalog=null,settingsBusy=false,currentTodos=[],todoExpanded=false;
const $=id=>document.getElementById(id);
async function rpc(method,payload={}){let r;try{r=await fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,payload})})}catch{const e=new Error('');e.disconnected=true;throw e}if(r.status===401){const e=new Error('');e.disconnected=true;throw e}let j;try{j=await r.json()}catch{throw new Error(L.failed)}if(!r.ok||!j.ok)throw new Error(j.error||L.failed);return j.value}
function showError(id,error){$(id).textContent=error?.disconnected?'':error?.message||L.failed}
function stepKey(d){return String(d.turn)+':'+String(d.step)}
function contentBlocks(content){return(Array.isArray(content)?content:[]).flatMap(block=>{if(block?.type==='text'&&block.text)return[{kind:'text',text:block.text}];if(block?.type==='reasoning'&&block.text)return[{kind:'reasoning',text:block.text}];if(block?.type==='tool-call')return[{kind:'tool',id:block.id,name:block.name,args:block.arguments,status:'running'}];return[]})}
function visibleMessages(events){const out=[],steps=new Map();function ensureStep(d){const key=stepKey(d);if(!steps.has(key)){steps.set(key,{role:'assistant',blocks:[],streaming:true});out.push(steps.get(key))}return steps.get(key)}for(const entry of events){const e=entry.event||entry,d=e.data||{},t=String(e.type||'').toLowerCase();if(t==='user/message'){const message=d.message||d;if(message.source?.kind==='user'){const blocks=contentBlocks(message.content).filter(block=>block.kind==='text');if(blocks.length)out.push({role:'user',blocks})}continue}if(t==='assistant/chunk'){const chunk=d.chunk||{};if(chunk.type!=='text-delta'&&chunk.type!=='reasoning-delta')continue;const node=ensureStep(d),kind=chunk.type==='text-delta'?'text':'reasoning',streamKey=kind+':'+String(chunk.index??0);let block=node.blocks.find(item=>item?._streamKey===streamKey);if(!block){block={kind,text:'',_streamKey:streamKey};node.blocks.push(block)}block.text+=chunk.text||chunk.delta||'';continue}if(t==='assistant/message'){const node=ensureStep(d);node.blocks=contentBlocks(d.message?.content);node.streaming=false;continue}if(t==='tool/call'){const node=ensureStep(d);if(!node.blocks.some(block=>block?.kind==='tool'&&block.id===d.callId))node.blocks.push({kind:'tool',id:d.callId,name:d.name,args:d.arguments,status:'running'});continue}if(t==='tool/result'){const node=ensureStep(d),result=(d.message?.content||[]).find(block=>block?.type==='tool-result'),id=result?.toolCallId;let tool=node.blocks.find(block=>block?.kind==='tool'&&block.id===id);if(!tool){tool={kind:'tool',id,name:id||'tool',args:'',status:'running'};node.blocks.push(tool)}tool.status=d.error||result?.isError?'error':'done';tool.result=(result?.content||[]).filter(block=>block?.type==='text').map(block=>block.text).join('\\n');node.streaming=false}}return out.filter(node=>node.blocks?.some(Boolean))}
function inlineMarkdown(text){return esc(text).replace(/\\x60([^\\x60]+)\\x60/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^ )]+)\\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>')}
function tableCells(line){let value=line.trim();if(value.startsWith('|'))value=value.slice(1);if(value.endsWith('|'))value=value.slice(0,-1);return value.split('|').map(cell=>cell.trim())}
function markdown(text){const lines=String(text||'').split('\\n');let html='',code=false,list=false;for(let i=0;i<lines.length;i++){const line=lines[i];if(line.trim().startsWith(String.fromCharCode(96,96,96))){if(list){html+='</ul>';list=false}html+=code?'</code></pre>':'<pre><code>';code=!code;continue}if(code){html+=esc(line)+'\\n';continue}const next=lines[i+1]||'',separator=next.trim().replace(/^\\||\\|$/g,'').split('|');if(line.includes('|')&&separator.length>0&&separator.every(cell=>/^\\s*:?-{3,}:?\\s*$/.test(cell))){if(list){html+='</ul>';list=false}const headers=tableCells(line);html+='<div class="table-wrap"><table><thead><tr>'+headers.map(cell=>'<th>'+inlineMarkdown(cell)+'</th>').join('')+'</tr></thead><tbody>';i+=2;while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()){html+='<tr>'+tableCells(lines[i]).map(cell=>'<td>'+inlineMarkdown(cell)+'</td>').join('')+'</tr>';i++}i--;html+='</tbody></table></div>';continue}const heading=line.match(/^(#{1,3})\\s+(.+)$/);if(heading){if(list){html+='</ul>';list=false}const level=heading[1].length;html+='<h'+level+'>'+inlineMarkdown(heading[2])+'</h'+level+'>';continue}const bullet=line.match(/^[-*]\\s+(.+)$/);if(bullet){if(!list){html+='<ul>';list=true}html+='<li>'+inlineMarkdown(bullet[1])+'</li>';continue}if(list){html+='</ul>';list=false}if(line.trim())html+='<p>'+inlineMarkdown(line)+'</p>'}if(list)html+='</ul>';if(code)html+='</code></pre>';return html}
function pretty(value){if(!value)return'';try{return JSON.stringify(JSON.parse(value),null,2)}catch{return String(value)}}
function activityIcon(kind){return kind==='think'?'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.75a4 4 0 0 0-2.66 6.98c.43.38.66.88.66 1.4v.12h4v-.12c0-.52.23-1.02.66-1.4A4 4 0 0 0 7 1.75Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="M5.4 12h3.2M5.75 10.25h2.5" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>':'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1.75" y="2.25" width="10.5" height="9.5" rx="2" stroke="currentColor" stroke-width="1.15"/><path d="m4 5 1.5 1.5L4 8M7.5 8h2.5" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function activityChevron(){return'<span class="activity-chevron" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'}
function reasoningSummary(text,streaming){const lines=String(text||'').split('\\n').map(line=>line.trim()).filter(Boolean);return lines.length?(streaming?lines[lines.length-1]:lines[0]):L.running}
  function renderBlock(block,streaming){if(!block)return'';if(block.kind==='text')return'<div class="markdown'+(streaming?' streaming':'')+'">'+markdown(block.text)+'</div>';if(block.kind==='reasoning'){const state=streaming?'running':'ok';return'<details class="thinking" data-state="'+state+'"><summary><span class="activity-leading">'+activityIcon('think')+'</span><span class="activity-title">Think</span><span class="activity-dot" aria-hidden="true"></span><span class="activity-summary">'+esc(reasoningSummary(block.text,streaming))+'</span>'+activityChevron()+'</summary><div class="thinking-body markdown'+(streaming?' streaming':'')+'">'+markdown(block.text)+'</div></details>'}if(block.kind==='tool'){if(pendingQuestion&&block.status==='running'&&block.name==='ask_user_question')return'';const label=block.status==='running'?L.running:block.status==='error'?L.toolFailed:L.done;return'<details class="tool" data-state="'+esc(block.status)+'"><summary><span class="activity-leading">'+activityIcon('tool')+'</span><span class="activity-title tool-name">'+esc(block.name||'tool')+'</span><span class="activity-dot" aria-hidden="true"></span><span class="activity-summary tool-status '+esc(block.status)+'">'+label+'</span>'+activityChevron()+'</summary><div class="tool-body">'+(block.args?'<strong>'+L.input+'</strong><pre>'+esc(pretty(block.args))+'</pre>':'')+(block.result?'<strong>'+L.output+'</strong><pre>'+esc(block.result)+'</pre>':'')+'</div></details>'}return''}
function renderMessage(message){const blocks=message.blocks.filter(Boolean);return'<div class="message '+message.role+'">'+blocks.map((block,index)=>renderBlock(block,message.streaming&&index===blocks.length-1&&(block.kind==='text'||block.kind==='reasoning'))).join('')+'</div>'}
  function syncPromptUi(){const prompt=$('prompt');prompt.style.height='40px';prompt.style.height=Math.min(150,Math.max(40,prompt.scrollHeight))+'px';$('send').disabled=agentRunning||!prompt.value.trim()}
  function updateRunning(events){let running=false,latestStart=0;for(const entry of events){const event=entry.event||entry,t=String(event.type||'').toLowerCase();if(t==='turn/start'){running=true;latestStart=Math.max(latestStart,Number(event.time)||0)}else if(t==='turn/end')running=false}if(awaitingTurnStartedAt&&latestStart>=awaitingTurnStartedAt){awaitingTurnStartedAt=0}agentRunning=running||awaitingTurnStartedAt>0;$('send').hidden=agentRunning;$('cancel').hidden=!agentRunning;$('prompt').disabled=agentRunning;syncPromptUi()}
  function todoProgress(){const done=currentTodos.filter(item=>item.status==='completed').length,active=currentTodos.filter(item=>item.status==='in_progress').length,pending=currentTodos.length-done-active;return[(done?done+' '+L.todoDone:''),(active?active+' '+L.todoActive:''),(pending?pending+' '+L.todoPending:'')].filter(Boolean).join('\u2002\xB7\u2002')}
  function todoGlyph(status){if(status==='completed')return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2"/><path d="m4 7 2 2 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';if(status==='in_progress')return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1a6 6 0 1 1-5.2 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';return'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.4 2.4"/></svg>'}
  function renderTodoDock(){const host=$('todoDock'),visible=currentTodos.length>0;host.hidden=!visible;document.body.classList.toggle('todo-open',visible);document.body.classList.toggle('todo-expanded',visible&&todoExpanded);if(!visible){host.innerHTML='';return}const chevron=todoExpanded?'m3.5 5 3.5 3.5L10.5 5':'m3.5 9 3.5-3.5L10.5 9';host.innerHTML='<button class="todo-header" aria-expanded="'+todoExpanded+'"><span class="todo-lead"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4.75 3h7M4.75 7h7M4.75 11h7M2 3h.01M2 7h.01M2 11h.01" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span><span class="todo-title">'+L.todoTitle+'</span><span class="todo-progress">'+esc(todoProgress())+'</span><span class="todo-chevron"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="'+chevron+'" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>'+(todoExpanded?'<ul class="todo-list">'+currentTodos.map(item=>'<li class="todo-item" data-status="'+esc(item.status)+'"><span class="todo-glyph">'+todoGlyph(item.status)+'</span><span class="todo-content">'+esc(item.content)+'</span></li>').join('')+'</ul>':'')}
  function updateTodos(projections){const value=projections?.values?.todos;if(value===null)currentTodos=[];else if(Array.isArray(value))currentTodos=value.filter(item=>item&&typeof item.content==='string'&&['pending','in_progress','completed'].includes(item.status));renderTodoDock()}
  function presetLabel(preset){const builtIn={standard:L.presetStandard,code:L.presetCode,minimal:L.presetMinimal,cordis:L.presetCordis};const name=preset.trust==='system'&&builtIn[preset.id]?builtIn[preset.id]:preset.name||preset.id;return preset.trust==='user'?name+' \xB7 '+L.customPreset:name}
  function presetIsLocked(){return!sessionBlank||optimisticPrompts.length>0}
  function closeSessionSettings(){$('sessionSettings').hidden=true;$('sessionSettings').innerHTML='';$('settings').setAttribute('aria-expanded','false')}
  function selectedModelEntry(){const value=$('modelSelect')?.value||'',parts=value.split(''),group=(modelCatalog?.groups||[]).find(item=>item.id===parts[0]);return{group,model:group?.models?.find(item=>item.id===parts[1])}}
  function syncEffortOptions(){const field=$('effortField'),select=$('effortSelect'),entry=selectedModelEntry().model,efforts=entry?.reasoning?.efforts||[];if(!field||!select)return;field.hidden=!efforts.length;if(!efforts.length){select.innerHTML='';return}const previous=select.value,current=(modelCatalog?.current??modelCatalog?.default)?.reasoningEffort,preferred=efforts.some(item=>item.id===previous)?previous:efforts.some(item=>item.id===current)?current:entry.reasoning.defaultEffort||efforts[0].id;select.innerHTML=efforts.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join('');select.value=preferred}
  function syncSettingsControls(){const locked=presetIsLocked(),preset=$('presetSelect'),note=$('presetNote');if(preset)preset.disabled=settingsBusy||locked;if(note)note.textContent=locked?L.presetLocked:L.presetEditable;const model=$('modelSelect'),effort=$('effortSelect'),routable=(modelCatalog?.routableProviders?.length??0)>0||modelCatalog?.routable===true;if(model)model.disabled=settingsBusy||!routable;if(effort)effort.disabled=settingsBusy||!routable}
  function renderSessionSettings(){const host=$('sessionSettings');if(!modelCatalog){host.innerHTML='<div class="settings-head"><strong>'+L.sessionSettings+'</strong><button class="settings-close" data-settings-close aria-label="Close">\xD7</button></div><div class="settings-loading">'+L.settingsLoading+'</div>';return}const current=modelCatalog.current??modelCatalog.default??{},modelValue=current.provider+''+current.model,presetFallback=presets.find(item=>item.isDefault)?.id||presets[0]?.id||'',presetValue=presets.some(item=>item.id===currentPreset)?currentPreset:presetFallback;host.innerHTML='<div class="settings-head"><strong>'+L.sessionSettings+'</strong><button class="settings-close" data-settings-close aria-label="Close">\xD7</button></div><label class="setting-field"><span>'+L.model+'</span><select id="modelSelect"'+(!modelCatalog.groups?.length?' disabled':'')+'>'+(modelCatalog.groups||[]).map(group=>'<optgroup label="'+esc(group.name)+'">'+(group.models||[]).map(model=>'<option value="'+esc(group.id+''+model.id)+'">'+esc(model.name)+'</option>').join('')+'</optgroup>').join('')+'</select></label><label id="effortField" class="setting-field" hidden><span>'+L.reasoningEffort+'</span><select id="effortSelect"></select></label><label class="setting-field"><span>'+L.preset+'</span><select id="presetSelect">'+presets.map(item=>'<option value="'+esc(item.id)+'">'+esc(presetLabel(item))+'</option>').join('')+'</select></label><div id="presetNote" class="setting-note"></div><div id="settingsError" class="settings-error">'+(!modelCatalog.groups?.length?L.noModels:'')+'</div>';if((modelCatalog.groups||[]).some(group=>(group.models||[]).some(model=>group.id+''+model.id===modelValue)))$('modelSelect').value=modelValue;if($('presetSelect'))$('presetSelect').value=presetValue;syncEffortOptions();syncSettingsControls()}
  async function refreshActiveSessionSummary(){if(!activeSession)return;const value=await rpc('session.list',{}),summary=(value.items||[]).find(item=>item.sessionId===activeSession);if(summary){sessionBlank=summary.blank;currentPreset=summary.agentPreset||currentPreset;sessionSummaries=value.items||[]}syncSettingsControls()}
  async function openSessionSettings(){if(!$('sessionSettings').hidden){closeSessionSettings();return}const sessionId=activeSession;if(!sessionId)return;$('sessionSettings').hidden=false;$('settings').setAttribute('aria-expanded','true');modelCatalog=null;renderSessionSettings();try{const [models,presetValue,sessions]=await Promise.all([rpc('session.models',{sessionId}),rpc('agentPreset.list',{}),rpc('session.list',{})]);if(activeSession!==sessionId)return;modelCatalog=models;presets=(presetValue.presets||[]).filter(preset=>!preset.broken);sessionSummaries=sessions.items||[];const summary=sessionSummaries.find(item=>item.sessionId===sessionId);if(summary){sessionBlank=summary.blank;currentPreset=summary.agentPreset||currentPreset}renderSessionSettings()}catch(e){if(activeSession!==sessionId)return;modelCatalog={default:{provider:'',model:''},routableProviders:[],groups:[],failures:[]};renderSessionSettings();showError('settingsError',e)}}
  async function selectPreset(){const select=$('presetSelect');if(!select||settingsBusy||presetIsLocked()||!activeSession)return;const previous=currentPreset,next=select.value;if(!next||next===previous)return;settingsBusy=true;syncSettingsControls();try{const value=await rpc('agentPreset.select',{sessionId:activeSession,agentPreset:next});currentPreset=value.agentPreset;showToast(L.settingsUpdated)}catch(e){select.value=previous||select.value;showError('settingsError',e);await refreshActiveSessionSummary().catch(()=>{})}finally{settingsBusy=false;syncSettingsControls()}}
  async function selectModel(){const select=$('modelSelect');if(!select||settingsBusy||!activeSession)return;const entry=selectedModelEntry(),provider=entry.group?.id,model=entry.model?.id;if(!provider||!model)return;settingsBusy=true;syncSettingsControls();const reasoningEffort=$('effortSelect')?.value||entry.model?.reasoning?.defaultEffort;try{const value=await rpc('session.selectModel',{sessionId:activeSession,provider,model,...(reasoningEffort?{reasoningEffort}:{})});modelCatalog.current=modelCatalog.default=value.selected;renderSessionSettings();showToast(L.settingsUpdated)}catch(e){showError('settingsError',e);syncSettingsControls()}finally{settingsBusy=false;syncSettingsControls()}}
  function durableUserTextCounts(messages){const counts=new Map();for(const message of messages){if(message.role!=='user')continue;const text=message.blocks?.filter(block=>block?.kind==='text').map(block=>block.text).join('\\n')||'';counts.set(text,(counts.get(text)||0)+1)}return counts}
  function messagesWithOptimistic(durable){const counts=durableUserTextCounts(durable);optimisticPrompts=optimisticPrompts.filter(item=>(counts.get(item.text)||0)<item.targetCount);latestUserTextCounts=counts;lastDurableMessages=durable;return[...durable,...optimisticPrompts.map(item=>({role:'user',blocks:[{kind:'text',text:item.text}],optimistic:true}))]}
  function nextOptimisticTarget(text){let target=latestUserTextCounts.get(text)||0;for(const item of optimisticPrompts)if(item.text===text)target=Math.max(target,item.targetCount);return target+1}
  function paintMessages(messages,stickToBottom=false){const box=$('messages'),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<90,status=agentRunning&&!pendingQuestion?'<div class="turn-status" role="status" aria-live="polite">Deep diving...</div>':'';box.innerHTML=messages.map(renderMessage).join('')+status;if(stickToBottom||nearBottom)box.scrollTop=box.scrollHeight}
  function syncTurnStatus(){const box=$('messages'),current=box.querySelector('.turn-status'),visible=agentRunning&&!pendingQuestion;if(visible&&!current)box.insertAdjacentHTML('beforeend','<div class="turn-status" role="status" aria-live="polite">Deep diving...</div>');else if(!visible&&current)current.remove()}
  function patchLastStreamMessage(messages){const box=$('messages'),nodes=box.querySelectorAll(':scope > .message'),index=messages.length-1,message=messages[index],nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;if(!message||message.role!=='assistant'||index!==nodes.length-1){paintMessages(messages,false);return}nodes[index].outerHTML=renderMessage(message);syncTurnStatus();if(nearBottom)box.scrollTop=box.scrollHeight}
  function recommendation(label){const match=String(label||'').match(/\\s*\\((Recommended|\u63A8\u8350)\\)\\s*$/i);return{label:match?String(label).slice(0,match.index).trim():String(label||''),recommended:!!match}}
  function questionDraft(question){return questionDrafts[question.id]||(questionDrafts[question.id]={selected:[],custom:'',skipped:false})}
  function renderQuestionComposer(){const host=$('questionComposer'),composer=$('composer');if(!pendingQuestion||!pendingQuestion.questions?.length){host.hidden=true;composer.hidden=false;document.body.classList.remove('question-open');host.innerHTML='';return}questionIndex=Math.max(0,Math.min(questionIndex,pendingQuestion.questions.length-1));const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question),options=question.options||[],last=questionIndex===pendingQuestion.questions.length-1;host.hidden=false;composer.hidden=true;document.body.classList.add('question-open');host.innerHTML='<div class="question-shell"><div class="question-top"><span class="question-mark">'+activityIcon('tool')+'</span><div class="question-context"><strong>'+esc(question.header||L.questionNeeded)+'</strong><span>'+(questionIndex+1)+' / '+pendingQuestion.questions.length+' '+L.questionProgress+'</span></div><button class="question-close" data-question-action="cancel" aria-label="'+esc(L.cancelQuestions)+'">\xD7</button></div><div class="question-body"><h2 class="question-title">'+esc(question.question)+'</h2>'+(question.detail?'<div class="question-detail markdown">'+markdown(question.detail)+'</div>':'')+(options.length?'<div class="question-options'+(question.multiSelect?' multi':'')+'">'+options.map((option,index)=>{const display=recommendation(option.label),selected=draft.selected.includes(option.label);return'<button class="question-option'+(selected?' selected':'')+'" data-option-index="'+index+'"><span class="option-control">'+(selected?'\u2713':'')+'</span><span class="option-copy"><span class="option-label">'+esc(display.label)+(display.recommended?'<span class="recommendation">'+L.recommended+'</span>':'')+'</span>'+(option.description?'<span class="option-description">'+esc(option.description)+'</span>':'')+'</span></button>'}).join('')+'</div>':'')+'<label class="custom-label" for="questionCustom">'+L.customAnswer+'</label><textarea id="questionCustom" class="question-custom" placeholder="'+esc(L.customPlaceholder)+'">'+esc(draft.custom)+'</textarea></div><div id="questionError" class="question-error"></div><div class="question-actions">'+(questionIndex?'<button data-question-action="previous">'+L.previous+'</button>':'<button data-question-action="cancel">'+L.cancelQuestions+'</button>')+'<span class="spacer"></span><button data-question-action="skip">'+L.skip+'</button><button class="submit-answer" data-question-action="continue">'+(questionBusy?L.answering:last?L.submitAnswer:L.next)+'</button></div></div>';host.querySelectorAll('button').forEach(button=>button.disabled=questionBusy)}
  function syncPendingQuestion(next){const changed=(pendingQuestion?.rpcId||null)!==(next?.rpcId||null);pendingQuestion=next;if(changed){questionIndex=0;questionDrafts={};questionBusy=false;renderQuestionComposer()}}
  function advanceQuestion(skip=false){if(!pendingQuestion||questionBusy)return;const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=String($('questionCustom')?.value||'').trim();if(skip){draft.selected=[];draft.custom='';draft.skipped=true}else{draft.skipped=false;if(!draft.selected.length&&!draft.custom){$('questionError').textContent=L.chooseAnswer;return}}if(questionIndex<pendingQuestion.questions.length-1){questionIndex+=1;renderQuestionComposer()}else submitQuestionAnswers()}
  async function submitQuestionAnswers(){if(!pendingQuestion||questionBusy)return;questionBusy=true;renderQuestionComposer();const current=pendingQuestion;const answers=current.questions.map(question=>{const draft=questionDraft(question);return{id:question.id,selected:!question.multiSelect&&draft.custom?[]:draft.selected,...(draft.custom?{custom:draft.custom}:{})}});try{await rpc('interaction.answer',{rpcId:current.rpcId,sessionId:current.sessionId,answers});lastHistoryKey='';await loadHistory(false)}catch(e){questionBusy=false;renderQuestionComposer();showError('questionError',e)}}
  async function cancelQuestionRequest(){if(!pendingQuestion||questionBusy)return;questionBusy=true;renderQuestionComposer();const current=pendingQuestion;try{await rpc('interaction.cancel',{rpcId:current.rpcId,sessionId:current.sessionId});lastHistoryKey='';await loadHistory(false)}catch(e){questionBusy=false;renderQuestionComposer();showError('questionError',e)}}
async function loadWorkspaces(){const previous=$('workspace').value,value=await rpc('workspace.list');workspaces=value.items||[];archivedSessionIds=value.archivedSessionIds||[];if(workspaces.length){$('workspace').innerHTML=workspaces.map(w=>'<option value="'+esc(w.workspaceId)+'">'+esc(w.title||w.path)+'</option>').join('');$('workspace').value=workspaces.some(w=>w.workspaceId===previous)?previous:workspaces[0].workspaceId}else $('workspace').innerHTML='<option value="">'+L.noWorkspaces+'</option>'}
  function syncWorkspaceUi(){const selected=!!$('workspace').value;$('newSession').disabled=!selected;$('workspaceHint').hidden=selected;$('workspaceHint').textContent=selected?'':L.noWorkspaces;if(selected)$('listError').textContent=''}
function relativeTime(value){const parsed=typeof value==='number'?value:Date.parse(value),elapsed=Math.max(0,Date.now()-(Number.isFinite(parsed)?parsed:Date.now())),minutes=Math.floor(elapsed/60000);if(minutes<1)return L.justNow;if(minutes<60)return minutes+L.minute;const hours=Math.floor(minutes/60);if(hours<24)return hours+L.hour;return Math.floor(hours/24)+L.day}
async function loadSessions(){try{const value=await rpc('session.list',{}),wid=$('workspace').value,w=workspaces.find(x=>x.workspaceId===wid),allowed=w?new Set(w.sessionIds):new Set(),archived=new Set(archivedSessionIds);sessionSummaries=value.items||[];const items=sessionSummaries.filter(s=>allowed.has(s.sessionId)&&!archived.has(s.sessionId)).sort((a,b)=>b.updatedAt-a.updatedAt);$('sessionCount').textContent=String(items.length);$('sessions').innerHTML=!wid?'':items.length?items.map(s=>{const title=titleFor(s);return'<button class="row" data-id="'+esc(s.sessionId)+'" data-title="'+esc(title)+'"><span class="session-mark"><svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 5.75C4 4.78 4.78 4 5.75 4h8.5C15.22 4 16 4.78 16 5.75v5.5c0 .97-.78 1.75-1.75 1.75H9l-3.5 2.5V13A1.5 1.5 0 0 1 4 11.5V5.75Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></span><span class="row-copy"><strong>'+esc(title)+'</strong><time>'+esc(relativeTime(s.updatedAt))+'</time></span><svg class="row-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg></button>'}).join(''):'<div class="empty"><span class="empty-mark"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 5.75C4 4.78 4.78 4 5.75 4h8.5C15.22 4 16 4.78 16 5.75v5.5c0 .97-.78 1.75-1.75 1.75H9l-3.5 2.5V13A1.5 1.5 0 0 1 4 11.5V5.75Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></span><strong>'+L.noSessions+'</strong><span>'+L.emptyHint+'</span></div>';document.querySelectorAll('.row').forEach(b=>b.onclick=()=>openSession(b.dataset.id,b.dataset.title));$('listError').textContent=''}catch(e){showError('listError',e)}}
function recentSession(){const archived=new Set(archivedSessionIds),owned=new Set(workspaces.flatMap(w=>w.sessionIds||[]));return sessionSummaries.filter(s=>owned.has(s.sessionId)&&!archived.has(s.sessionId)).sort((a,b)=>b.updatedAt-a.updatedAt)[0]}
async function openRecentSession(){const recent=recentSession();if(!recent)return;const owner=workspaces.find(w=>(w.sessionIds||[]).includes(recent.sessionId));if(owner&&$('workspace').value!==owner.workspaceId){$('workspace').value=owner.workspaceId;syncWorkspaceUi();await loadSessions()}await openSession(recent.sessionId,titleFor(recent),true)}
  async function createSession(){const workspaceId=$('workspace').value;if(!workspaceId){$('listError').textContent=L.chooseWorkspace;return}try{const created=await rpc('session.create',{workspaceId});sessionSummaries.push({sessionId:created.sessionId,updatedAt:Date.now(),running:false,blank:true,agentPreset:created.agentPreset});await openSession(created.sessionId)}catch(e){showError('listError',e)}}
function showToast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>$('toast').classList.remove('show'),1000)}
  async function refreshAll(){const button=$('refresh');button.disabled=true;button.classList.add('refreshing');try{await loadWorkspaces();syncWorkspaceUi();await loadSessions();showToast(L.refreshed)}catch(e){showError('listError',e)}finally{setTimeout(()=>{button.disabled=false;button.classList.remove('refreshing')},350)}}
function titleFor(s){const p=s.projections&&s.projections.values||{};return p.title||p.sessionTitle||p['session.title']||L.untitled}
  function resetOptimisticMessages(){lastDurableMessages=[];optimisticPrompts=[];latestUserTextCounts=new Map();awaitingTurnStartedAt=0;agentRunning=false;currentTodos=[];todoExpanded=false;renderTodoDock()}
  function closeSessionStream(){if(sessionStream)sessionStream.close();if(streamRenderFrame!==null)cancelAnimationFrame(streamRenderFrame);if(pendingSyncTimer!==null)clearTimeout(pendingSyncTimer);sessionStream=null;streamConnected=false;streamEvents=[];streamProjections=null;streamRenderFrame=null;streamNeedsFullPaint=false;streamRevision=0;pendingSyncTimer=null}
  function applyHistory(value,pending,initial){if(pending!==undefined)syncPendingQuestion(pending);const events=value.events||[],durable=visibleMessages(events);if(durable.some(message=>message.role==='user'))sessionBlank=false;const messages=messagesWithOptimistic(durable);updateRunning(events);updateTodos(value.projections);const key=JSON.stringify([messages,pendingQuestion?.rpcId||null,agentRunning,currentTodos,todoExpanded]);syncSettingsControls();if(key!==lastHistoryKey){paintMessages(messages,initial);lastHistoryKey=key;idlePollMs=HISTORY_POLL_IDLE_MS}}
  function flushStreamRender(sessionId){streamRenderFrame=null;if(activeSession!==sessionId)return;const durable=visibleMessages(streamEvents),messages=messagesWithOptimistic(durable);if(durable.some(message=>message.role==='user'))sessionBlank=false;updateRunning(streamEvents);syncSettingsControls();if(streamNeedsFullPaint)paintMessages(messages,false);else patchLastStreamMessage(messages);streamNeedsFullPaint=false;lastHistoryKey='';idlePollMs=HISTORY_POLL_IDLE_MS}
  function queueStreamRender(sessionId,fullPaint){streamNeedsFullPaint=streamNeedsFullPaint||fullPaint;if(streamRenderFrame===null)streamRenderFrame=requestAnimationFrame(()=>flushStreamRender(sessionId))}
  function schedulePendingSync(sessionId){if(pendingSyncTimer!==null)return;pendingSyncTimer=setTimeout(()=>{pendingSyncTimer=null;if(activeSession===sessionId)void rpc('interaction.pending',{sessionId}).then(syncPendingQuestion).catch(()=>{})},PENDING_SYNC_DEBOUNCE_MS)}
  function openSessionStream(sessionId){closeSessionStream();const source=new EventSource('/api/session/stream?sessionId='+encodeURIComponent(sessionId));sessionStream=source;source.addEventListener('snapshot',event=>{if(activeSession!==sessionId)return;const frame=JSON.parse(event.data);streamEvents=frame.records||[];streamProjections=frame.projections;streamConnected=true;streamRevision+=1;applyHistory({events:streamEvents,projections:streamProjections},pendingQuestion,false)});source.addEventListener('event',event=>{if(activeSession!==sessionId)return;const frame=JSON.parse(event.data),entry=frame.event||frame,type=String(entry.type||'').toLowerCase();streamEvents.push(frame);streamRevision+=1;queueStreamRender(sessionId,type!=='assistant/chunk');if(type!=='assistant/chunk')schedulePendingSync(sessionId)});source.onerror=()=>{streamConnected=false;schedulePoll()}}
  function showSessionList(){clearTimeout(poll);poll=null;closeSessionStream();closeSessionSettings();activeSession=null;resetOptimisticMessages();syncPendingQuestion(null);document.body.classList.remove('chat-open');$('chatView').classList.remove('active');$('sessionsView').classList.add('active');loadSessions()}
  async function openSession(id,title,fromHistory=false){clearTimeout(poll);closeSessionStream();if(!fromHistory)history.pushState({view:'chat',sessionId:id,title:title||L.untitled},'');activeSession=id;const summary=sessionSummaries.find(item=>item.sessionId===id);sessionBlank=summary?.blank??true;currentPreset=summary?.agentPreset||null;modelCatalog=null;closeSessionSettings();lastHistoryKey='';resetOptimisticMessages();syncPendingQuestion(null);document.body.classList.add('chat-open');$('sessionsView').classList.remove('active');$('chatView').classList.add('active');$('messages').innerHTML='<div class="loading"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';openSessionStream(id);await loadHistory(true);schedulePoll()}
function handleHistory(state){if(state?.view==='chat'&&state.sessionId)openSession(state.sessionId,state.title,true);else showSessionList()}
  // Each poll refetches the last 100 messages through Harness, so an idle chat
  // left open used to cost the desktop a full history serialisation every
  // 750ms indefinitely. Back off while nothing changes, and stop entirely
  // while the tab is hidden.
  function schedulePoll(){clearTimeout(poll);poll=null;if(!activeSession||document.hidden)return;const delay=streamConnected?HISTORY_POLL_IDLE_CAP_MS:agentRunning||pendingQuestion?HISTORY_POLL_ACTIVE_MS:idlePollMs;poll=setTimeout(()=>{void loadHistory(false)},delay)}
  async function loadHistory(initial){if(!activeSession||historyBusy)return;historyBusy=true;const revision=streamRevision;try{const sessionId=activeSession,[value,pending]=await Promise.all([rpc('session.history',{sessionId,maxMessages:100}),rpc('interaction.pending',{sessionId})]);if(activeSession!==sessionId)return;if(streamConnected&&streamRevision!==revision){syncPendingQuestion(pending);return}applyHistory(value,pending,initial);if(!streamConnected&&!agentRunning&&!pendingQuestion)idlePollMs=Math.min(Math.round(idlePollMs*1.5),HISTORY_POLL_IDLE_CAP_MS);$('chatError').textContent=''}catch(e){showError('chatError',e)}finally{historyBusy=false;schedulePoll()}}
async function send(){const text=$('prompt').value.trim();if(!text||!activeSession)return;const optimistic={id:String(Date.now())+Math.random(),text,targetCount:nextOptimisticTarget(text)};optimisticPrompts.push(optimistic);sessionBlank=false;awaitingTurnStartedAt=Date.now()-1000;agentRunning=true;syncSettingsControls();$('send').hidden=true;$('cancel').hidden=false;$('prompt').disabled=true;$('send').disabled=true;$('prompt').value='';syncPromptUi();paintMessages([...lastDurableMessages,...optimisticPrompts.map(item=>({role:'user',blocks:[{kind:'text',text:item.text}],optimistic:true}))],true);lastHistoryKey='';try{await rpc('session.prompt',{sessionId:activeSession,mode:'steer',content:[{type:'text',text}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});await loadHistory(false)}catch(e){optimisticPrompts=optimisticPrompts.filter(item=>item.id!==optimistic.id);awaitingTurnStartedAt=0;agentRunning=false;$('send').hidden=false;$('cancel').hidden=true;$('prompt').disabled=false;showError('chatError',e);$('prompt').value=text;paintMessages([...lastDurableMessages,...optimisticPrompts.map(item=>({role:'user',blocks:[{kind:'text',text:item.text}],optimistic:true}))],true);await refreshActiveSessionSummary().catch(()=>{})}finally{syncPromptUi();syncSettingsControls()}}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function syncViewport(){const viewport=window.visualViewport;document.documentElement.style.setProperty('--app-height',(viewport?.height||window.innerHeight)+'px');if(document.activeElement===$('prompt'))requestAnimationFrame(()=>$('prompt').scrollIntoView({block:'end'}))}
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(poll);poll=null;return}idlePollMs=HISTORY_POLL_IDLE_MS;if(activeSession)void loadHistory(false);void checkConnection()});
window.visualViewport?.addEventListener('resize',syncViewport);window.visualViewport?.addEventListener('scroll',syncViewport);window.addEventListener('resize',syncViewport);syncViewport();
history.replaceState({view:'sessions'},'');window.addEventListener('popstate',event=>handleHistory(event.state));
  $('workspace').onchange=()=>{syncWorkspaceUi();loadSessions()};$('newSession').onclick=createSession;$('refresh').onclick=refreshAll;$('settings').onclick=openSessionSettings;$('sessionSettings').onclick=e=>{if(e.target.closest('[data-settings-close]'))closeSessionSettings()};$('sessionSettings').onchange=e=>{if(e.target.id==='presetSelect')selectPreset();else if(e.target.id==='modelSelect'){syncEffortOptions();selectModel()}else if(e.target.id==='effortSelect')selectModel()};$('todoDock').onclick=e=>{if(e.target.closest('.todo-header')){todoExpanded=!todoExpanded;renderTodoDock();lastHistoryKey='';paintMessages(messagesWithOptimistic(lastDurableMessages),false)}};$('send').onclick=send;$('prompt').oninput=syncPromptUi;$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send()}};$('prompt').onfocus=syncViewport;$('back').onclick=()=>{if(history.state?.view==='chat')history.back();else showSessionList()};$('cancel').onclick=async()=>{if(activeSession){awaitingTurnStartedAt=0;await rpc('session.cancel',{sessionId:activeSession});lastHistoryKey='';await loadHistory(false)}};$('questionComposer').onclick=e=>{const option=e.target.closest('[data-option-index]');if(option&&pendingQuestion&&!questionBusy){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question),label=question.options[Number(option.dataset.optionIndex)]?.label;if(label){draft.skipped=false;if(question.multiSelect)draft.selected=draft.selected.includes(label)?draft.selected.filter(item=>item!==label):[...draft.selected,label];else{draft.selected=[label];draft.custom=''}renderQuestionComposer()}return}const action=e.target.closest('[data-question-action]')?.dataset.questionAction;if(action==='continue')advanceQuestion(false);else if(action==='skip')advanceQuestion(true);else if(action==='cancel')cancelQuestionRequest();else if(action==='previous'&&pendingQuestion){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=String($('questionCustom')?.value||'').trim();questionIndex=Math.max(0,questionIndex-1);renderQuestionComposer()}};$('questionComposer').oninput=e=>{if(e.target.id==='questionCustom'&&pendingQuestion){const question=pendingQuestion.questions[questionIndex],draft=questionDraft(question);draft.custom=e.target.value;if(!question.multiSelect&&draft.custom.trim()){draft.selected=[];$('questionComposer').querySelectorAll('.question-option.selected').forEach(option=>{option.classList.remove('selected');const control=option.querySelector('.option-control');if(control)control.textContent=''})}}};$('questionComposer').onkeydown=e=>{if(e.target.id==='questionCustom'&&e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.isComposing&&e.keyCode!==229){e.preventDefault();advanceQuestion(false)}};document.addEventListener('click',e=>{if(!$('sessionSettings').hidden&&!e.target.closest('#sessionSettings')&&!e.target.closest('#settings'))closeSessionSettings()});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSessionSettings()});
async function checkConnection(){if(document.hidden)return;const status=$('status');try{const response=await fetch('/api/status',{cache:'no-store'});status.classList.remove('connecting','error-state');if(response.ok){status.setAttribute('aria-label',${JSON.stringify(zh ? "\u5DF2\u8FDE\u63A5" : "Connected")})}else{if(response.status===401){location.replace('/disconnected');return}status.classList.add('error-state');$('listError').textContent='';$('chatError').textContent='';status.setAttribute('aria-label',${JSON.stringify(zh ? "\u5DF2\u65AD\u5F00" : "Disconnected")})}}catch{status.classList.remove('connecting');status.classList.add('error-state');$('listError').textContent='';$('chatError').textContent='';status.setAttribute('aria-label',${JSON.stringify(zh ? "\u5DF2\u65AD\u5F00" : "Disconnected")})}}
setInterval(checkConnection,1500);checkConnection();
(async()=>{try{await loadWorkspaces();syncWorkspaceUi();await loadSessions();await openRecentSession()}catch(e){showError('listError',e)}})();
</script></body></html>`;
}
function renderMobileReconnectPage(locale, connectionMode = "lan") {
  const zh = locale === "zh";
  const text = {
    title: zh ? "\u91CD\u65B0\u8FDE\u63A5 DSH" : "Reconnect DSH",
    heading: zh ? "\u8FDE\u63A5\u5DF2\u65AD\u5F00" : "Connection lost",
    action: zh ? "\u91CD\u65B0\u8FDE\u63A5" : "Reconnect",
    guidance: connectionMode === "tunnel" ? zh ? "\u70B9\u51FB\u91CD\u65B0\u8FDE\u63A5\uFF0C\u7136\u540E\u5728\u7535\u8111\u4E0A\u7684 DSH Desktop \u4E2D\u5141\u8BB8\u6B64\u79FB\u52A8\u8BBE\u5907\u3002" : "Reconnect, then approve this mobile device in DSH Desktop." : zh ? "\u8BF7\u786E\u4FDD\u624B\u673A\u548C\u7535\u8111\u8FDE\u63A5\u5230\u540C\u4E00 Wi-Fi\u3002\u70B9\u51FB\u91CD\u65B0\u8FDE\u63A5\u540E\uFF0C\u5728\u7535\u8111\u4E0A\u7684 DSH Desktop \u4E2D\u5141\u8BB8\u6B64\u624B\u673A\u3002" : "Keep both devices on the same Wi-Fi, then reconnect and approve this phone in DSH Desktop."
  };
  return `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)"><title>${text.title}</title><style>:root{color-scheme:light;--bg:#fff;--ink:#18191c;--muted:#81858c}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--ink:#f5f5f6;--muted:#95979d}}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:100%;max-width:340px;text-align:center}.brand{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:22px;font-size:13px;font-weight:600}.brand img{width:35px;height:20px;object-fit:contain}.brand .dark-logo{display:none}@media(prefers-color-scheme:dark){.brand .light-logo{display:none}.brand .dark-logo{display:block}}h1{margin:0;font-size:28px;line-height:1.18;letter-spacing:-.03em}.guidance{margin:13px auto 0;max-width:310px;color:var(--muted);font-size:14px;line-height:1.65}.primary{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;height:50px;margin-top:26px;border-radius:15px;background:var(--ink);color:var(--bg);font-weight:650;text-decoration:none}</style></head><body><main class="card"><div class="brand"><img class="light-logo" src="/brand-logo/light" alt=""><img class="dark-logo" src="/brand-logo/dark" alt=""><span>DSH Desktop</span></div><h1>${text.heading}</h1><p class="guidance">${text.guidance}</p><a class="primary" href="/reconnect">${text.action}<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg></a></main></body></html>`;
}
function renderDesktopPairingPage(options) {
  const zh = options.locale === "zh";
  const text = {
    title: zh ? "\u8FDE\u63A5\u79FB\u52A8\u8BBE\u5907" : "Connect Mobile Device",
    heading: zh ? "\u8FDE\u63A5\u79FB\u52A8\u8BBE\u5907" : "Connect a mobile device",
    hint: zh ? "\u8BF7\u4F7F\u7528\u624B\u673A\u626B\u63CF\u4E8C\u7EF4\u7801\uFF0C\u5728\u624B\u673A\u4E0A\u7EE7\u7EED\u5BF9\u8BDD\u3002" : "Scan the QR code with your phone to continue conversation.",
    lanHint: zh ? "\u79FB\u52A8\u8BBE\u5907\u4E0E\u7535\u8111\u9700\u8FDE\u63A5\u81F3\u540C\u4E00 WiFi\uFF0C\u540C\u6B65\u5B9E\u65F6\u6027\u9AD8" : "Keep the mobile device and computer on the same WiFi for high real-time responsiveness.",
    tunnelHint: zh ? "\u79FB\u52A8\u8BBE\u5907\u901A\u8FC7\u4E92\u8054\u7F51\uFF08\u5982 4G/5G \u6216\u5176\u4ED6WiFi\u7F51\u7EDC\u7B49\uFF09\u5747\u53EF\u8FDC\u7A0B\u64CD\u63A7\uFF0C\u540C\u6B65\u5B9E\u65F6\u6027\u4E2D\u7B49" : "Control remotely over the internet, including 4G/5G or other WiFi networks, with moderate real-time responsiveness.",
    tunnelLoading: zh ? "\u6B63\u5728\u521B\u5EFA\u5168\u7403\u7F51\u7EDC\u94FE\u63A5" : "Creating a global network link",
    lanLoading: zh ? "\u6B63\u5728\u5207\u6362\u81F3 WiFi \u8FDE\u63A5\u6A21\u5F0F" : "Switching to WiFi connection mode",
    modeLan: zh ? "WiFi\u8FDE\u63A5\u6A21\u5F0F" : "WiFi Connection Mode",
    modeTunnel: zh ? "\u4E92\u8054\u7F51\u8FDE\u63A5\u6A21\u5F0F" : "Internet Connection Mode",
    manageHeading: zh ? "\u7BA1\u7406\u624B\u673A\u8FDE\u63A5" : "Manage phone connection",
    manageHint: zh ? "\u8FD9\u53F0\u624B\u673A\u5F53\u524D\u5DF2\u8FDE\u63A5\u5230 DSH Desktop\u3002" : "Your phone is currently connected to DSH Desktop.",
    connected: zh ? "\u624B\u673A\u5DF2\u8FDE\u63A5" : "Phone connected",
    closeHint: zh ? "\u8FDE\u63A5\u4F1A\u5728\u540E\u53F0\u4FDD\u6301\uFF0C\u73B0\u5728\u53EF\u4EE5\u5173\u95ED\u6B64\u7A97\u53E3\u3002" : "The connection stays active in the background. You can close this window now.",
    done: zh ? "\u5B8C\u6210" : "Done",
    disconnect: zh ? "\u65AD\u5F00\u8FDE\u63A5" : "Disconnect",
    copy: zh ? "\u590D\u5236" : "Copy",
    copied: zh ? "\u5DF2\u590D\u5236" : "Copied",
    waiting: zh ? "\u624B\u673A\u6B63\u5728\u7B49\u5F85\u6279\u51C6" : "Phone waiting for approval",
    deviceAddress: zh ? "\u8BBE\u5907\u5730\u5740\uFF1A" : "Device address: ",
    requestLan: zh ? "\u8FDE\u63A5\u65B9\u5F0F\uFF1AWiFi \u8FDE\u63A5\u6A21\u5F0F" : "Connection: WiFi connection mode",
    requestTunnel: zh ? "\u8FDE\u63A5\u65B9\u5F0F\uFF1A\u4E92\u8054\u7F51\u8FDE\u63A5\u6A21\u5F0F" : "Connection: Internet connection mode",
    decline: zh ? "\u62D2\u7EDD" : "Decline",
    allow: zh ? "\u5141\u8BB8" : "Allow",
    refresh: zh ? "\u4E8C\u7EF4\u7801\u5C06\u5728 " : "QR refreshes in ",
    seconds: zh ? " \u79D2\u540E\u5237\u65B0" : "s",
    expired: zh ? "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u6B63\u5728\u81EA\u52A8\u5237\u65B0\u2026" : "QR expired. Refreshing automatically\u2026",
    tunnelError: zh ? "\u96A7\u9053\u5EFA\u7ACB\u5931\u8D25\uFF1A" : "Tunnel failed: ",
    fallbackLink: zh ? "\u626B\u7801\u6253\u4E0D\u5F00\uFF1F\u6362\u4E00\u6761\u7EBF\u8DEF" : "Can't open? Try another link",
    fallbackLoading: zh ? "\u6B63\u5728\u5207\u6362\u5907\u7528\u7EBF\u8DEF" : "Switching to a backup link"
  };
  const showFallback = Boolean(
    options.tunnelActive && options.tunnelProvider === "cloudflare" && !options.connected
  );
  return `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${text.title}</title><style>
  :root{color-scheme:light;--bg:#fff;--surface:#fff;--panel:#f7f8fa;--ink:#18191c;--muted:#81858c;--line:#e5e7eb;--brand:#4d6bfe;--success-bg:#f2f8f4;--success-ink:#277347;--success-muted:#557565;--request-accent:#c16f52;--request-border:#dfbcae;--request-bg:#fbf6f3}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--surface:#1d1d20;--panel:#202023;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--brand:#6f86ff;--success-bg:#17261d;--success-ink:#75c991;--success-muted:#8ab99a;--request-accent:#df9275;--request-border:#68483d;--request-bg:#291f1c}}*{box-sizing:border-box}html,body{min-height:100%;background:var(--bg)}body{margin:0;color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:520px;margin:auto;padding:26px 32px 30px;text-align:center}.brand{display:flex;align-items:center;justify-content:center;gap:9px;font-weight:600;margin-bottom:14px}.brand img{width:39px;height:22px;object-fit:contain}.brand .dark-logo{display:none}@media(prefers-color-scheme:dark){.brand .light-logo{display:none}.brand .dark-logo{display:block}}h1{font-size:24px;line-height:1.25;font-weight:600;margin:0}p{margin:0;color:var(--muted)}
  .mode-panel{max-width:410px;margin:18px auto 0;padding:5px 8px 10px;border:1px solid var(--line);border-radius:15px;background:var(--panel)}
  .mode-switch{display:grid;grid-template-columns:1fr 1fr;width:100%;padding:3px;border-radius:11px;gap:3px}
  .mode-btn{min-width:0;height:34px;border:0;background:transparent;color:var(--muted);padding:0 10px;border-radius:9px;font-size:13px;font-weight:550;cursor:pointer;transition:background .15s,color .15s}
  .mode-btn.active{background:var(--surface);color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.08)}
  .mode-btn:disabled{cursor:not-allowed;opacity:.5}.mode-btn.active:disabled{opacity:.72}
  .connection{display:none;flex-direction:column;align-items:center;margin:24px auto 0;max-width:390px;padding:22px;border-radius:14px;background:var(--success-bg);color:var(--success-ink)}.connection.show{display:flex}.connection-title{font-size:16px;font-weight:600}.connection-title:before{content:'\u2713';display:inline-grid;place-items:center;width:24px;height:24px;margin-right:9px;border-radius:50%;background:#35a867;color:white}.connection-hint{max-width:310px;margin-top:8px;color:var(--success-muted);font-size:13px}.connection-actions{display:flex;gap:8px;margin-top:18px}.connection-actions button{min-width:94px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:8px 14px;cursor:pointer}.connection-actions .done{background:var(--ink);color:var(--bg);border-color:var(--ink)}.phone-connected .pairing-content{display:none}.manage-connected .connection-hint,.manage-connected .done{display:none}.manage-connected .connection-actions{margin-top:16px}
  .pairing-content{margin-top:16px}.qr{display:inline-flex;background:#fff;padding:12px;border:1px solid var(--line);border-radius:16px;margin:0 0 10px;min-width:244px;min-height:244px;align-items:center;justify-content:center;position:relative}
  .qr svg{width:220px;height:220px;display:block}
  .qr-loading{position:absolute;inset:0;background:rgba(255,255,255,.94);border-radius:16px;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;font-size:13px;color:#18191c;font-weight:550}
  .qr-loading.show{display:flex}
  .loading-copy{display:flex;width:176px;align-items:center;justify-content:space-between;gap:12px}.loading-copy span:first-child{text-align:left}.loading-value{min-width:32px;text-align:right;color:#62666d;font-variant-numeric:tabular-nums}.tunnel-progress{width:176px;height:5px;overflow:hidden;border-radius:999px;background:#e5e7eb}.tunnel-progress span{display:block;width:0;height:100%;border-radius:inherit;background:var(--brand);transition:width .08s linear}@media(prefers-reduced-motion:reduce){.tunnel-progress span{transition:none}}
  .hint{min-height:38px;display:flex;align-items:center;justify-content:center;font-size:12.5px;line-height:1.55;max-width:370px;margin:7px auto 0;padding:0 5px}
  .url-row{display:flex;align-items:center;gap:8px;margin:10px auto 0;max-width:410px}.url{min-width:0;flex:1;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--panel);border-radius:9px;padding:9px 11px;text-align:left}.copy{position:relative;display:grid;place-items:center;width:28px;height:28px;flex:none;border:0;background:transparent;color:var(--muted);padding:0;cursor:pointer}.copy:hover{color:var(--ink)}.copy-icon{display:block}.copy-done{display:none;place-items:center;width:16px;height:16px;border-radius:50%;background:#35a867;color:#fff}.copy.copied .copy-icon{display:none}.copy.copied .copy-done{display:grid}.copy-done svg{display:block}.copy-tip{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);background:#fff;color:#18191c;border-radius:6px;padding:5px 8px;font-size:12px;line-height:1.2;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.12);opacity:0;pointer-events:none}.copy-tip:after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:5px solid transparent;border-top-color:#fff}.copy:hover .copy-tip,.copy.copied .copy-tip{opacity:1}.fallback-link{display:inline-block;margin:8px auto 0;border:0;background:transparent;color:var(--muted);font-size:12.5px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}.fallback-link.hide{display:none}.expires{font-size:12px;margin-top:8px}
  .request{display:none;max-width:410px;margin:16px auto 0;padding:16px;border:1px solid var(--request-border);border-radius:14px;background:var(--request-bg);text-align:left}.request.show{display:block}.request-title{display:flex;align-items:center;gap:8px;font-weight:600}.request-title:before{content:'';width:8px;height:8px;border-radius:50%;background:var(--request-accent)}.request-meta{font-size:12px;color:var(--muted);margin:5px 0 0 16px}#address:empty{display:none}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.actions button{min-width:62px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);padding:8px 14px;cursor:pointer}.actions .allow{background:var(--ink);color:var(--bg);border-color:var(--ink)}.has-request .qr,.has-request .url-row,.has-request .expires,.has-request .fallback-link{display:none}.has-request .request{margin-top:0}
  .tunnel-err{display:none;color:#e34d59;font-size:12px;margin:5px 7px 0}.tunnel-err.show{display:block}
  </style></head><body class="${options.connected ? "phone-connected manage-connected" : ""}"><div class="wrap"><div class="brand"><img class="light-logo" src="/brand-logo/light" alt=""><img class="dark-logo" src="/brand-logo/dark" alt=""><span>DSH Desktop</span></div><h1>${options.connected ? text.manageHeading : text.heading}</h1>
  <div class="mode-panel"><div class="mode-switch"><button id="btnLan" class="mode-btn${!options.tunnelActive ? " active" : ""}" onclick="switchMode(false)"${options.connected ? " disabled" : ""}>${text.modeLan}</button><button id="btnTunnel" class="mode-btn${options.tunnelActive ? " active" : ""}" onclick="switchMode(true)"${options.connected ? " disabled" : ""}>${text.modeTunnel}</button></div><p class="hint" id="modeHint">${options.tunnelActive ? text.tunnelHint : text.lanHint}</p><div id="tunnelError" class="tunnel-err${options.tunnelActive && options.tunnelError ? " show" : ""}">${options.tunnelActive && options.tunnelError ? text.tunnelError + options.tunnelError : ""}</div></div>
  <div id="connection" class="connection${options.connected ? " show" : ""}"><div class="connection-title">${text.connected}</div><p class="connection-hint">${text.closeHint}</p><div class="connection-actions"><button onclick="disconnectPhone()">${text.disconnect}</button><button class="done" onclick="window.close()">${text.done}</button></div></div>
  <div class="pairing-content"><div id="qrContainer" class="qr"><div id="qrCode">${options.qrSvg}</div><div id="qrLoading" class="qr-loading${options.tunnelLoading ? " show" : ""}"><div class="loading-copy"><span id="tunnelLoadingText">${text.tunnelLoading}</span><span id="tunnelProgressValue" class="loading-value">0%</span></div><div class="tunnel-progress" aria-hidden="true"><span id="tunnelProgressBar"></span></div></div></div><div class="url-row"><div class="url" id="url">${escapeHtml(options.pairingUrl)}</div><button type="button" id="copyBtn" class="copy" onclick="copyUrl()" aria-label="${text.copy}"><svg class="copy-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M3.75 10.25V3.75h6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="copy-done" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.4 6.2 4.7 8.5 9.6 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="copy-tip" id="copyTip">${text.copy}</span></button></div><button type="button" id="fallbackLink" class="fallback-link${showFallback ? "" : " hide"}" onclick="switchFallback()">${text.fallbackLink}</button><p id="expires" class="expires"></p><div id="request" class="request"><div class="request-title">${text.waiting}</div><div id="requestMode" class="request-meta"></div><div id="address" class="request-meta"></div><div class="actions"><button onclick="decide(false)">${text.decline}</button><button class="allow" onclick="decide(true)">${text.allow}</button></div></div></div></div>
  <script>let end=${options.expiresAt},pairingUrl=${JSON.stringify(options.pairingUrl)},T=${JSON.stringify(text)},pendingId=null,tunnelActive=${Boolean(options.tunnelActive)},selectedTunnelTab=${Boolean(options.tunnelActive)},tunnelProvider=${JSON.stringify(options.tunnelProvider ?? null)},phoneConnected=${options.connected},modeSwitching=false,tunnelProgressTimer=null,tunnelProgressStartedAt=0,copyFeedbackTimer=null;
  async function copyUrl(){try{await navigator.clipboard.writeText(pairingUrl)}catch{return}const btn=document.getElementById('copyBtn'),tip=document.getElementById('copyTip');btn.classList.add('copied');tip.textContent=T.copied;clearTimeout(copyFeedbackTimer);copyFeedbackTimer=setTimeout(()=>{btn.classList.remove('copied');tip.textContent=T.copy},1800)}
  function syncFallbackLink(){const link=document.getElementById('fallbackLink');if(!link)return;link.classList.toggle('hide',!(tunnelActive&&tunnelProvider==='cloudflare'&&!phoneConnected&&!modeSwitching))}
  function syncModeControls(connected){phoneConnected=connected;const disabled=connected||modeSwitching;document.getElementById('btnLan').disabled=disabled;document.getElementById('btnTunnel').disabled=disabled;syncFallbackLink()}
  function syncModeSelection(active){document.getElementById('btnLan').classList.toggle('active',!active);document.getElementById('btnTunnel').classList.toggle('active',active)}
  function syncTunnelError(){const el=document.getElementById('tunnelError');el.classList.toggle('show',selectedTunnelTab&&!!el.textContent)}
  function setTunnelProgress(value){const progress=Math.max(0,Math.min(100,Math.round(value)));document.getElementById('tunnelProgressBar').style.width=progress+'%';document.getElementById('tunnelProgressValue').textContent=progress+'%'}
  function startTunnelProgress(enableTunnel){const loading=document.getElementById('qrLoading'),duration=enableTunnel?4500:800;clearInterval(tunnelProgressTimer);tunnelProgressStartedAt=Date.now();document.getElementById('tunnelLoadingText').textContent=enableTunnel?T.tunnelLoading:T.lanLoading;setTunnelProgress(0);loading.classList.add('show');tunnelProgressTimer=setInterval(()=>{setTunnelProgress(Math.min(99,(Date.now()-tunnelProgressStartedAt)/duration*100))},50);return duration}
  async function finishTunnelProgress(completed,duration){const loading=document.getElementById('qrLoading');if(completed){const remaining=Math.max(0,duration-(Date.now()-tunnelProgressStartedAt));if(remaining)await new Promise(resolve=>setTimeout(resolve,remaining));setTunnelProgress(100);await new Promise(resolve=>setTimeout(resolve,180))}clearInterval(tunnelProgressTimer);tunnelProgressTimer=null;loading.classList.remove('show');setTunnelProgress(0)}
  async function switchMode(enableTunnel){if(phoneConnected||modeSwitching)return;if(selectedTunnelTab===enableTunnel&&tunnelActive===enableTunnel)return;const previous=tunnelActive;const previousProvider=tunnelProvider;let completed=false;modeSwitching=true;selectedTunnelTab=enableTunnel;syncModeControls(phoneConnected);syncModeSelection(enableTunnel);document.getElementById('modeHint').textContent=enableTunnel?T.tunnelHint:T.lanHint;syncTunnelError();const progressDuration=startTunnelProgress(enableTunnel);try{const r=await fetch('/desktop/tunnel/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enable:enableTunnel})});const j=await r.json();if(j.ok){tunnelActive=j.active;tunnelProvider=j.provider||null;pairingUrl=j.pairingUrl;document.getElementById('url').textContent=pairingUrl;if(j.qrSvg)document.getElementById('qrCode').innerHTML=j.qrSvg;selectedTunnelTab=enableTunnel;syncModeSelection(enableTunnel);document.getElementById('modeHint').textContent=enableTunnel?T.tunnelHint:T.lanHint;if(j.active)document.getElementById('tunnelError').textContent='';syncTunnelError();if(j.expiresAt)end=j.expiresAt;completed=true}else{throw new Error(j.error||'Tunnel failed')}}catch(e){tunnelActive=previous;tunnelProvider=previousProvider;syncModeSelection(selectedTunnelTab);document.getElementById('modeHint').textContent=selectedTunnelTab?T.tunnelHint:T.lanHint;document.getElementById('tunnelError').textContent=T.tunnelError+(e.message||e);syncTunnelError()}finally{await finishTunnelProgress(completed,progressDuration);modeSwitching=false;syncModeControls(phoneConnected)}}
  async function switchFallback(){if(phoneConnected||modeSwitching||!tunnelActive||tunnelProvider!=='cloudflare')return;let completed=false;modeSwitching=true;syncModeControls(phoneConnected);const progressDuration=startTunnelProgress(true);document.getElementById('tunnelLoadingText').textContent=T.fallbackLoading;try{const r=await fetch('/desktop/tunnel/fallback',{method:'POST'});const j=await r.json();if(j.ok){tunnelActive=j.active;tunnelProvider=j.provider||null;selectedTunnelTab=true;pairingUrl=j.pairingUrl;document.getElementById('url').textContent=pairingUrl;if(j.qrSvg)document.getElementById('qrCode').innerHTML=j.qrSvg;document.getElementById('tunnelError').textContent='';syncTunnelError();if(j.expiresAt)end=j.expiresAt;completed=true}else{throw new Error(j.error||'Tunnel failed')}}catch(e){document.getElementById('tunnelError').textContent=T.tunnelError+(e.message||e);syncTunnelError()}finally{await finishTunnelProgress(completed,progressDuration);modeSwitching=false;syncModeControls(phoneConnected)}}
  async function poll(){const [pending,status]=await Promise.all([fetch('/desktop/pending'),fetch('/desktop/status')]);if(pending.ok){const j=await pending.json();pendingId=j.id||null;document.getElementById('requestMode').textContent=pendingId?(j.mode==='tunnel'?T.requestTunnel:T.requestLan):'';document.getElementById('address').textContent=j.remoteAddress?T.deviceAddress+j.remoteAddress:'';document.getElementById('request').classList.toggle('show',!!pendingId);document.body.classList.toggle('has-request',!!pendingId)}if(status.ok){const j=await status.json();const connected=!!j.connected;document.getElementById('connection').classList.toggle('show',connected);document.body.classList.toggle('phone-connected',connected);syncModeControls(connected)}}
  async function disconnectPhone(){await fetch('/desktop/disconnect',{method:'POST'});location.reload()}
  async function decide(approved){if(!pendingId)return;await fetch('/desktop/decide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:pendingId,approved})});pendingId=null;poll()}
  setInterval(()=>{const n=Math.max(0,Math.ceil((end-Date.now())/1000));document.getElementById('expires').textContent=n?T.refresh+n+T.seconds:T.expired;if(!n&&!phoneConnected&&!pendingId&&!modeSwitching)location.reload()},1000);
  setInterval(poll,800);poll()</script></body></html>`;
}
function renderPairingWaitPage(pairingId, locale) {
  const zh = locale === "zh";
  const text = {
    title: zh ? "\u8FDE\u63A5 DSH" : "Pairing DSH",
    heading: zh ? "\u6279\u51C6\u6B64\u624B\u673A" : "Approve this phone",
    hint: zh ? "\u8BF7\u5728 DSH Desktop \u4E2D\u786E\u8BA4\u8FDE\u63A5\u8BF7\u6C42\u3002" : "Confirm the connection request in DSH Desktop.",
    waiting: zh ? "\u6B63\u5728\u7B49\u5F85\u6279\u51C6\u2026" : "Waiting for approval\u2026",
    connected: zh ? "\u8FDE\u63A5\u6210\u529F\uFF0C\u6B63\u5728\u6253\u5F00 DSH\u2026" : "Connected. Opening DSH\u2026",
    declined: zh ? "\u8FDE\u63A5\u7533\u8BF7\u5DF2\u88AB\u62D2\u7EDD\u3002" : "The connection request was declined.",
    expired: zh ? "\u672C\u6B21\u8FDE\u63A5\u7533\u8BF7\u5DF2\u8FC7\u671F\u3002" : "This connection request expired.",
    unavailable: zh ? "\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u684C\u9762\u7AEF\uFF0C\u8BF7\u5148\u542F\u52A8 DSH Desktop\u3002" : "Cannot reach the desktop. Start DSH Desktop and try again.",
    retry: zh ? "\u518D\u6B21\u53D1\u8D77\u7533\u8BF7" : "Request approval again",
    retrying: zh ? "\u6B63\u5728\u91CD\u65B0\u53D1\u8D77\u7533\u8BF7\u2026" : "Requesting approval again\u2026"
  };
  return `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)"><title>${text.title}</title><style>:root{color-scheme:light;--bg:#fff;--card:#fff;--panel:#f7f8fa;--ink:#18191c;--muted:#81858c;--line:#e5e7eb;--brand:#4d6bfe}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#141416;--card:#1d1d20;--panel:#202023;--ink:#f5f5f6;--muted:#95979d;--line:#303034;--brand:#6f86ff}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}.card{width:100%;max-width:340px;text-align:center}.logo{width:54px;height:54px;display:grid;place-items:center;margin:0 auto 22px;border:1px solid var(--line);border-radius:16px;background:var(--card)}.logo img{width:39px;height:22px;object-fit:contain}.logo .dark-logo{display:none}@media(prefers-color-scheme:dark){.logo .light-logo{display:none}.logo .dark-logo{display:block}}h1{font-size:24px;line-height:1.25;font-weight:600;margin:0 0 8px}p{margin:0;color:var(--muted)}.waiting{display:flex;justify-content:center;gap:6px;margin:24px 0}.waiting i{width:7px;height:7px;border-radius:50%;background:var(--brand);animation:p 1s infinite alternate}.waiting i:nth-child(2){animation-delay:.2s}.waiting i:nth-child(3){animation-delay:.4s}.waiting.stopped i{animation:none;background:var(--muted)}@keyframes p{to{opacity:.2;transform:translateY(-3px)}}.note{margin-top:20px;padding:11px 13px;border-radius:10px;background:var(--panel);font-size:13px}.retry{display:none;width:100%;height:44px;margin-top:12px;border:1px solid var(--ink);border-radius:12px;background:var(--ink);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}.retry.show{display:block}.retry:disabled{opacity:.55;cursor:default}</style></head><body><div class="card"><div class="logo"><img class="light-logo" src="/brand-logo/light" alt="DSH"><img class="dark-logo" src="/brand-logo/dark" alt="DSH"></div><h1>${text.heading}</h1><p>${text.hint}</p><div id="waiting" class="waiting"><i></i><i></i><i></i></div><div id="status" class="note">${text.waiting}</div><button id="retry" class="retry" onclick="retryPairing()">${text.retry}</button></div><script>let id=${JSON.stringify(pairingId)},timer;const T=${JSON.stringify(text)},status=document.getElementById('status'),retry=document.getElementById('retry'),waiting=document.getElementById('waiting');function showWaiting(){status.textContent=T.waiting;retry.classList.remove('show');waiting.classList.remove('stopped')}function showRetry(message,stop=true){status.textContent=message;retry.classList.add('show');waiting.classList.add('stopped');if(stop)clearInterval(timer)}async function poll(){try{const r=await fetch('/pair/status?id='+encodeURIComponent(id),{cache:'no-store'});if(!r.ok)throw new Error();const j=await r.json();if(j.approved){clearInterval(timer);status.textContent=T.connected;retry.classList.remove('show');location.replace('/')}else if(j.denied||j.expired){showRetry(j.denied?T.declined:T.expired)}else{showWaiting()}}catch{showRetry(T.unavailable,false)}}function startPolling(){clearInterval(timer);poll();timer=setInterval(poll,900)}async function retryPairing(){retry.disabled=true;status.textContent=T.retrying;try{const r=await fetch('/pair/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!r.ok)throw new Error();const j=await r.json();if(j.redirectUrl){location.replace(j.redirectUrl);return}if(!j.id)throw new Error();id=j.id;retry.disabled=false;showWaiting();startPolling()}catch{retry.disabled=false;showRetry(T.unavailable)}}startPolling()</script></body></html>`;
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return replacements[character];
  });
}

// src/main/mobile/lan-mobile-bridge.ts
var MAX_BODY_BYTES = 64 * 1024;
var PAIRING_TTL_MS = 5 * 60 * 1e3;
var MUX_RECONNECT_MS = 500;
var MUX_RECONNECT_CAP_MS = 3e4;
var REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
var REMOTE_EVENT_STREAM_ENDPOINT = "$events";
var REMOTE_EVENT_RESULT_ENDPOINT = "$events/result";
var USER_QUESTION_EVENT = "user-questions/request";
var EVENT_STREAM_ID = "mobile-events";
var WORKSPACE_STREAM_ID = "mobile-workspaces";
var MUX_STABLE_MS = 5e3;
var HARNESS_ENDPOINTS = {
  "agentPreset.list": { endpoint: "agentPresets/list", args: () => ({}) },
  // The preset selector is keyed by agent id, which for a top-level session is
  // the session id the mobile page already sends.
  "agentPreset.select": {
    endpoint: "agentPresets/select",
    args: (payload) => ({ agentId: payload.sessionId, agentPreset: payload.agentPreset })
  },
  "session.list": { endpoint: "session/list", args: () => ({ _request: {} }) },
  // The catalog is no longer per-session: it describes what the Host can route
  // to, so it takes no arguments and the page's sessionId is dropped.
  "session.models": { endpoint: "session/modelCatalog", args: () => ({}) },
  "session.selectModel": {
    endpoint: "session/selectModel",
    args: (payload) => ({ request: payload })
  },
  "session.create": { endpoint: "session/create", args: (payload) => ({ request: payload }) },
  "session.prompt": {
    endpoint: "session/prompt",
    args: (payload) => ({ request: { requestId: randomUUID(), ...payload } })
  },
  "session.cancel": { endpoint: "session/cancel", args: (payload) => ({ request: payload }) }
};
var RPC_ALLOWLIST = /* @__PURE__ */ new Set([...Object.keys(HARNESS_ENDPOINTS), "session.history", "workspace.list"]);
var LanMobileBridge = class {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }
  server;
  port;
  pairingToken;
  pairingExpiresAt;
  tunnelInstance;
  tunnelActive = false;
  tunnelLoading = false;
  tunnelError;
  tunnelLaunch;
  sessions = /* @__PURE__ */ new Map();
  suspendedSessions = /* @__PURE__ */ new Map();
  pendingPairings = /* @__PURE__ */ new Map();
  pendingQuestions = /* @__PURE__ */ new Map();
  /** Client generation id from the event stream's `ready` frame; results quote it. */
  eventClientId;
  /** Latest `workspace/follow` baseline, standing in for the removed unary list. */
  workspaceSnapshot;
  now;
  muxAbort;
  muxTask;
  sessionStreamAborts = /* @__PURE__ */ new Set();
  lastConnected = false;
  async start() {
    if (this.server) {
      if (!this.pairingTokenValid()) {
        this.rotatePairingToken();
      }
      this.syncConnected();
      return this.snapshot();
    }
    this.rotatePairingToken();
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.json(response, 500, { ok: false, error: message });
      }).finally(() => this.syncConnected());
    });
    await new Promise((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port ?? 0, "0.0.0.0", resolve);
    });
    this.port = this.server.address().port;
    this.syncConnected();
    return this.snapshot();
  }
  async stop() {
    const server = this.server;
    this.server = void 0;
    this.port = void 0;
    this.pairingToken = void 0;
    this.pairingExpiresAt = void 0;
    if (this.tunnelLaunch) {
      await this.tunnelLaunch.catch(() => void 0);
      this.tunnelLaunch = void 0;
    }
    if (this.tunnelInstance) {
      await this.tunnelInstance.stop().catch(() => void 0);
      this.tunnelInstance = void 0;
    }
    this.tunnelActive = false;
    this.tunnelLoading = false;
    this.tunnelError = void 0;
    this.sessions.clear();
    this.suspendedSessions.clear();
    this.pendingPairings.clear();
    this.pendingQuestions.clear();
    for (const abort of this.sessionStreamAborts) abort.abort();
    this.sessionStreamAborts.clear();
    this.syncConnected();
    this.muxAbort?.abort();
    const muxTask = this.muxTask;
    this.muxAbort = void 0;
    this.muxTask = void 0;
    if (muxTask) await muxTask.catch(() => void 0);
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  async toggleTunnel(enable) {
    const targetState = enable !== void 0 ? enable : !this.tunnelActive;
    if (!targetState) {
      if (this.tunnelLaunch) {
        await this.tunnelLaunch.catch(() => void 0);
        this.tunnelLaunch = void 0;
      }
      if (this.tunnelInstance) {
        await this.tunnelInstance.stop().catch(() => void 0);
        this.tunnelInstance = void 0;
      }
      this.tunnelActive = false;
      this.tunnelLoading = false;
      this.tunnelError = void 0;
      return this.snapshot();
    }
    if (this.tunnelActive && this.tunnelInstance?.url) {
      return this.snapshot();
    }
    if (this.tunnelLaunch) {
      return this.snapshot();
    }
    this.tunnelLoading = true;
    this.tunnelError = void 0;
    const launch = this.launchTunnel();
    this.tunnelLaunch = launch;
    try {
      await launch;
      this.tunnelActive = true;
    } catch (error) {
      this.tunnelActive = false;
      this.tunnelError = error instanceof Error ? error.message : String(error);
    } finally {
      this.tunnelLoading = false;
      if (this.tunnelLaunch === launch) this.tunnelLaunch = void 0;
    }
    return this.snapshot();
  }
  async fallbackToPinggy() {
    if (this.sessions.size > 0) {
      throw new Error("Disconnect the phone before switching connection modes.");
    }
    if (!this.tunnelActive || this.tunnelInstance?.provider !== "cloudflare") {
      throw new Error("Fallback is only available for an active Cloudflare tunnel.");
    }
    if (this.tunnelLaunch) {
      throw new Error("A tunnel switch is already in progress.");
    }
    this.tunnelLoading = true;
    this.tunnelError = void 0;
    const launch = this.swapToPinggy();
    this.tunnelLaunch = launch;
    try {
      await launch;
    } catch (error) {
      this.tunnelError = error instanceof Error ? error.message : String(error);
    } finally {
      this.tunnelLoading = false;
      if (this.tunnelLaunch === launch) this.tunnelLaunch = void 0;
    }
    return this.snapshot();
  }
  async launchTunnel() {
    const port2 = this.port;
    if (!port2) throw new Error("Bridge is not running.");
    this.tunnelInstance = await startTunnelWithFallback({
      forceCloudflareFailure: this.options.forceCloudflareFailure,
      startCloudflare: () => this.startCloudflareInstance(port2),
      startPinggy: () => this.startPinggyInstance(port2),
      log: this.options.tunnelLog
    });
  }
  async swapToPinggy() {
    const port2 = this.port;
    if (!port2) throw new Error("Bridge is not running.");
    const pinggy = await this.startPinggyInstance(port2);
    const previous = this.tunnelInstance;
    this.tunnelInstance = pinggy;
    this.tunnelActive = true;
    this.tunnelError = void 0;
    if (previous) await previous.stop().catch(() => void 0);
  }
  async startCloudflareInstance(port2) {
    if (this.options.createCloudflareTunnel) return this.options.createCloudflareTunnel(port2);
    const cacheDir = this.tunnelCacheDir();
    const binaryPath = await ensureCloudflaredBinary({
      cacheDir,
      customPath: this.options.cloudflaredPath
    });
    return startCloudflareQuickTunnel({
      port: port2,
      binaryPath,
      log: this.options.tunnelLog
    });
  }
  async startPinggyInstance(port2) {
    if (this.options.createPinggyTunnel) return this.options.createPinggyTunnel(port2);
    const cacheDir = this.tunnelCacheDir();
    return startPinggyTunnel({
      port: port2,
      sshPath: this.options.pinggySshPath,
      knownHostsPath: join3(cacheDir, "pinggy-known-hosts"),
      log: this.options.tunnelLog
    });
  }
  tunnelCacheDir() {
    return this.options.cloudflaredCacheDir ?? join3(tmpdir(), "dsh-cloudflared");
  }
  snapshot() {
    if (!this.server || !this.port) {
      return { running: false, connected: this.sessions.size > 0 };
    }
    const tokenValid = this.pairingTokenValid();
    const address = preferredLanAddress();
    const pairingUrl = !tokenValid ? void 0 : this.tunnelActive && this.tunnelInstance?.url ? `${this.tunnelInstance.url}/pair?token=${this.pairingToken}` : address ? `http://${address}:${this.port}/pair?token=${this.pairingToken}` : void 0;
    return {
      running: true,
      connected: this.sessions.size > 0,
      port: this.port,
      ...tokenValid && pairingUrl ? { pairingUrl, expiresAt: this.pairingExpiresAt } : {},
      desktopUrl: `http://127.0.0.1:${this.port}/desktop`,
      tunnelActive: this.tunnelActive,
      tunnelLoading: this.tunnelLoading,
      tunnelUrl: this.tunnelInstance?.url,
      tunnelProvider: this.tunnelInstance?.provider,
      tunnelError: this.tunnelError
    };
  }
  rotatePairingToken() {
    this.pairingToken = randomBytes(32).toString("base64url");
    this.pairingExpiresAt = this.now() + PAIRING_TTL_MS;
  }
  pairingTokenValid() {
    return Boolean(this.pairingToken && this.pairingExpiresAt && this.pairingExpiresAt >= this.now());
  }
  async handle(request, response) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    );
    const transportAddress = normalizeRemoteAddress(request.socket.remoteAddress ?? "");
    if (!isPrivateAddress(transportAddress)) return this.text(response, 403, "Private network only.");
    const connectionMode = this.requestConnectionMode(request, transportAddress);
    const forwardedAddress = firstHeaderValue(request.headers["cf-connecting-ip"]) ?? firstHeaderValue(request.headers["x-forwarded-for"]);
    const remoteAddress = connectionMode === "tunnel" && forwardedAddress ? normalizeRemoteAddress(forwardedAddress) : transportAddress;
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname.startsWith("/brand-logo/")) {
      const variant = url.pathname === "/brand-logo/dark" ? "dark" : "light";
      const path = this.options.brandLogoPaths?.[variant];
      if (!path) return this.text(response, 404, "Brand asset not found.");
      try {
        const body = await readFile(path);
        response.statusCode = 200;
        response.setHeader("content-type", "image/png");
        response.setHeader("cache-control", "public, max-age=3600");
        response.end(body);
      } catch {
        this.text(response, 404, "Brand asset not found.");
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/app-icon") {
      const path = this.options.appIconPath;
      if (!path) return this.text(response, 404, "App icon not found.");
      try {
        const body = await readFile(path);
        response.statusCode = 200;
        response.setHeader("content-type", "image/png");
        response.setHeader("cache-control", "public, max-age=86400");
        response.end(body);
      } catch {
        this.text(response, 404, "App icon not found.");
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/desktop") {
      if (!isLoopbackAddress(remoteAddress)) return this.text(response, 403, "Desktop only.");
      this.verifyTrustedOrigin(request);
      if (!this.server || !this.port) return this.text(response, 503, "Bridge unavailable.");
      if (!this.pairingTokenValid()) {
        this.rotatePairingToken();
      }
      const snapshot = this.snapshot();
      if (!snapshot.pairingUrl || !snapshot.expiresAt) return this.text(response, 503, "Bridge unavailable.");
      const qrSvg = await QRCode.toString(snapshot.pairingUrl, { type: "svg", margin: 1, width: 260 });
      return this.html(
        response,
        renderDesktopPairingPage({
          qrSvg,
          pairingUrl: snapshot.pairingUrl,
          expiresAt: snapshot.expiresAt,
          locale: this.locale(),
          connected: this.sessions.size > 0,
          tunnelActive: snapshot.tunnelActive,
          tunnelLoading: snapshot.tunnelLoading,
          tunnelProvider: snapshot.tunnelProvider,
          tunnelUrl: snapshot.tunnelUrl,
          tunnelError: snapshot.tunnelError
        })
      );
    }
    if (request.method === "GET" && url.pathname === "/desktop/pending") {
      if (!isLoopbackAddress(remoteAddress)) return this.text(response, 403, "Desktop only.");
      const pending = [...this.pendingPairings.values()].find(
        (item) => item.decision === void 0 && item.expiresAt >= this.now()
      );
      return this.json(
        response,
        200,
        pending ? { id: pending.id, remoteAddress: pending.remoteAddress, mode: pending.mode } : {}
      );
    }
    if (request.method === "GET" && url.pathname === "/desktop/status") {
      if (!isLoopbackAddress(remoteAddress)) return this.text(response, 403, "Desktop only.");
      return this.json(response, 200, { connected: this.sessions.size > 0 });
    }
    if (request.method === "GET" && url.pathname === "/desktop/tunnel/status") {
      if (!isLoopbackAddress(remoteAddress)) return this.text(response, 403, "Desktop only.");
      const snapshot = this.snapshot();
      const qrSvg = snapshot.pairingUrl ? await QRCode.toString(snapshot.pairingUrl, { type: "svg", margin: 1, width: 260 }) : void 0;
      return this.json(response, 200, {
        active: snapshot.tunnelActive,
        loading: snapshot.tunnelLoading,
        url: snapshot.tunnelUrl,
        provider: snapshot.tunnelProvider,
        error: snapshot.tunnelError,
        pairingUrl: snapshot.pairingUrl,
        qrSvg,
        expiresAt: snapshot.expiresAt
      });
    }
    if (request.method === "POST" && url.pathname === "/desktop/tunnel/fallback") {
      if (!isLoopbackAddress(remoteAddress)) return this.text(response, 403, "Desktop only.");
      this.verifySameOrigin(request);
      if (this.sessions.size > 0) {
        return this.json(response, 409, {
          ok: false,
          error: "Disconnect the phone before switching connection modes."
        });
      }
      if (this.tunnelLoading || this.tunnelLaunch) {
        return this.json(response, 409, {
          ok: false,
          error: "A tunnel switch is already in progress."
        });
      }
      if (!this.tunnelActive || this.tunnelInstance?.provider !== "cloudflare") {
        return this.json(response, 400, {
          ok: false,
          error: "Fallback is only available for an active Cloudflare tunnel."
        });
      }
      const snapshot = await this.fallbackToPinggy();
      const qrSvg = snapshot.pairingUrl ? await QRCode.toString(snapshot.pairingUrl, { type: "svg", margin: 1, width: 260 }) : void 0;
      return this.json(response, 200, {
        ok: !snapshot.tunnelError,
        active: snapshot.tunnelActive,
        loading: snapshot.tunnelLoading,
        url: snapshot.tunnelUrl,
        provider: snapshot.tunnelProvider,
        error: snapshot.tunnelError,
        pairingUrl: snapshot.pairingUrl,
        qrSvg,
        expiresAt: snapshot.expiresAt
      });
    }
    if (request.method === "POST" && url.pathname === "/desktop/tunnel/toggle") {
      if (!isLoopbackAddress(remoteAddress)) return this.text(response, 403, "Desktop only.");
      this.verifySameOrigin(request);
      if (this.sessions.size > 0) {
        return this.json(response, 409, {
          ok: false,
          error: "Disconnect the phone before switching connection modes."
        });
      }
      let enable;
      try {
        const bodyText = await readBody(request);
        if (bodyText) {
          const parsed = JSON.parse(bodyText);
          if (typeof parsed.enable === "boolean") enable = parsed.enable;
        }
      } catch {
      }
      if (enable === true && this.tunnelLoading && !this.tunnelActive) {
        return this.json(response, 409, {
          ok: false,
          error: "A tunnel switch is already in progress."
        });
      }
      const snapshot = await this.toggleTunnel(enable);
      const qrSvg = snapshot.pairingUrl ? await QRCode.toString(snapshot.pairingUrl, { type: "svg", margin: 1, width: 260 }) : void 0;
      return this.json(response, 200, {
        ok: !snapshot.tunnelError,
        active: snapshot.tunnelActive,
        loading: snapshot.tunnelLoading,
        url: snapshot.tunnelUrl,
        provider: snapshot.tunnelProvider,
        error: snapshot.tunnelError,
        pairingUrl: snapshot.pairingUrl,
        qrSvg,
        expiresAt: snapshot.expiresAt
      });
    }
    if (request.method === "POST" && url.pathname === "/desktop/disconnect") {
      if (!isLoopbackAddress(remoteAddress)) return this.text(response, 403, "Desktop only.");
      this.verifySameOrigin(request);
      for (const [token, session] of this.sessions) this.suspendedSessions.set(token, session);
      this.sessions.clear();
      this.pendingPairings.clear();
      this.rotatePairingToken();
      return this.json(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/desktop/decide") {
      if (!isLoopbackAddress(remoteAddress)) return this.text(response, 403, "Desktop only.");
      this.verifySameOrigin(request);
      const input = JSON.parse(await readBody(request));
      const pending = typeof input.id === "string" ? this.pendingPairings.get(input.id) : void 0;
      if (!pending || typeof input.approved !== "boolean") return this.text(response, 404, "Pairing request not found.");
      pending.decision = input.approved;
      return this.json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/disconnected") {
      const migrationUrl = this.tunnelMigrationUrl(url, connectionMode);
      if (migrationUrl) return this.redirect(response, migrationUrl);
      return this.html(response, renderMobileReconnectPage(this.locale(), connectionMode));
    }
    if (request.method === "GET" && url.pathname === "/reconnect") {
      const migrationUrl = this.tunnelMigrationUrl(url, connectionMode);
      if (migrationUrl) return this.redirect(response, migrationUrl);
      const pending = this.reconnectPairing(remoteAddress, connectionMode);
      this.options.onReconnectRequested?.();
      return this.html(response, renderPairingWaitPage(pending.id, this.locale()));
    }
    if (request.method === "POST" && url.pathname === "/pair/retry") {
      this.verifySameOrigin(request);
      const migrationUrl = this.tunnelMigrationUrl(new URL("/reconnect", url), connectionMode);
      if (migrationUrl) return this.json(response, 200, { redirectUrl: migrationUrl });
      const pending = this.reconnectPairing(remoteAddress, connectionMode);
      this.options.onReconnectRequested?.();
      return this.json(response, 200, { id: pending.id, expiresAt: pending.expiresAt });
    }
    if (request.method === "GET" && url.pathname === "/pair") {
      const migrationUrl = this.tunnelMigrationUrl(url, connectionMode);
      if (migrationUrl) return this.redirect(response, migrationUrl);
      if (this.authorized(request, remoteAddress)) {
        response.statusCode = 302;
        response.setHeader("location", "/");
        response.end();
        return;
      }
      if (!this.validPairingToken(url.searchParams.get("token"))) {
        return this.text(response, 401, "This pairing link is invalid or expired.");
      }
      const id = randomUUID();
      this.pendingPairings.set(id, {
        id,
        remoteAddress,
        mode: connectionMode,
        expiresAt: this.pairingExpiresAt
      });
      return this.html(response, renderPairingWaitPage(id, this.locale()));
    }
    if (request.method === "GET" && url.pathname === "/pair/status") {
      const id = url.searchParams.get("id");
      const pending = id ? this.pendingPairings.get(id) : void 0;
      if (!pending) return this.json(response, 200, { expired: true });
      if (pending.expiresAt < this.now()) {
        this.pendingPairings.delete(pending.id);
        return this.json(response, 200, { expired: true });
      }
      if (pending.decision === false) {
        this.pendingPairings.delete(pending.id);
        return this.json(response, 200, { denied: true });
      }
      if (pending.decision !== true) return this.json(response, 200, { pending: true });
      const token = randomBytes(32).toString("base64url");
      for (const [savedToken, session] of this.suspendedSessions) {
        if (session.remoteAddress !== pending.remoteAddress) continue;
        this.sessions.set(savedToken, session);
        this.suspendedSessions.delete(savedToken);
      }
      this.sessions.set(token, { token, remoteAddress: pending.remoteAddress });
      this.pendingPairings.delete(pending.id);
      this.pairingToken = void 0;
      this.pairingExpiresAt = void 0;
      response.setHeader("set-cookie", `dsh_mobile=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      return this.json(response, 200, { approved: true });
    }
    if (!this.authorized(request, remoteAddress)) {
      this.rememberMobileContext(request, remoteAddress);
      if (!this.authorized(request, remoteAddress)) {
        if (request.method === "GET" && url.pathname === "/") {
          const migrationUrl = this.tunnelMigrationUrl(url, connectionMode);
          if (migrationUrl) return this.redirect(response, migrationUrl);
          return this.html(response, renderMobileReconnectPage(this.locale(), connectionMode));
        }
        return this.text(response, 401, "Pair your phone again.");
      }
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return this.json(response, 200, { connected: true });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return this.html(response, renderMobilePage({ locale: this.locale() }));
    }
    if (request.method === "GET" && url.pathname === "/api/session/stream") {
      this.verifyTrustedOrigin(request);
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return this.text(response, 400, "Session id is required.");
      return this.streamSession(request, response, sessionId);
    }
    if (request.method === "POST" && url.pathname === "/api/rpc") {
      this.verifySameOrigin(request);
      const input = JSON.parse(await readBody(request));
      if (input.method === "interaction.pending") {
        const sessionId = requiredStringField(input.payload, "sessionId");
        const pending = [...this.pendingQuestions.values()].find(
          (item) => item.sessionId === sessionId
        );
        return this.json(response, 200, { ok: true, value: pending ?? null });
      }
      if (input.method === "interaction.answer") {
        const answer = parseQuestionResponse(input.payload);
        const pending = this.assertPendingQuestion(answer.rpcId, answer.sessionId);
        validateQuestionAnswers(pending, answer.answers);
        const result2 = await this.respondToQuestion(answer.rpcId, {
          kind: "result",
          value: { answers: answer.answers }
        });
        return this.json(response, result2.ok ? 200 : 400, result2);
      }
      if (input.method === "interaction.cancel") {
        const rpcId = requiredStringField(input.payload, "rpcId");
        const sessionId = requiredStringField(input.payload, "sessionId");
        this.assertPendingQuestion(rpcId, sessionId);
        const result2 = await this.respondToQuestion(rpcId, {
          kind: "rejected",
          error: {
            name: "Error",
            message: "the user closed this question request",
            code: "cancelled"
          }
        });
        return this.json(response, result2.ok ? 200 : 400, result2);
      }
      if (typeof input.method !== "string" || !RPC_ALLOWLIST.has(input.method)) {
        return this.json(response, 403, { ok: false, error: "RPC method is not available on mobile." });
      }
      const result = await this.forwardRpc(input.method, input.payload ?? {});
      return this.json(response, result.ok ? 200 : 400, result);
    }
    this.text(response, 404, "Not found.");
  }
  locale() {
    const value = this.options.locale;
    return typeof value === "function" ? value() : value ?? "en";
  }
  validPairingToken(candidate) {
    if (!candidate || !this.pairingToken || !this.pairingExpiresAt) return false;
    if (this.now() > this.pairingExpiresAt) return false;
    const left = Buffer.from(candidate);
    const right = Buffer.from(this.pairingToken);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  reconnectPairing(remoteAddress, mode) {
    const current = [...this.pendingPairings.values()].find(
      (item) => item.remoteAddress === remoteAddress && item.mode === mode && item.decision === void 0 && item.expiresAt >= this.now()
    );
    if (current) return current;
    const pending = {
      id: randomUUID(),
      remoteAddress,
      mode,
      expiresAt: this.now() + PAIRING_TTL_MS
    };
    this.pendingPairings.set(pending.id, pending);
    return pending;
  }
  authorized(request, remoteAddress) {
    const token = this.mobileToken(request);
    if (token && this.sessions.has(token)) return true;
    return [...this.sessions.values()].some((session) => session.remoteAddress === remoteAddress);
  }
  mobileToken(request) {
    const cookie = request.headers.cookie ?? "";
    return /(?:^|;\s*)dsh_mobile=([^;]+)/.exec(cookie)?.[1];
  }
  rememberMobileContext(request, remoteAddress) {
    const token = this.mobileToken(request);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const sameDeviceIsActive = [...this.sessions.values()].some(
      (session) => session.remoteAddress === remoteAddress
    );
    if (sameDeviceIsActive) {
      this.sessions.set(token, { token, remoteAddress });
      this.suspendedSessions.delete(token);
      return;
    }
    if (!this.suspendedSessions.has(token) && this.suspendedSessions.size >= 16) {
      const oldest = this.suspendedSessions.keys().next().value;
      if (oldest) this.suspendedSessions.delete(oldest);
    }
    this.suspendedSessions.set(token, { token, remoteAddress });
  }
  verifySameOrigin(request) {
    this.verifyTrustedOrigin(request);
  }
  /**
   * Rejects browser-driven cross-site requests (CSRF / drive-by) against the
   * loopback-only desktop surface. The pairing window's own navigations and
   * same-origin fetches pass; requests without Fetch Metadata and Origin
   * headers (local tooling, tests) pass as well.
   */
  verifyTrustedOrigin(request) {
    const site = firstHeaderValue(request.headers["sec-fetch-site"]);
    if (site && site !== "same-origin" && site !== "none") {
      throw new Error("Cross-site request rejected.");
    }
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin && host && new URL(origin).host !== host) throw new Error("Cross-origin request rejected.");
  }
  requestConnectionMode(request, transportAddress) {
    if (!isLoopbackAddress(transportAddress)) return "lan";
    const host = (request.headers.host ?? "").split(":", 1)[0]?.toLowerCase() ?? "";
    const forwardedAddress = firstHeaderValue(request.headers["cf-connecting-ip"]);
    const ray = firstHeaderValue(request.headers["cf-ray"]);
    return isInternetTunnelHost(host) || Boolean(forwardedAddress && ray) ? "tunnel" : "lan";
  }
  tunnelMigrationUrl(url, connectionMode) {
    if (connectionMode === "tunnel" || !this.tunnelActive || !this.tunnelInstance?.url) return void 0;
    return new URL(`${url.pathname}${url.search}`, this.tunnelInstance.url).toString();
  }
  /**
   * The Host session cookie for one Harness base, obtained once and reused.
   *
   * Since 0.1.2-alpha.1 every Host API call is authenticated before dispatch:
   * an unauthenticated caller gets 401, and the launch token is accepted only
   * as `GET /?token=...` on the root — never on an API path and never in an
   * Authorization header. The bridge is a server-side client, not a browser,
   * so it performs that exchange itself.
   *
   * The cookie is signed against the request authority, so every later call
   * has to reach the Host under the same `Host` value the exchange used. That
   * is why the bridge talks to the loopback base rather than forwarding the
   * phone's own authority.
   */
  harnessCookie;
  async harnessSession(base) {
    if (this.harnessCookie?.base === base) return this.harnessCookie.cookie;
    const token = this.options.harnessAuthToken?.();
    if (token === void 0) return void 0;
    const url = new URL("/", base);
    url.searchParams.set("token", token);
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(1e4)
    });
    const cookie = cookiePair(response.headers.getSetCookie());
    if (cookie === void 0) return void 0;
    this.harnessCookie = { base, cookie };
    return cookie;
  }
  /**
   * Call the Host with the session cookie, exchanging the launch token first
   * and once more if the stored cookie has stopped being accepted.
   */
  async harnessFetch(url, init, base) {
    const send = async (cookie) => fetch(url, {
      ...init,
      headers: { ...init.headers, ...cookie === void 0 ? {} : { cookie } }
    });
    let response = await send(await this.harnessSession(base));
    if (response.status === 401) {
      this.harnessCookie = void 0;
      const retry = await this.harnessSession(base);
      if (retry !== void 0) response = await send(retry);
    }
    return response;
  }
  /**
   * Translate one mobile method onto its Host endpoint and drive it.
   *
   * `session.history` is the one call the page cannot express directly: the
   * Host replaced open-ended history reads with a cursor-bounded page, and
   * refuses a `throughSeq` past the session's own cursor. The cursor lives on
   * the session list row, so the read is two calls here rather than a
   * protocol the page has to learn.
   */
  async forwardRpc(method, payload) {
    const fields = typeof payload === "object" && payload !== null ? payload : {};
    if (method === "workspace.list") {
      const snapshot = this.workspaceSnapshot;
      if (snapshot === void 0) return { ok: false, error: "Harness workspaces are not loaded yet." };
      return { ok: true, value: snapshot };
    }
    if (method === "session.history") {
      const sessionId = fields.sessionId;
      const listed = await this.invokeHarness("session/list", { _request: {} });
      if (!listed.ok) return listed;
      const items = listed.value.items ?? [];
      const row = items.find((item) => item.sessionId === sessionId);
      const projections = row?.projections;
      const throughSeq = projections?.asOfSeq;
      if (typeof throughSeq !== "number") return { ok: false, error: "Harness has no cursor for this session." };
      const page = await this.invokeHarness("session/page", {
        request: {
          address: { kind: "session", sessionId },
          throughSeq,
          ...typeof fields.maxMessages === "number" ? { maxMessages: fields.maxMessages } : {}
        }
      });
      if (!page.ok) return page;
      const value = page.value;
      if (!Array.isArray(value?.records)) {
        return { ok: false, error: "Harness returned invalid session history." };
      }
      return {
        ok: true,
        value: {
          events: value.records,
          projections,
          hasMore: value.hasMore === true
        }
      };
    }
    const route = HARNESS_ENDPOINTS[method];
    if (route === void 0) return { ok: false, error: "RPC method is not available on mobile." };
    return this.invokeHarness(route.endpoint, route.args(fields));
  }
  async invokeHarness(endpoint, args2) {
    const base = this.options.harnessUrl();
    if (!base) return { ok: false, error: "Harness is not ready." };
    const rpcId = randomUUID();
    const response = await this.harnessFetch(new URL(`/api/${endpoint}`, base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args: args2 } }),
      signal: AbortSignal.timeout(3e4)
    }, base);
    if (!response.ok) return { ok: false, error: `Harness transport returned HTTP ${response.status}.` };
    const envelope = await response.json();
    if (envelope.rpcId !== rpcId) return { ok: false, error: "Harness RPC response did not match the request." };
    if (envelope.result?.ok !== true) {
      const message = envelope.result?.error?.message;
      return { ok: false, error: typeof message === "string" ? message : "Harness rejected the request." };
    }
    return { ok: true, value: envelope.result.value };
  }
  /**
   * Reconciles everything that depends on a phone being attached. The mux
   * downlink exists purely to track questions raised for a mobile client, so
   * running it with no client meant reconnecting twice a second, forever, on
   * every desktop that never used the feature.
   */
  syncConnected() {
    const connected = this.sessions.size > 0;
    if (connected) this.startMuxMonitor();
    else this.muxAbort?.abort();
    if (connected === this.lastConnected) return;
    this.lastConnected = connected;
    try {
      this.options.onConnectedChange?.(connected);
    } catch {
    }
  }
  startMuxMonitor() {
    if (this.muxTask) return;
    const abort = new AbortController();
    this.muxAbort = abort;
    this.muxTask = this.monitorMux(abort.signal).finally(() => {
      if (this.muxAbort === abort) {
        this.muxAbort = void 0;
        this.muxTask = void 0;
      }
    });
  }
  async monitorMux(signal) {
    let lastBase;
    let backoffMs = MUX_RECONNECT_MS;
    const backOff = async () => {
      await waitFor(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, MUX_RECONNECT_CAP_MS);
    };
    while (!signal.aborted) {
      const base = this.options.harnessUrl();
      if (!base) {
        this.pendingQuestions.clear();
        await backOff();
        continue;
      }
      if (base !== lastBase) {
        this.pendingQuestions.clear();
        lastBase = base;
        backoffMs = MUX_RECONNECT_MS;
      }
      let openedAt;
      try {
        await this.consumeMux(base, signal, () => {
          openedAt = this.now();
        });
        backoffMs = MUX_RECONNECT_MS;
      } catch {
        if (signal.aborted) return;
        this.pendingQuestions.clear();
        if (openedAt !== void 0 && this.now() - openedAt >= MUX_STABLE_MS) {
          backoffMs = MUX_RECONNECT_MS;
        }
        await backOff();
      }
    }
  }
  async consumeMux(base, signal, onOpen) {
    const url = new URL(REMOTE_STREAM_MUX_PATH, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const cookie = await this.harnessSession(base);
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: cookie === void 0 ? {} : { cookie }
      });
      socket.addEventListener("error", () => {
      });
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", handleAbort);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("message", handleMessage);
        socket.removeEventListener("close", handleClose);
        socket.removeEventListener("error", handleError);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
        if (error) reject(error);
        else resolve();
      };
      const handleAbort = () => finish();
      const handleOpen = () => {
        onOpen?.();
        this.pendingQuestions.clear();
        this.eventClientId = void 0;
        socket.send(JSON.stringify({
          type: "open",
          streamId: EVENT_STREAM_ID,
          endpoint: REMOTE_EVENT_STREAM_ENDPOINT,
          payload: { args: {} }
        }));
        socket.send(JSON.stringify({
          type: "open",
          streamId: WORKSPACE_STREAM_ID,
          endpoint: "workspace/follow",
          payload: { args: {} }
        }));
      };
      const handleMessage = (event) => {
        const data = event.data;
        if (typeof data === "string") this.consumeMuxEnvelope(data);
        else if (Buffer.isBuffer(data)) this.consumeMuxEnvelope(data.toString("utf8"));
      };
      const handleClose = () => {
        finish(signal.aborted ? void 0 : new Error("Harness mux WebSocket closed."));
      };
      const handleError = () => finish(new Error("Harness mux WebSocket failed."));
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", handleClose, { once: true });
      socket.addEventListener("error", handleError, { once: true });
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) handleAbort();
    });
  }
  /** Forward one native Harness session/follow stream to an authenticated phone as SSE. */
  async streamSession(request, response, sessionId) {
    const base = this.options.harnessUrl();
    if (!base) return this.text(response, 503, "Harness is not ready.");
    const cookie = await this.harnessSession(base);
    const url = new URL(REMOTE_STREAM_MUX_PATH, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const streamId = `mobile-session-${randomUUID()}`;
    const abort = new AbortController();
    this.sessionStreamAborts.add(abort);
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    response.write("retry: 500\n\n");
    await new Promise((resolve) => {
      const socket = new WebSocket(url, { headers: cookie === void 0 ? {} : { cookie } });
      socket.addEventListener("error", () => {
      });
      let settled = false;
      const cleanup = () => {
        request.removeListener("close", finish);
        abort.signal.removeEventListener("abort", finish);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("message", handleMessage);
        socket.removeEventListener("close", handleClose);
        socket.removeEventListener("error", handleError);
        this.sessionStreamAborts.delete(abort);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
        if (!response.writableEnded) response.end();
        resolve();
      };
      const handleOpen = () => {
        socket.send(JSON.stringify({
          type: "open",
          streamId,
          endpoint: "session/follow",
          payload: {
            args: {
              request: { address: { kind: "session", sessionId }, maxMessages: 100 }
            }
          }
        }));
      };
      const handleMessage = (event) => {
        const text = typeof event.data === "string" ? event.data : Buffer.isBuffer(event.data) ? event.data.toString("utf8") : void 0;
        if (!text) return;
        let frame;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (!isRecord(frame) || frame.streamId !== streamId) return;
        if (frame.type === "item") {
          const value = frame.value;
          const eventName = isRecord(value) && value.type === "snapshot" ? "snapshot" : "event";
          response.write(`event: ${eventName}
data: ${JSON.stringify(value)}

`);
        } else if (frame.type === "error" || frame.type === "end") {
          finish();
        }
      };
      const handleClose = () => finish();
      const handleError = () => finish();
      request.once("close", finish);
      abort.signal.addEventListener("abort", finish, { once: true });
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", handleClose, { once: true });
      socket.addEventListener("error", handleError, { once: true });
      if (abort.signal.aborted) finish();
    });
  }
  /**
   * Consume one carrier frame.
   *
   * Every logical stream shares this socket, so a frame is routed by its
   * `streamId` first. The event stream replaces the old `server-request`
   * envelopes: a question now arrives as a `waterfall` frame carrying its own
   * `eventId`, which is also the id the phone answers with, and the opening
   * `ready` frame names the generation every answer has to quote.
   */
  consumeMuxEnvelope(data) {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(frame) || frame.type !== "item") return;
    const value = frame.value;
    if (frame.streamId === WORKSPACE_STREAM_ID) {
      if (isRecord(value) && value.type === "baseline") this.workspaceSnapshot = value.value;
      return;
    }
    if (frame.streamId !== EVENT_STREAM_ID || !isRecord(value)) return;
    if (value.type === "ready" && typeof value.clientId === "string") {
      this.eventClientId = value.clientId;
      return;
    }
    if (value.type === "waterfall" && value.event === USER_QUESTION_EVENT) {
      const eventId = typeof value.eventId === "string" ? value.eventId : void 0;
      const request = isRecord(value.request) ? value.request : void 0;
      const agentId = typeof value.agentId === "string" ? value.agentId : void 0;
      if (!eventId || !request || !agentId) return;
      const pending = parsePendingQuestion(eventId, { ...request, sessionId: agentId });
      if (pending) this.pendingQuestions.set(eventId, pending);
      return;
    }
    if (value.type === "cancel" && typeof value.eventId === "string") {
      this.pendingQuestions.delete(value.eventId);
    }
  }
  assertPendingQuestion(rpcId, sessionId) {
    const pending = this.pendingQuestions.get(rpcId);
    if (!pending || pending.sessionId !== sessionId) {
      throw new Error("This question request is no longer pending.");
    }
    return pending;
  }
  /**
   * Settle one forwarded question.
   *
   * `/api/respond` went with the ApiProxy. A forwarded event is now settled
   * through the Gateway's own unary endpoint, which pairs the event with the
   * client generation that received it — so an answer sent after a reconnect
   * is refused rather than applied to a stale question.
   */
  async respondToQuestion(eventId, outcome) {
    const clientId = this.eventClientId;
    if (clientId === void 0) return { ok: false, error: "Harness event stream is not connected." };
    const settled = await this.invokeHarness(REMOTE_EVENT_RESULT_ENDPOINT, {
      clientId,
      eventId,
      outcome
    });
    if (settled.ok) this.pendingQuestions.delete(eventId);
    return settled;
  }
  html(response, body) {
    if (response.destroyed) return;
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(body);
  }
  redirect(response, location) {
    response.statusCode = 302;
    response.setHeader("location", location);
    response.end();
  }
  text(response, status, body) {
    if (response.destroyed) return;
    response.statusCode = status;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end(body);
  }
  json(response, status, body) {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.end();
      return;
    }
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }
};
function cookiePair(headers) {
  for (const header of headers) {
    const pair = header.split(";", 1)[0]?.trim();
    if (pair !== void 0 && pair.includes("=")) return pair;
  }
  return void 0;
}
function preferredLanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isPrivateAddress(entry.address)) return entry.address;
    }
  }
  return void 0;
}
function normalizeRemoteAddress(address) {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}
function isLoopbackAddress(address) {
  return address === "::1" || address === "127.0.0.1";
}
function isPrivateAddress(address) {
  if (isLoopbackAddress(address)) return true;
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe8[0-9a-f]:/i.test(address);
}
async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function firstHeaderValue(value) {
  const first = Array.isArray(value) ? value[0] : value?.split(",", 1)[0];
  const normalized = first?.trim();
  return normalized || void 0;
}
function isInternetTunnelHost(host) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return normalized.endsWith(".trycloudflare.com") && normalized !== "api.trycloudflare.com" || normalized.endsWith(".pinggy.link") || normalized.endsWith(".pinggy-free.link") || normalized.endsWith(".pinggy.online");
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredStringField(value, field) {
  if (!isRecord(value) || typeof value[field] !== "string" || !value[field]) {
    throw new Error(`Invalid ${field}.`);
  }
  return value[field];
}
function parsePendingQuestion(rpcId, payload) {
  if (typeof payload.sessionId !== "string" || !Array.isArray(payload.questions)) return void 0;
  const questions = [];
  for (const item of payload.questions.slice(0, 20)) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.question !== "string") continue;
    const question = { id: item.id, question: item.question };
    if (typeof item.detail === "string") question.detail = item.detail;
    if (typeof item.header === "string") question.header = item.header;
    if (typeof item.multiSelect === "boolean") question.multiSelect = item.multiSelect;
    if (typeof item.intent === "string") question.intent = item.intent;
    if (Array.isArray(item.options)) {
      question.options = item.options.slice(0, 50).flatMap((option) => {
        if (!isRecord(option) || typeof option.label !== "string") return [];
        return [{
          label: option.label,
          ...typeof option.description === "string" ? { description: option.description } : {}
        }];
      });
    }
    questions.push(question);
  }
  if (!questions.length) return void 0;
  return { rpcId, sessionId: payload.sessionId, questions };
}
function parseQuestionResponse(value) {
  const rpcId = requiredStringField(value, "rpcId");
  const sessionId = requiredStringField(value, "sessionId");
  if (!isRecord(value) || !Array.isArray(value.answers) || value.answers.length > 20) {
    throw new Error("Invalid question answers.");
  }
  const answers = value.answers.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !Array.isArray(item.selected)) {
      throw new Error("Invalid question answer.");
    }
    const selected = item.selected.map((label) => {
      if (typeof label !== "string") throw new Error("Invalid selected option.");
      return label;
    });
    if (selected.length > 50) throw new Error("Too many selected options.");
    return {
      id: item.id,
      selected,
      ...typeof item.custom === "string" && item.custom.trim() ? { custom: item.custom } : {}
    };
  });
  return { rpcId, sessionId, answers };
}
function validateQuestionAnswers(pending, answers) {
  if (answers.length !== pending.questions.length) throw new Error("Every question needs an answer or skip.");
  const answerById = new Map(answers.map((answer) => [answer.id, answer]));
  if (answerById.size !== answers.length) throw new Error("Duplicate question answer.");
  for (const question of pending.questions) {
    const answer = answerById.get(question.id);
    if (!answer) throw new Error("Every question needs an answer or skip.");
    const allowed = new Set((question.options ?? []).map((option) => option.label));
    if (answer.selected.some((label) => !allowed.has(label))) {
      throw new Error("Answer contains an unknown option.");
    }
    if (!question.multiSelect && answer.selected.length > 1) {
      throw new Error("Only one option can be selected.");
    }
  }
}
function waitFor(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// src/main/mobile/runner.ts
import { join as join4 } from "node:path";
var args = process.argv.slice(2);
var harnessUrl = "http://127.0.0.1:43125";
var harnessAuthToken = "";
var port = 43127;
var userData = process.env.DSH_USER_DATA || join4(process.env.HOME || "", "Library/Application Support/dsh-desktop");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--harness-url") harnessUrl = args[++i];
  if (args[i] === "--token") harnessAuthToken = args[++i];
  if (args[i] === "--port") port = parseInt(args[++i], 10);
  if (args[i] === "--user-data") userData = args[++i];
}
var root = process.cwd();
var bridge = new LanMobileBridge({
  harnessUrl: () => harnessUrl,
  harnessAuthToken: () => harnessAuthToken,
  locale: () => "zh",
  brandLogoPaths: {
    light: join4(root, "build/logo-light.png"),
    dark: join4(root, "build/logo-dark.png")
  },
  appIconPath: join4(root, "build/app-icon.png"),
  cloudflaredCacheDir: join4(userData, "bin"),
  forceCloudflareFailure: false,
  tunnelLog: (msg) => console.log("[mobile-tunnel]", msg),
  port,
  onReconnectRequested: () => {
    console.log("[mobile-bridge] reconnect-requested");
  },
  onConnectedChange: (connected) => {
    console.log("[mobile-bridge] connected:", connected);
  }
});
bridge.start().then((snapshot) => {
  console.log("[mobile-bridge] ready:", snapshot.desktopUrl);
}).catch((err) => {
  console.error("[mobile-bridge] start error:", err);
});
process.on("SIGTERM", () => {
  bridge.stop().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  bridge.stop().finally(() => process.exit(0));
});
