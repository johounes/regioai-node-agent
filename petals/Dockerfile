# Petals braucht Python 3.10/3.11 + CUDA-torch. Basis mit torch 2.1.2 / CUDA 11.8
# (unterstützt Turing/2080 Ti = compute 7.5).
FROM pytorch/pytorch:2.1.2-cuda11.8-cudnn8-runtime

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 HF_HUB_ENABLE_HF_TRANSFER=0

RUN apt-get update && apt-get install -y --no-install-recommends git curl \
  && rm -rf /var/lib/apt/lists/*

# hivemind (Petals-Dep) baut nur mit setuptools<81 (braucht pkg_resources).
# Constraint gilt auch für die isolierten PEP517-Build-Envs.
RUN pip install --no-cache-dir --upgrade pip "setuptools<81" wheel
RUN printf 'setuptools<81\n' > /tmp/pip-constraints.txt
ENV PIP_CONSTRAINT=/tmp/pip-constraints.txt

# accelerate nach oben pinnen: neuere Versionen brauchen ein hf_hub, das mit
# transformers 4.34 (Petals-Pin) inkompatibel ist.
RUN pip install --no-cache-dir \
      petals==2.2.0.post1 \
      "accelerate==0.23.0" \
      fastapi "uvicorn[standard]"

WORKDIR /app
COPY entrypoint-bootstrap.sh entrypoint-server.sh swarm_api.py /app/
RUN chmod +x /app/*.sh
