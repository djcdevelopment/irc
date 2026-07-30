FROM python:3.14.5-slim-bookworm@sha256:a9bee15510a364124aa24692899d269835683b883de42f7ebec8c293cf679ccb

WORKDIR /app
COPY requirements.txt agent_adapter.py ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

USER 65534:65534
ENTRYPOINT ["python", "-u", "/app/agent_adapter.py"]
