#!/usr/bin/env node
/**
 * Community AI Grid – Node-Agent
 *
 *  1. stellt POST /v1/chat und /v1/swarm/forward bereit (Gateway-Weiterleitung),
 *  2. übersetzt diese auf Ollama (/api/chat),
 *  3. liefert unter GET / einen lokalen Setup-Assistenten aus: Operator meldet
 *     sich an, die Node registriert sich automatisch (siehe setup.html),
 *  4. sendet – sobald verbunden – alle HEARTBEAT_INTERVAL Sekunden einen Heartbeat.
 *
 * Credentials: CAG_NODE_ID/CAG_NODE_KEY (Umgebung), gespeicherte Datei – oder
 * über den lokalen Setup-Assistenten (http://localhost:PORT).
 */

import { createServer } from "node:http";
import { execFile, execSync, execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { hostname, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
  console.log("ℹ️  .env geladen");
} catch {
  /* keine .env – Werte aus der Umgebung */
}

const CFG = {
  gateway: (process.env.CAG_GATEWAY ?? "http://localhost:3000").replace(/\/$/, ""),
  ollamaUrl: (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, ""),
  model: process.env.CAG_MODEL ?? "llama3:8b",
  port: Number(process.env.PORT ?? 8088),
  publicUrl: (process.env.CAG_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8088}`).replace(/\/$/, ""),
  heartbeatSec: Number(process.env.HEARTBEAT_INTERVAL ?? 60),
  gpuMemFallbackMb: Number(process.env.CAG_GPU_MEMORY_MB ?? 0),
  credentialsFile: process.env.CAG_CREDENTIALS_FILE ?? "./.node-credentials.json",
  version: "0.5.5",
  // Ollama-Generierung: Kontextfenster + max. Output-Token. Ohne diese Werte
  // greift ein Default, der lange Antworten abschneidet.
  numCtx: Number(process.env.CAG_NUM_CTX ?? 8192),
  numPredict: Number(process.env.CAG_NUM_PREDICT ?? 2048),
  // Modell im VRAM halten → kein mehrsekündiger Reload nach Leerlauf.
  // "-1" = dauerhaft geladen (für dedizierte Inferenz-Nodes ideal), "30m" etc.
  keepAlive: process.env.CAG_KEEP_ALIVE ?? "30m",
  // Auto-Update: prüft regelmäßig die veröffentlichte agent.mjs und aktualisiert
  // sich selbst. CAG_AUTO_UPDATE=false schaltet es ab.
  autoUpdate: (process.env.CAG_AUTO_UPDATE ?? "true").toLowerCase() !== "false",
  updateUrl:
    process.env.CAG_UPDATE_URL ??
    "https://raw.githubusercontent.com/johounes/regioai-node-agent/main/agent.mjs",
};

const creds = {
  nodeId: process.env.CAG_NODE_ID ?? "",
  nodeKey: process.env.CAG_NODE_KEY ?? "",
};

let tokensSinceLast = 0;
let heartbeatStarted = false;
let heartbeatTimer = null;

const SETUP_HTML = (() => {
  try {
    return readFileSync(fileURLToPath(new URL("./setup.html", import.meta.url)), "utf8");
  } catch {
    return "<h1>setup.html fehlt</h1>";
  }
})();

// ---------- GPU / Ollama ----------

function getGpuStats() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) return resolve({ util: 0, memTotalMb: CFG.gpuMemFallbackMb });
        const [util, mem] = (stdout.trim().split("\n")[0] ?? "").split(",").map((s) => Number(s.trim()));
        resolve({
          util: Number.isFinite(util) ? util : 0,
          memTotalMb: Number.isFinite(mem) ? mem : CFG.gpuMemFallbackMb,
        });
      },
    );
  });
}

function getGpuInfo() {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve({ name: null, count: 1 });
      const names = stdout.trim().split("\n").filter(Boolean);
      resolve({ name: names[0] ?? null, count: names.length || 1 });
    });
  });
}

const isMac = process.platform === "darwin";

/**
 * Erkennt Apple-Silicon-Hardware via sysctl (Fallback: system_profiler).
 * Unified Memory zählt als VRAM. Gibt null zurück, wenn kein Apple-Chip
 * gefunden wird (z.B. Intel-Mac → CPU-Modus) oder die Befehle fehlschlagen.
 */
function getAppleSiliconInfo() {
  try {
    const chip = execSync(
      "sysctl -n machdep.cpu.brand_string 2>/dev/null || " +
        "system_profiler SPHardwareDataType | grep 'Chip' | awk -F': ' '{print $2}'",
      { timeout: 3000 },
    )
      .toString()
      .trim();

    // Nur echte Apple-Silicon-Chips ("Apple M…") behandeln; Intel-Macs → CPU.
    if (!/apple/i.test(chip)) return null;

    const memBytes = execSync("sysctl -n hw.memsize", { timeout: 3000 })
      .toString()
      .trim();
    const memGB = Math.round(parseInt(memBytes, 10) / 1024 / 1024 / 1024);

    return {
      gpu_model: chip || "Apple Silicon",
      gpu_count: 1,
      ram_gb: memGB,
      unified_memory_gb: memGB,
      gpu_memory_total_mb: memGB * 1024, // Unified Memory = VRAM
      hardware_type: "apple_silicon",
    };
  } catch {
    return null;
  }
}

// Hardware-Infos einmalig ermitteln und cachen (ändern sich zur Laufzeit nicht).
let hwInfo = null;
async function getHardwareInfo() {
  if (!hwInfo) {
    if (isMac) {
      const apple = getAppleSiliconInfo();
      hwInfo = apple ?? {
        // Mac ohne Apple-Silicon (Intel) → CPU-Modus
        gpu_model: null,
        gpu_count: 1,
        ram_gb: Math.round(totalmem() / 1024 ** 3),
        hardware_type: "cpu",
      };
    } else {
      // Linux/Windows: bestehende nvidia-smi-Logik unverändert
      const gpu = await getGpuInfo();
      hwInfo = {
        gpu_model: gpu.name,
        gpu_count: gpu.count,
        ram_gb: Math.round(totalmem() / 1024 ** 3),
        hardware_type: gpu.name ? "nvidia" : "cpu",
      };
    }
  }
  return hwInfo;
}

/** Prüft, ob Ollama erreichbar ist (GET /api/tags). Liefert {ok, models}. */
async function pingOllama() {
  try {
    const res = await fetch(`${CFG.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, models: [] };
    const data = await res.json().catch(() => ({}));
    const models = Array.isArray(data?.models)
      ? data.models.map((m) => m?.name).filter(Boolean)
      : [];
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}

// ---------- Modell-Distribution ----------

let pullingModel = null;
let pullProgress = 0;

/**
 * Zieht ein Modell per Ollama /api/pull (streamt Fortschritt). Läuft async im
 * Hintergrund; pullingModel/pullProgress werden im Heartbeat mitgemeldet.
 */
async function pullModel(name) {
  if (pullingModel) return; // immer nur ein Pull gleichzeitig
  pullingModel = name;
  pullProgress = 0;
  console.log(`⬇️  Ziehe Modell ${name} ...`);
  try {
    const res = await fetch(`${CFG.ollamaUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, stream: true }),
      signal: AbortSignal.timeout(3_600_000), // bis 1h für große Modelle
    });
    if (!res.ok || !res.body) throw new Error(`Ollama pull ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          if (o.total && o.completed) {
            pullProgress = Math.round((o.completed / o.total) * 100);
          }
          if (o.status === "success") pullProgress = 100;
          if (o.error) throw new Error(o.error);
        } catch {
          /* unvollständige Zeile */
        }
      }
    }
    console.log(`✅ Modell ${name} installiert.`);
  } catch (e) {
    console.warn(`⚠️  Modell-Pull ${name} fehlgeschlagen: ${e?.message ?? e}`);
  } finally {
    pullingModel = null;
    pullProgress = 0;
  }
}

