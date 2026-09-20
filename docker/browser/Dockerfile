FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox x11vnc novnc websockify socat ca-certificates fonts-liberation curl tini && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 scout && mkdir -p /home/scout/profile && chown -R scout:scout /home/scout
COPY start.sh /usr/local/bin/start-desktop
RUN chmod 755 /usr/local/bin/start-desktop
USER scout
ENV DISPLAY=:99 HOME=/home/scout
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/start-desktop"]
