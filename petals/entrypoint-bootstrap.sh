#!/bin/bash
# DHT-Bootstrap des privaten Swarms. Startet run_dht, ermittelt die announcte
# Multiaddr (inkl. Peer-ID) und schreibt sie nach /swarm/peers.txt, damit
# Server und API automatisch beitreten können.
set -e
mkdir -p /swarm
rm -f /swarm/peers.txt /swarm/dht.log
PORT="${DHT_PORT:-31337}"

echo "🛰️  Starte DHT-Bootstrap auf :$PORT"
python -m petals.cli.run_dht \
  --host_maddrs "/ip4/0.0.0.0/tcp/$PORT" \
  --identity_path /swarm/dht.id 2>&1 | tee /swarm/dht.log &
DHT_PID=$!

echo "⏳ Warte auf DHT-Multiaddr ..."
for i in $(seq 1 60); do
  # bevorzugt 127.0.0.1 (Single-Host), sonst erste nicht-0.0.0.0-Adresse
  MADDR=$(grep -oE "/ip4/127\.0\.0\.1/tcp/$PORT/p2p/[A-Za-z0-9]+" /swarm/dht.log | head -1 || true)
  if [ -z "$MADDR" ]; then
    MADDR=$(grep -oE "/ip4/[0-9.]+/tcp/$PORT/p2p/[A-Za-z0-9]+" /swarm/dht.log | grep -v "/ip4/0.0.0.0/" | head -1 || true)
  fi
  if [ -n "$MADDR" ]; then
    echo "$MADDR" > /swarm/peers.txt
    echo "✅ DHT bereit – initial_peers: $MADDR"
    break
  fi
  sleep 2
done

if [ ! -s /swarm/peers.txt ]; then
  echo "❌ Keine DHT-Multiaddr gefunden – siehe /swarm/dht.log"
fi

wait $DHT_PID