/** Zieht das erste fehlende Soll-Modell (eines nach dem anderen). */
function reconcileModels(desired, installed) {
  if (!Array.isArray(desired) || pullingModel) return;
  const missing = desired.find(
    (m) => typeof m === "string" && m && !installed.includes(m),
  );
  if (missing) pullModel(missing); // fire-and-forget
}

async function callOllama(model, messages) {
  const res = await fetch(`${CFG.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || CFG.model,
      messages,
      stream: false,
      keep_alive: CFG.keepAlive,
      options: { num_ctx: CFG.numCtx, num_predict: CFG.numPredict },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama antwortete mit ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data?.message?.content ?? "";
  const outTokens = Number(data?.eval_count ?? 0);
  const inTokens = Number(data?.prompt_eval_count ?? 0);
  tokensSinceLast += outTokens + inTokens;
  return { message: { content }, eval_count: outTokens, prompt_eval_count: inTokens };
}

/**
 * Echtes Token-Streaming: ruft Ollama mit stream:true auf und reicht die
 * NDJSON-Zeilen sofort an den Aufrufer (Gateway) durch. So erscheint das erste
 * Token nach ~1 s statt nach der kompletten Generierung. Token werden aus der
 * abschließenden `done`-Zeile gezählt.
 */
async function streamOllama(res, model, messages, tools) {
  const upstream = await fetch(`${CFG.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || CFG.model,
      messages,
      stream: true,
      keep_alive: CFG.keepAlive,
      options: { num_ctx: CFG.numCtx, num_predict: CFG.numPredict },
      // Tool-Calling (Web-Suche): nur durchreichen, wenn das Gateway Tools sendet.
      ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!upstream.ok || !upstream.body) {
    sendJson(res, 502, { error: `Ollama antwortete mit ${upstream.status}` });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
  });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let inTok = 0;
  let outTok = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    res.write(chunk); // NDJSON sofort durchreichen
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.done) {
          outTok = Number(o.eval_count ?? 0);
          inTok = Number(o.prompt_eval_count ?? 0);
        }
      } catch {
        /* unvollständige Zeile – ignorieren */
      }
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      const o = JSON.parse(tail);
      if (o.done) {
        outTok = Number(o.eval_count ?? 0);
        inTok = Number(o.prompt_eval_count ?? 0);
      }
    } catch {
      /* unvollständig – ignorieren */
    }
  }
  res.end();
  tokensSinceLast += outTok + inTok;
}

