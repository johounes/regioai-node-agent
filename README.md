# ProximaEU – Node-Agent

Die **Node-Software** von [ProximaEU](https://app.proximaeu.de).
Sie läuft auf deinem GPU-Rechner, umschließt [Ollama](https://ollama.com) und
verbindet deine Maschine mit der Plattform:

- stellt `POST /v1/chat`, `POST /v1/swarm/forward` und `POST /v1/embed` bereit
  (Ziel der Gateway-Weiterleitung) sowie `GET /health`,
- übersetzt diese auf Ollama (`/api/chat` bzw. `/api/embeddings`),
- sendet regelmäßig einen **Heartbeat** (Status, GPU-Auslastung, VRAM, Token, `endpoint_url`).

> Dieses Repository wird automatisch als Docker-Image nach
> **`ghcr.io/johounes/regioai-node-agent:latest`** gebaut. Du musst hier nichts
> selbst klonen oder bauen – die Installation läuft über das Plattform-Skript
> (siehe unten).

---

## Schnellstart (empfohlen)

Auf dem PC, der zur Node werden soll, **einen Befehl** ausführen:

```bash
curl -fsSL https://app.proximaeu.de/install.sh | bash
```

Das Skript

1. prüft Docker + NVIDIA Container Toolkit,
2. öffnet die Pairing-Seite und fragt deinen 8-stelligen Code ab,
3. holt deine Node-Zugangsdaten von der Plattform,
4. schreibt `~/cag-node/docker-compose.yml` + `.env`,
5. zieht das Image `ghcr.io/johounes/regioai-node-agent:latest` und startet alles,
6. lädt das KI-Modell (`llama3:8b`) und wartet, bis deine Node **online** ist.

Danach erscheint die Node in deinem
[Operator-Dashboard](https://app.proximaeu.de/dashboard/operator).

---

## Systemvoraussetzungen

| Anforderung | Details |
|---|---|
| **Betriebssystem** | Linux (x86_64). macOS/Windows nur eingeschränkt (Host-Networking weicht ab). |
| **Docker** | [Docker Engine](https://docs.docker.com/engine/install/) inkl. `docker compose`. |
| **NVIDIA-GPU** | Empfohlen. Mit installiertem [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) für GPU-Beschleunigung. Ohne GPU läuft die Node weiter, aber deutlich langsamer. |
| **VRAM** | ≥ 8 GB für `llama3:8b`. Mehr VRAM → höhere Block-Kapazität für den Swarm-Modus. |
| **Netzwerk** | Die Plattform muss die gemeldete `endpoint_url` der Node erreichen können. |

---

## Nützliche Befehle

Im Arbeitsverzeichnis `~/cag-node`:

```bash
docker compose logs -f      # Logs ansehen
docker compose down         # Node stoppen
docker compose up -d        # Node starten
docker compose pull         # auf neuestes Image aktualisieren
```

---

## Konfiguration

Alle Werte werden vom Install-Skript in `~/cag-node/.env` gesetzt. Relevante Variablen:

| Variable | Default | Bedeutung |
|---|---|---|
| `CAG_GATEWAY` | — | URL der Plattform (vom Skript gesetzt) |
| `CAG_NODE_ID` | — | Node-ID (vom Pairing) |
| `CAG_NODE_KEY` | — | Node-Key `cagnode_…` (vom Pairing, einmalig) |
| `CAG_MODEL` | `llama3:8b` | bedientes Modell |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama-Adresse (im Compose-Netz) |
| `PORT` | `8080` | Port des Agents |
| `HEARTBEAT_INTERVAL` | `60` | Heartbeat-Intervall (Sek.) |
| `CAG_PUBLIC_URL` | `http://localhost:8080` | als `endpoint_url` gemeldete Adresse |
| `CAG_GPU_MEMORY_MB` | `0` | VRAM-Fallback, nur falls `nvidia-smi` fehlt (sonst automatisch erkannt) |
| `CAG_AUTO_UPDATE` | `true` | Self-Update an/aus (`false` = nie automatisch aktualisieren) |
| `CAG_MANIFEST_URL` | GitHub-Raw `manifest.json` | signiertes Update-Manifest (Einstiegspunkt des Self-Updates) |
| `CAG_UPDATE_HOSTS` | `raw.githubusercontent.com` | Host-Allowlist für Update-Downloads (nur https) |
| `CAG_ALLOW_UNSIGNED` | `false` | **Notausschalter**: akzeptiert `/v1/*` OHNE Gateway-Signatur. Nur zum Debuggen – im Normalbetrieb `false` lassen (sonst offener GPU-Proxy). |

---

## Auto-Update

Der Agent prüft (heartbeat-getaktet, **max. 1×/Stunde** + beim Start) auf eine neue
Version. Das Self-Update ist **kryptografisch abgesichert** (kein blindes Nachladen):

1. Er holt zuerst ein **signiertes Manifest** (`CAG_MANIFEST_URL`) und verifiziert dessen
   **Ed25519-Signatur** gegen die fest im Agent eingebetteten `TRUSTED_UPDATE_KEYS`
   (rotierbar über Key-IDs).
2. Erst dann lädt er die neue `agent.mjs` und prüft deren **sha256** gegen den im
   signierten Manifest hinterlegten Hash – plus einen Versions-String-Abgleich im Code.
3. Alle URLs müssen **https** sein und die **Host-Allowlist** (`CAG_UPDATE_HOSTS`,
   Default `raw.githubusercontent.com`) bestehen.
4. Zuletzt ein **Syntax-Check** (`node --check`), dann ersetzt er sich selbst und `exit(0)`.

Nur wenn Signatur **und** Hash **und** Version **und** Host **und** Syntax passen, wird das
Update übernommen. Der Supervisor startet den Prozess mit dem neuen Code neu:

- **Docker:** `restart: unless-stopped` startet denselben Container neu (der überschriebene
  `agent.mjs` bleibt im Writable-Layer erhalten).
- **macOS:** der LaunchAgent (`KeepAlive`) startet den Prozess neu.

Abschalten mit `CAG_AUTO_UPDATE=false`. So bleibt der Node ohne manuelles Redeploy aktuell.

**Kontrollierter Rollout:** Setzt die Plattform `CAG_AGENT_TARGET_VERSION` (optional
`CAG_AGENT_UPDATE_URL`), gibt sie diese **Zielversion** in der Heartbeat-Antwort mit. Der
Agent aktualisiert sich dann auf genau diese Version (statt das veröffentlichte `main` zu
verfolgen). So steuert der Betreiber den Rollout zentral; ohne Vorgabe gilt der `main`-Fallback.

---

## Manuelle Installation / Entwicklung

Für Tests ohne das Install-Skript kann das Image direkt verwendet werden:

```bash
docker run -d --name cag-agent --gpus all -p 8080:8080 \
  -e CAG_GATEWAY=https://app.proximaeu.de \
  -e CAG_NODE_ID=<deine-node-id> \
  -e CAG_NODE_KEY=cagnode_xxx \
  -e OLLAMA_URL=http://host.docker.internal:11434 \
  ghcr.io/johounes/regioai-node-agent:latest
```

Lokaler Build & Lauf des Agents (Node.js ≥ 20, keine Dependencies):

```bash
node agent.mjs
```

Health-Check:

```bash
curl http://localhost:8080/health
# {"ok":true,"model":"llama3:8b","version":"0.6.6","enrolled":true,"ollama":true,"models":["llama3:8b"]}
```

---

## Lizenz & Plattform

Teil von **ProximaEU** · https://app.proximaeu.de
