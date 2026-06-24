# Community AI Grid – Node-Agent

Die **Node-Software** von [Community AI Grid](https://regio-ai.vercel.app).
Sie läuft auf deinem GPU-Rechner, umschließt [Ollama](https://ollama.com) und
verbindet deine Maschine mit der Plattform:

- stellt `POST /v1/chat` und `POST /v1/swarm/forward` bereit (Ziel der Gateway-Weiterleitung),
- übersetzt diese auf Ollama (`/api/chat`),
- sendet regelmäßig einen **Heartbeat** (Status, GPU-Auslastung, VRAM, Token, `endpoint_url`).

> Dieses Repository wird automatisch als Docker-Image nach
> **`ghcr.io/johounes/regioai-node-agent:latest`** gebaut. Du musst hier nichts
> selbst klonen oder bauen – die Installation läuft über das Plattform-Skript
> (siehe unten).

---

## Schnellstart (empfohlen)

Auf dem PC, der zur Node werden soll, **einen Befehl** ausführen:

```bash
curl -fsSL https://regio-ai.vercel.app/install.sh | bash
```

Das Skript

1. prüft Docker + NVIDIA Container Toolkit,
2. öffnet die Pairing-Seite und fragt deinen 8-stelligen Code ab,
3. holt deine Node-Zugangsdaten von der Plattform,
4. schreibt `~/cag-node/docker-compose.yml` + `.env`,
5. zieht das Image `ghcr.io/johounes/regioai-node-agent:latest` und startet alles,
6. lädt das KI-Modell (`llama3:8b`) und wartet, bis deine Node **online** ist.

Danach erscheint die Node in deinem
[Operator-Dashboard](https://regio-ai.vercel.app/dashboard/operator).

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
| `CAG_GPU_MEMORY_MB` | `24576` | VRAM-Fallback, falls `nvidia-smi` fehlt |

---

## Manuelle Installation / Entwicklung

Für Tests ohne das Install-Skript kann das Image direkt verwendet werden:

```bash
docker run -d --name cag-agent --gpus all -p 8080:8080 \
  -e CAG_GATEWAY=https://regio-ai.vercel.app \
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
# {"ok":true,"model":"llama3:8b","version":"0.3.0","enrolled":true}
```

---

## Lizenz & Plattform

Teil von **Community AI Grid** · https://regio-ai.vercel.app