// ---------- HTTP ----------

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 25 * 1024 * 1024) reject(new Error("Body zu groß"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    // Lokaler Setup-Assistent
    if (req.method === "GET" && (req.url === "/" || req.url === "/setup")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(SETUP_HTML);
    }
    if (req.method === "GET" && req.url === "/api/local/status") {
      const gpu = await getGpuInfo();
      return sendJson(res, 200, {
        enrolled: !!(creds.nodeId && creds.nodeKey),
        platformUrl: CFG.gateway,
        hints: { gpu_model: gpu.name, gpu_count: gpu.count, hostname: hostname() },
      });
    }
    if (req.method === "POST" && req.url === "/api/local/complete") {
      const body = await readBody(req);
      if (!body.node_id || !body.node_key) {
        return sendJson(res, 400, { error: "node_id/node_key fehlen" });
      }
      creds.nodeId = body.node_id;
      creds.nodeKey = body.node_key;
      saveCredentials(creds.nodeId, creds.nodeKey);
      startHeartbeat();
      console.log("✅ Node über Setup-Assistent verbunden – Heartbeats aktiv.");
      return sendJson(res, 200, { ok: true });
    }

    // Betriebsendpunkte
    if (req.method === "GET" && req.url === "/health") {
      const ollama = await pingOllama();
      return sendJson(res, ollama.ok ? 200 : 503, {
        ok: ollama.ok,
        ollama: ollama.ok,
        models: ollama.models,
        model: CFG.model,
        version: CFG.version,
        enrolled: !!creds.nodeId,
      });
    }
    if (req.method === "POST" && (req.url === "/v1/chat" || req.url === "/v1/swarm/forward")) {
      const body = await readBody(req);
      if (body.stream === true) {
        return await streamOllama(
          res,
          body.model,
          body.messages ?? [],
          body.tools,
        );
      }
      return sendJson(res, 200, await callOllama(body.model, body.messages ?? []));
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message ?? e) });
  }
});

// ---------- Credentials ----------

