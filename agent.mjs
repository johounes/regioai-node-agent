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
import { execFile, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
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
  version: "0.3.0",
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

async function callOllama(model, messages) {
  const res = await fetch(`${CFG.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: model || CFG.model, messages, stream: false }),
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
      return sendJson(res, 200, { ok: true, model: CFG.model, version: CFG.version, enrolled: !!creds.nodeId });
    }
    if (req.method === "POST" && (req.url === "/v1/chat" || req.url === "/v1/swarm/forward")) {
      const body = await readBody(req);
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

  const tokens = tokensSinceLast;
  tokensSinceLast = 0;
  const started = Date.now();
  try {
    const res = await fetch(`${CFG.gateway}/api/nodes/${creds.nodeId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.nodeKey}` },
      body: JSON.stringify({
        status: "online",
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
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      // Node existiert nicht mehr (gelöscht) oder Key ungültig → deregistrieren
      deregister();
    } else if (!res.ok) {
      console.warn(`⚠️  Heartbeat abgelehnt (${res.status}): ${await res.text()}`);
    } else {
      console.log(`💓 Heartbeat ok – GPU ${util}%, VRAM ${memTotalMb}MB, +${tokens} Token`);
    }
  } catch (e) {
    tokensSinceLast += tokens;
    console.warn(`⚠️  Heartbeat fehlgeschlagen: ${e?.message ?? e}`);
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
  console.log(`✅ Node-Agent läuft auf :${CFG.port}`);
  console.log(`   Gateway:      ${CFG.gateway}`);
  console.log(`   Ollama:       ${CFG.ollamaUrl} (Modell ${CFG.model})`);
  console.log(`   endpoint_url: ${CFG.publicUrl}`);

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
