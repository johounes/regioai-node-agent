"""
Swarm-API – kleiner FastAPI-Client für den privaten Petals-Swarm.

Verbindet sich zum DHT (Peers aus /swarm/peers.txt), lädt das verteilte Modell
und führt Inferenz über die Pipeline der Petals-Server aus. Das Next.js-Gateway
ruft POST /swarm/infer auf, statt die Ollama-Simulation zu verwenden.
"""
import os
import time

from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn

MODEL = os.environ["CAG_SWARM_MODEL"]
PORT = int(os.environ.get("SWARM_API_PORT", "8077"))
PEERS_FILE = os.environ.get("PEERS_FILE", "/swarm/peers.txt")

app = FastAPI(title="Community AI Grid – Swarm API")
_state = {"model": None, "tokenizer": None, "ready": False, "error": None}


def _read_peers() -> list[str]:
    for _ in range(120):
        if os.path.exists(PEERS_FILE) and os.path.getsize(PEERS_FILE) > 0:
            with open(PEERS_FILE) as f:
                return f.read().split()
        time.sleep(2)
    raise RuntimeError("Kein DHT-Peer gefunden (peers.txt leer).")


@app.on_event("startup")
def load_model():
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer
        from petals import AutoDistributedModelForCausalLM

        peers = _read_peers()
        print(f"🔗 Verbinde zum Swarm über: {peers}", flush=True)
        tok = AutoTokenizer.from_pretrained(MODEL)
        model = AutoDistributedModelForCausalLM.from_pretrained(
            MODEL, initial_peers=peers
        )
        _state.update(model=model, tokenizer=tok, ready=True)
        print("✅ Swarm-API bereit – verteiltes Modell geladen.", flush=True)
    except Exception as e:  # noqa: BLE001
        _state["error"] = str(e)
        print(f"❌ Modell-Load fehlgeschlagen: {e}", flush=True)


class Message(BaseModel):
    role: str
    content: str


class InferRequest(BaseModel):
    messages: list[Message]
    max_tokens: int = 256


def _to_prompt(messages: list[Message]) -> str:
    # Einfaches Llama-2-Chat-Format
    parts = []
    for m in messages:
        if m.role == "user":
            parts.append(f"[INST] {m.content} [/INST]")
        else:
            parts.append(m.content)
    return "\n".join(parts)


@app.get("/health")
def health():
    return {"ready": _state["ready"], "model": MODEL, "error": _state["error"]}


@app.post("/swarm/infer")
def infer(req: InferRequest):
    if not _state["ready"]:
        return {"error": _state["error"] or "Modell noch nicht bereit."}
    tok = _state["tokenizer"]
    model = _state["model"]
    prompt = _to_prompt(req.messages)
    inputs = tok(prompt, return_tensors="pt")["input_ids"]
    out = model.generate(inputs, max_new_tokens=req.max_tokens)
    gen = out[0, inputs.shape[1]:]
    text = tok.decode(gen, skip_special_tokens=True)
    return {
        "text": text.strip(),
        "input_tokens": int(inputs.shape[1]),
        "output_tokens": int(gen.shape[0]),
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