function loadCredentialsFromFile() {
  try {
    if (existsSync(CFG.credentialsFile)) {
      const c = JSON.parse(readFileSync(CFG.credentialsFile, "utf8"));
      if (c.node_id && c.node_key) return c;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveCredentials(nodeId, nodeKey) {
  try {
    writeFileSync(CFG.credentialsFile, JSON.stringify({ node_id: nodeId, node_key: nodeKey }, null, 2));
    console.log(`💾 Credentials gespeichert: ${CFG.credentialsFile}`);
  } catch (e) {
    console.warn(`⚠️  Konnte Credentials nicht speichern: ${e?.message ?? e}`);
  }
}

/**
 * Node wurde plattformseitig gelöscht (Heartbeat 401): Credentials verwerfen,
 * Heartbeats stoppen und zurück in den Setup-Modus – ohne Neustart.
 */
function deregister() {
  creds.nodeId = "";
  creds.nodeKey = "";
  try {
    if (existsSync(CFG.credentialsFile)) unlinkSync(CFG.credentialsFile);
  } catch {
    /* ignore */
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatStarted = false;
  console.log("\n────────────────────────────────────────────");
  console.log("🔌  NODE WURDE ENTFERNT – zurück im Setup-Modus");
  console.log(`   Öffne im Browser:  ${CFG.publicUrl}`);
  console.log("   Erneut anmelden, um die Node neu zu registrieren.");
  console.log("────────────────────────────────────────────\n");
}

// ---------- Auto-Update ----------

/** Vergleicht zwei "maj.min.patch"-Versionen → true, wenn a neuer als b ist. */
function isNewerVersion(a, b) {
  const pa = String(a).split(".").map((n) => Number(n) || 0);
  const pb = String(b).split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

let lastUpdateCheck = 0;
const UPDATE_CHECK_INTERVAL_MS = 3_600_000; // stündlich

/**
 * Lädt agent.mjs von `url`, vergleicht die Version und ersetzt – falls neuer als
 * die laufende – die eigene Datei (nach Syntaxprüfung), dann process.exit(0). Der
 * Supervisor (Docker restart:unless-stopped / macOS LaunchAgent KeepAlive) startet
 * den Prozess mit dem neuen Code neu. Fehler sind nicht fatal.
 */
async function applyUpdateFrom(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const code = await res.text();
    const m = code.match(/version:\s*"(\d+\.\d+\.\d+)"/);
    if (!m || !isNewerVersion(m[1], CFG.version)) return;
    // Plausibilität: keine Fehlerseite / Teil-Download einspielen
    if (code.length < 3000 || !code.includes("sendHeartbeat")) {
      console.warn("⚠️  Auto-Update verworfen: Remote-Datei wirkt unvollständig.");
      return;
    }
    const selfPath = fileURLToPath(import.meta.url);
    // Temp-Datei MUSS auf .mjs enden, sonst scheitert `node --check`
    // (ERR_UNKNOWN_FILE_EXTENSION für .new → Modulformat unbekannt).
    const tmp = `${selfPath}.new.mjs`;
    writeFileSync(tmp, code);
    // Syntaxprüfung mit demselben Node-Binary, bevor wir uns überschreiben.
    try {
      execFileSync(process.execPath, ["--check", tmp], { timeout: 10_000 });
    } catch {
      console.warn("⚠️  Auto-Update verworfen: Syntaxprüfung fehlgeschlagen.");
      try { unlinkSync(tmp); } catch { /* ignore */ }
      return;
    }
    renameSync(tmp, selfPath);
    console.log(`⬆️  Auf Agent-Version ${m[1]} aktualisiert (war ${CFG.version}) – Neustart.`);
    process.exit(0);
  } catch (e) {
    console.warn(`⚠️  Auto-Update-Check fehlgeschlagen: ${e?.message ?? e}`);
  }
}

// ---------- Heartbeat ----------

async function sendHeartbeat() {
  const hw = await getHardwareInfo();

  // Auslastung + VRAM: auf Apple Silicon aus Unified Memory, sonst via nvidia-smi.
  let util = 0;
  let memTotalMb;
  if (hw.hardware_type === "apple_silicon") {
    memTotalMb = hw.gpu_memory_total_mb ?? CFG.gpuMemFallbackMb;
  } else {
    const stats = await getGpuStats();
    util = stats.util;
    memTotalMb = stats.memTotalMb;
  }

  // Ollama-Gesundheit: ohne erreichbares Ollama kann der Node nicht verarbeiten
  // → status 'degraded', damit das Gateway ihn nicht auswählt.
  const ollama = await pingOllama();

  const tokens = tokensSinceLast;
  tokensSinceLast = 0;
  const started = Date.now();
  let serverUpdate = null;
  try {
    const res = await fetch(`${CFG.gateway}/api/nodes/${creds.nodeId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.nodeKey}` },
      body: JSON.stringify({
        status: ollama.ok ? "online" : "degraded",
        ollama_ok: ollama.ok,
        gpu_utilization: util,
        gpu_memory_total_mb: memTotalMb,
        tokens_processed_since_last: tokens,
        latency_to_gateway_ms: Date.now() - started,
        node_software_version: CFG.version,
        endpoint_url: CFG.publicUrl,
        // Hardware-Auto-Erkennung (Plattform übernimmt diese Werte)
        gpu_model: hw.gpu_model,
        gpu_count: hw.gpu_count,
        ram_gb: hw.ram_gb,
        hardware_type: hw.hardware_type,
        unified_memory_gb: hw.unified_memory_gb, // nur Apple Silicon, sonst undefined
        // Modell-Distribution: installierte Modelle + laufender Pull
        installed_models: ollama.models,
        pulling_model: pullingModel,
        pull_progress: pullProgress,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      // Node existiert nicht mehr (gelöscht) oder Key ungültig → deregistrieren
      deregister();
    } else if (!res.ok) {
      console.warn(`⚠️  Heartbeat abgelehnt (${res.status}): ${await res.text()}`);
    } else {
      const data = await res.json().catch(() => ({}));
      // Kontrollierter Rollout: { target_version, update_url } von der Plattform
      serverUpdate = data?.update ?? null;
      // Modell-Distribution: fehlende Soll-Modelle ziehen
      reconcileModels(data?.desired_models, ollama.models);
      console.log(`💓 Heartbeat ok – GPU ${util}%, VRAM ${memTotalMb}MB, +${tokens} Token`);
    }
  } catch (e) {
    tokensSinceLast += tokens;
    console.warn(`⚠️  Heartbeat fehlgeschlagen: ${e?.message ?? e}`);
  }

  // Auto-Update: bevorzugt die von der Plattform vorgegebene Zielversion
  // (kontrollierter Rollout). Ohne Vorgabe Fallback: veröffentlichtes main (stündlich).
  if (CFG.autoUpdate) {
    if (serverUpdate?.target_version) {
      if (isNewerVersion(serverUpdate.target_version, CFG.version)) {
        await applyUpdateFrom(serverUpdate.update_url || CFG.updateUrl);
      }
    } else if (Date.now() - lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS) {
      lastUpdateCheck = Date.now();
      await applyUpdateFrom(CFG.updateUrl);
    }
  }
}

function startHeartbeat() {
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, CFG.heartbeatSec * 1000);
}

// ---------- Start ----------

server.listen(CFG.port, () => {
  console.log(`✅ Node-Agent v${CFG.version} läuft auf :${CFG.port}`);
  console.log(`   Gateway:      ${CFG.gateway}`);
  console.log(`   Ollama:       ${CFG.ollamaUrl} (Modell ${CFG.model})`);
  console.log(`   endpoint_url: ${CFG.publicUrl}`);
  console.log(`   Auto-Update:  ${CFG.autoUpdate ? "an (CAG_AUTO_UPDATE=false zum Abschalten)" : "aus"}`);

  if (!creds.nodeId || !creds.nodeKey) {
    const file = loadCredentialsFromFile();
    if (file) {
      creds.nodeId = file.node_id;
      creds.nodeKey = file.node_key;
    }
  }

  if (creds.nodeId && creds.nodeKey) {
    console.log("🔑 Node verbunden – starte Heartbeats.");
    startHeartbeat();
  } else {
    console.log("\n────────────────────────────────────────────");
    console.log("🔌  DIESE NODE IST NOCH NICHT VERBUNDEN");
    console.log(`   Öffne im Browser:  ${CFG.publicUrl}`);
    console.log("   Dort anmelden – die Node registriert sich automatisch.");
    console.log("────────────────────────────────────────────\n");
    execFile("xdg-open", [CFG.publicUrl], () => {}); // best effort
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\n👋 Node-Agent wird beendet.");
    server.close(() => process.exit(0));
  });
}
