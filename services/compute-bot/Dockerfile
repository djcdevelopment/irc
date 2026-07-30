FROM python:3.14.5-slim-bookworm@sha256:a9bee15510a364124aa24692899d269835683b883de42f7ebec8c293cf679ccb AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check \
        --requirement /app/requirements.txt

COPY src/compute_bridge /app/compute_bridge

USER 1000:1000

FROM base AS test

COPY --chown=65534:65534 tests /app/tests
RUN python -m unittest discover -s /app/tests -v

FROM base AS runtime

ENTRYPOINT ["python", "-m", "compute_bridge"]
