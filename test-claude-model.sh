#!/usr/bin/env bash
# Curl round-trip check for the claude_model task field.
# Boots the server against a throwaway DB on a spare port, exercises every
# path listed in the claude-model feature spec, then kills the server.
set -uo pipefail

DB=/tmp/cm-test-$$.db
PORT=4123
PIN=1234
BASE="http://localhost:$PORT"
PASS=0
FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS+1))
    echo "OK   - $desc"
  else
    FAIL=$((FAIL+1))
    echo "FAIL - $desc (got: $got, want: $want)"
  fi
}

rm -f "$DB" "$DB-wal" "$DB-shm"
AUTH_USERS="owner:$PIN" DB_PATH="$DB" PORT="$PORT" node server.js > /tmp/cm-test-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm"' EXIT

# wait for boot (hit the static index, no auth attempts — avoid tripping login lockout)
for i in $(seq 1 30); do
  curl -s -o /dev/null "$BASE/" 2>/dev/null && break
  sleep 0.2
done
sleep 0.5

TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"pin\":\"$PIN\"}" | node -pe "JSON.parse(require('fs').readFileSync(0)).token" 2>/dev/null)
if [[ -z "$TOKEN" || "$TOKEN" == "undefined" ]]; then
  echo "FAIL - could not log in / get token"
  cat /tmp/cm-test-server.log
  exit 1
fi
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

BOARD=$(curl -s -X POST "$BASE/api/boards" "${AUTH[@]}" -d '{"name":"Test Board"}')
BOARD_ID=$(echo "$BOARD" | node -pe "JSON.parse(require('fs').readFileSync(0)).id")

COL=$(curl -s -X POST "$BASE/api/columns" "${AUTH[@]}" -d "{\"board_id\":\"$BOARD_ID\",\"name\":\"To Do\"}")
COL_ID=$(echo "$COL" | node -pe "JSON.parse(require('fs').readFileSync(0)).id")

# 1. create with claude_model: sonnet
TASK=$(curl -s -X POST "$BASE/api/tasks" "${AUTH[@]}" -d "{\"column_id\":\"$COL_ID\",\"title\":\"Test task\",\"claude_marked\":1,\"claude_model\":\"sonnet\"}")
TASK_ID=$(echo "$TASK" | node -pe "JSON.parse(require('fs').readFileSync(0)).id")
GOT=$(echo "$TASK" | node -pe "JSON.parse(require('fs').readFileSync(0)).claude_model")
check "create with claude_model=sonnet" "$GOT" "sonnet"

# 2. GET it back
GOT=$(curl -s "$BASE/api/tasks/$TASK_ID" "${AUTH[@]}" 2>/dev/null | node -pe "JSON.parse(require('fs').readFileSync(0)).claude_model" 2>/dev/null)
if [[ -z "$GOT" ]]; then
  # no GET /api/tasks/:id route — confirm via sync instead
  GOT=$(curl -s "$BASE/api/sync" "${AUTH[@]}" | node -pe "JSON.parse(require('fs').readFileSync(0)).tasks.find(t=>t.id==='$TASK_ID').claude_model")
fi
check "GET/sync shows claude_model=sonnet" "$GOT" "sonnet"

# 3. PUT claude_model: opus-4-6
PUT=$(curl -s -X PUT "$BASE/api/tasks/$TASK_ID" "${AUTH[@]}" -d '{"claude_model":"opus-4-6"}')
GOT=$(echo "$PUT" | node -pe "JSON.parse(require('fs').readFileSync(0)).claude_model")
check "PUT claude_model=opus-4-6" "$GOT" "opus-4-6"

# 4. PUT with only title -> claude_model preserved
PUT=$(curl -s -X PUT "$BASE/api/tasks/$TASK_ID" "${AUTH[@]}" -d '{"title":"Renamed"}')
GOT=$(echo "$PUT" | node -pe "JSON.parse(require('fs').readFileSync(0)).claude_model")
check "PUT title-only preserves claude_model" "$GOT" "opus-4-6"

# 5. PUT bogus -> 400
STATUS=$(curl -s -o /tmp/cm-bogus.json -w "%{http_code}" -X PUT "$BASE/api/tasks/$TASK_ID" "${AUTH[@]}" -d '{"claude_model":"bogus"}')
check "PUT claude_model=bogus returns 400" "$STATUS" "400"
ERR=$(node -pe "JSON.parse(require('fs').readFileSync(0)).error" < /tmp/cm-bogus.json)
check "400 body has invalid claude_model error" "$ERR" "invalid claude_model"

# 6. PUT '' -> clears it
PUT=$(curl -s -X PUT "$BASE/api/tasks/$TASK_ID" "${AUTH[@]}" -d '{"claude_model":""}')
GOT=$(echo "$PUT" | node -pe "JSON.parse(require('fs').readFileSync(0)).claude_model")
check "PUT claude_model='' clears it" "$GOT" ""

# 7. create with claude_model=fable, then check /api/sync carries the field
TASK2=$(curl -s -X POST "$BASE/api/tasks" "${AUTH[@]}" -d "{\"column_id\":\"$COL_ID\",\"title\":\"Task 2\",\"claude_model\":\"fable\"}")
TASK2_ID=$(echo "$TASK2" | node -pe "JSON.parse(require('fs').readFileSync(0)).id")
SYNC_GOT=$(curl -s "$BASE/api/sync" "${AUTH[@]}" | node -pe "JSON.parse(require('fs').readFileSync(0)).tasks.find(t=>t.id==='$TASK2_ID').claude_model")
check "/api/sync carries claude_model=fable" "$SYNC_GOT" "fable"

# 8. create with bogus claude_model -> 400
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/tasks" "${AUTH[@]}" -d "{\"column_id\":\"$COL_ID\",\"title\":\"Bad\",\"claude_model\":\"nope\"}")
check "POST claude_model=nope returns 400" "$STATUS" "400"

echo
echo "=== $PASS passed, $FAIL failed ==="
kill $SERVER_PID 2>/dev/null
rm -f "$DB" "$DB-wal" "$DB-shm"
trap - EXIT
[[ $FAIL -eq 0 ]]
