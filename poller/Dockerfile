FROM python:3.11-slim

WORKDIR /app

# The poller uses only stdlib — no pip install needed.
# Claude CLI must be bind-mounted or installed at runtime via the host.
COPY poller.py .

ENV PYTHONUNBUFFERED=1

CMD ["python3", "poller.py"]
