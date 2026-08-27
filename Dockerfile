FROM node:20-alpine

# native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install all deps (including devDeps for esbuild + CM6)
COPY package*.json ./
RUN npm install

# Copy source and bundle the editor
COPY src/ ./src/
COPY server.js recurrence.js connections.js client_connections.js audit_render.js audit_config.json audit_config_ads.json audit_template.html ./
COPY public/ ./public/

# Bundle CodeMirror 6 into a single file
RUN node_modules/.bin/esbuild src/editor.js --bundle --minify --outfile=public/editor.bundle.js

# Bundle the Twilio Voice SDK for the Calls tab
RUN node_modules/.bin/esbuild src/dialer.js --bundle --minify --outfile=public/dialer.bundle.js

# Drop devDeps from final image
RUN npm prune --omit=dev

RUN mkdir -p /data

# The deploy scp's files onto a host whose root umask is 077, so they arrive mode 0600 and
# COPY preserves that — unreadable by any non-root user. Normalise before dropping root
# (a+rX = readable everywhere, +x only on directories) so deploys can't reintroduce it.
RUN chmod -R a+rX /app

# Drop root. node:20-alpine ships a `node` user at uid/gid 1000; everything under /app is
# only read at runtime, and the only writes go to the /data volume.
# The host side of that volume must be owned by uid 1000 or SQLite can't write:
#   chown -R 1000:1000 /var/lib/docker/volumes/vikunja_workspace_data/_data
USER node

EXPOSE 4000

CMD ["node", "server.js"]
