#!/bin/bash
set -e
umask 077
# This container owns the display and profile; these locks can survive an unclean stop.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /home/scout/profile/SingletonLock /home/scout/profile/SingletonSocket /home/scout/profile/SingletonCookie
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
sleep 1
openbox >/tmp/openbox.log 2>&1 &
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -nopw -noxdamage >/tmp/vnc.log 2>&1 &
websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/websockify.log 2>&1 &
socat TCP-LISTEN:9222,fork,bind=0.0.0.0 TCP:127.0.0.1:9223 &
chromium --no-sandbox --no-first-run --no-default-browser-check --password-store=basic --user-data-dir=/home/scout/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --window-size=1280,900 about:blank >/tmp/chromium.log 2>&1 &
wait -n
