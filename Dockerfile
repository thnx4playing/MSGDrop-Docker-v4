# syntax=docker/dockerfile:1

FROM python:3.12-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini && \
    rm -rf /var/lib/apt/lists/*

# App deps
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Install yt-dlp for TikTok video extraction
RUN pip install --no-cache-dir yt-dlp

# App code
COPY main.py /app/main.py
# Static UI (serve your provided html/ under /msgdrop)
COPY html/ /app/html/

# Data directory (messages.db + blob files)
RUN mkdir -p /data/blob
VOLUME ["/data"]

ENV HOST=0.0.0.0 \
    PORT=443
EXPOSE 443

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["python","-u","/app/main.py"]