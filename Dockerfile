FROM node:20-alpine

# native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install all deps (including devDeps for esbuild + CM6)
COPY package*.json ./
RUN npm install

# Copy source and bundle the editor
COPY src/ ./src/
COPY server.js recurrence.js ./
COPY public/ ./public/

# Bundle CodeMirror 6 into a single file
RUN node_modules/.bin/esbuild src/editor.js --bundle --minify --outfile=public/editor.bundle.js

# Drop devDeps from final image
RUN npm prune --omit=dev

RUN mkdir -p /data

EXPOSE 4000

CMD ["node", "server.js"]
