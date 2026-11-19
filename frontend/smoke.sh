#!/usr/bin/env bash
# API smoke test using the same origin settings as the browser frontend (curl + jq only).
# Usage: API=http://localhost:8010 ORIGIN=http://localhost:5173 ./smoke.sh
set -uo pipefail
API=${API:-http://localhost:8010}
ORIGIN=${ORIGIN:-http://localhost:5173}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
RUN=$(date +%s)$RANDOM

# call JAR METHOD PATH [JSON] -> prints body, sets $CODE
call() {
  local jar=$1 method=$2 path=$3 data=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -b "$TMP/$jar" -c "$TMP/$jar" -X "$method" -H "Origin: $ORIGIN")
  [[ -n $data ]] && args+=(-H 'Content-Type: application/json' --data-binary "$data")
  curl "${args[@]}" "$API$path" > "$TMP/code"   # code goes via a file: call often runs in a $(...) subshell
  cat "$TMP/body"
}
check() { # name expected_code (reads the last call's status unless CODE was just set directly)
  local rc=$?  # non-zero when a preceding `jq -e` assertion failed
  [[ -n ${DIRECT:-} ]] || CODE=$(cat "$TMP/code"); DIRECT=
  if [[ $CODE == "$2" && $rc == 0 ]]; then PASS=$((PASS+1)); echo "ok   $1 ($CODE)"; else FAIL=$((FAIL+1)); echo "FAIL $1: got $CODE (jq rc $rc) want $2: $(head -c 300 "$TMP/body")"; fi
}
expect() { # name condition-result
  if [[ $2 == true ]]; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; fi
}

GEO='{"walls":[{"id":"w1t","a":[0,0],"b":[5000,0],"thickness":100,"structural":false},{"id":"w1b","a":[0,4000],"b":[5000,4000],"thickness":100,"structural":false},{"id":"w1l","a":[0,0],"b":[0,4000],"thickness":100,"structural":false},{"id":"w1r","a":[5000,0],"b":[5000,4000],"thickness":100,"structural":false}],"openings":[{"id":"d1","wall_id":"w1b","offset":2100,"width":800,"kind":"door"}],"rooms":[{"id":"r1","name":"Living","kind":"living","polygon":[[0,0],[5000,0],[5000,4000],[0,4000]]}],"fixtures":[],"furniture":[{"id":"f1","catalog_key":"sofa-3","label":"Sofa","x":1000,"y":2800,"w":2100,"d":900,"rot":0}]}'
GEO2=$(echo "$GEO" | jq -c '.walls[3].b=[5000,4500] | .furniture[0].rot=90')

echo "== csrf"
curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/logout" | grep -q 403 && expect "POST without Origin rejected" true || expect "POST without Origin rejected" false

echo "== designer onboarding"
call d POST /auth/register "{\"email\":\"des$RUN@example.com\",\"password\":\"password123\",\"display_name\":\"Dana Designer\"}" >/dev/null; check register 201
call d POST /studios "{\"name\":\"Studio $RUN\",\"slug\":\"st$RUN\"}" >/dev/null; check "create studio" 201
SLUG=st$RUN
call d GET /studio | jq -e '.credits==50' >/dev/null; check "studio credits" 200
call d PUT /studio/branding '{"primary_color":"#224466","font":"lora","template":"classic","display_name":"Smoke Studio"}' >/dev/null; check "branding put" 200
call d PUT /studio/branding '{"primary_color":"red;}"}' >/dev/null; check "bad colour rejected" 422
call x GET "/public/studios/$SLUG" | jq -e '.primary_color=="#224466"' >/dev/null; check "public studio" 200

echo "== project + plan"
PID=$(call d POST /projects "{\"name\":\"Flat\",\"geometry\":$GEO}" | jq -r .id); check "create project with wizard geometry" 201
P=/projects/$PID
call d GET $P/plan | jq -e '.current_version.version_no==1 and (.caveat|length>0)' >/dev/null; check "get plan" 200
V=$(call d POST $P/plan/versions "{\"geometry\":$GEO2,\"label\":\"moved wall\",\"base_version_no\":1}"); check "save version" 201
expect "wall change flagged provisional" "$(echo "$V" | jq '.version_no==2 and .review_status=="provisional"')"
call d POST $P/plan/versions "{\"geometry\":$GEO,\"base_version_no\":1}" >/dev/null; check "stale base -> conflict" 409
call d GET "$P/plan/compare?from=1&to=2" | jq -e '.diff.walls.changed==["w1r"]' >/dev/null; check compare 200
call d POST $P/plan/versions/2/review '{"note":"checked by engineer"}' | jq -e '.review_status=="conceptual"' >/dev/null; check "mark reviewed" 200
call d GET $P/plan/versions/1 | jq -e '.geometry.walls|length==4' >/dev/null; check "load old version" 200

echo "== brief, design"
call d PUT $P/brief '{"styles":["scandinavian"],"colors":["sage"],"budget":{"min":1000,"max":5000,"currency":"EUR","priority":"balanced"},"household":{"adults":2,"children":1,"pets":["cat"],"works_from_home":true,"accessibility_needs":""},"existing_items":[{"name":"Piano","keep":true,"width_mm":1500}],"inspiration_urls":["https://example.com/a"],"notes":"hi"}' >/dev/null; check "brief put" 200
FK=$(call x GET '/catalog/finishes?surface=floor' | jq -r '.finishes[0].key'); check "finishes catalog" 200
call d PUT $P/finishes "{\"room_id\":\"r1\",\"surface\":\"floor\",\"finish_key\":\"$FK\"}" >/dev/null; check "finish select" 200
MID=$(call d POST $P/moodboards '{"name":"Living"}' | jq -r .id); check "moodboard create" 201
call d POST $P/moodboards/$MID/items '{"kind":"color","ref":"#aabbcc"}' >/dev/null; check "moodboard color" 201
call d POST $P/moodboards/$MID/items '{"kind":"catalog","ref":"sofa-3"}' >/dev/null; check "moodboard catalog item" 201
call d GET $P/moodboards/$MID | jq -e '.items|length==2' >/dev/null; check "moodboard get" 200
printf '\x89PNG\r\n\x1a\n' > "$TMP/bad.png"
DIRECT=1 CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -b "$TMP/d" -H "Origin: $ORIGIN" -F "file=@$TMP/bad.png;type=image/png" "$API$P/uploads"); check "corrupt image rejected" 400

echo "== ai"
AI=$(call d POST $P/ai/messages '{"message":"Which style suits a bright living room?"}'); check "ai message" 201
SID=$(echo "$AI" | jq -r '.message.suggestions[0].id')
call d POST $P/ai/suggestions/$SID/feedback '{"decision":"accept"}' >/dev/null; check "suggestion feedback" 200
call d GET $P/plan | jq -e '.current_version.version_no==2' >/dev/null; check "ai left plan unchanged" 200

echo "== renders"
KEY=k$RUN
R=$(call d POST $P/renders "{\"view\":{\"room_id\":\"r1\",\"angle\":\"front\"},\"plan_version_no\":1,\"idempotency_key\":\"$KEY\"}"); check "render request" 202
RID=$(echo "$R" | jq -r .id)
call d POST $P/renders "{\"view\":{\"room_id\":\"r1\",\"angle\":\"front\"},\"plan_version_no\":1,\"idempotency_key\":\"$KEY\"}" | jq -e '.replayed==true' >/dev/null; check "render replay" 200
for _ in $(seq 1 15); do ST=$(call d GET $P/renders/$RID | jq -r .status); [[ $ST == succeeded || $ST == failed ]] && break; sleep 1; done
expect "render finished ($ST)" "$([[ $ST == succeeded ]] && echo true)"
CODE=$(curl -s -o "$TMP/img" -w '%{http_code} %{content_type}' -b "$TMP/d" "$API$P/renders/$RID/image"); expect "render image png ($CODE)" "$([[ $CODE == '200 image/png' ]] && echo true)"

echo "== budget"
call d GET $P/estimates | jq -e '.non_binding==true and (.items|length>0)' >/dev/null; check estimates 200
call d PUT "$P/estimates/overrides/furn:sofa-3" '{"qty":2}' | jq -e '[.items[]|select(.item_key=="furn:sofa-3")][0].qty==2' >/dev/null; check "estimate override" 200
call d POST $P/estimates/items '{"label":"Painter","qty":1,"unit":"pcs","unit_low":300,"unit_high":600}' >/dev/null; check "manual item" 201
call d GET $P/shopping-list | jq -e '.retailer==null' >/dev/null; check "shopping list" 200

echo "== collaboration + invite"
call d POST $P/comments '{"body":"Move the sofa?","element_id":"f1"}' >/dev/null; check comment 201
INV=$(call d POST /invitations "{\"role\":\"client\",\"project_id\":\"$PID\"}"); check "invite create" 201
TOKEN=$(echo "$INV" | jq -r .token)
call x GET "/public/invitations/$TOKEN" | jq -e '.valid==true' >/dev/null; check "invite lookup" 200
call c POST "/public/invitations/$TOKEN/accept" "{\"email\":\"cli$RUN@example.com\",\"password\":\"password123\",\"display_name\":\"Chris Client\"}" >/dev/null; check "invite accept" 200
call x POST "/public/invitations/$TOKEN/accept" "{\"email\":\"cli2$RUN@example.com\",\"password\":\"password123\"}" >/dev/null; check "invite single use" 410
CID=$(call d GET $P | jq -r '.people[]|select(.role=="client")|.id'); check "project people" 200
TID=$(call d POST $P/tasks "{\"title\":\"Choose sofa fabric\",\"assignee_id\":\"$CID\"}" | jq -r .id); check "task create" 201
call c PATCH $P/tasks/$TID '{"status":"done"}' >/dev/null; check "client updates task" 200
call c POST $P/messages '{"body":"Looks great!"}' >/dev/null; check "client message" 201
call d GET $P/messages | jq -e '.messages|length==1' >/dev/null; check "designer reads messages" 200
call c GET /studio/audit >/dev/null; check "client cannot read audit" 403
call c POST /projects '{"name":"x"}' >/dev/null; check "client cannot create project" 403

echo "== studio join with guest geometry"
J=$(call g POST "/public/studios/$SLUG/join" "{\"email\":\"guest$RUN@example.com\",\"password\":\"password123\",\"project_name\":\"Guest plan\",\"geometry\":$GEO}"); check "join studio" 201
GP=$(echo "$J" | jq -r .project.id)
call g GET /projects/$GP/plan | jq -e '.current_version.geometry.walls|length==4' >/dev/null; check "guest geometry saved" 200
call g GET $P >/dev/null; check "other client cannot see project" 404

echo "== dossier + audit"
D=$(call d POST $P/dossiers '{"note":"First concept"}'); check "dossier create" 201
DIRECT=1 CODE=$(curl -s -o "$TMP/dos" -w '%{http_code}' -b "$TMP/d" "$API$(echo "$D" | jq -r .html_url)"); check "dossier html" 200
call c GET "$(echo "$D" | jq -r .html_url)" >/dev/null; check "client opens dossier" 200
call d GET '/studio/audit?limit=5' | jq -e '.events|length==5' >/dev/null; check "audit log" 200
call d POST /auth/logout >/dev/null; check logout 200
call d GET /auth/me >/dev/null; check "me after logout" 401

echo "passed $PASS, failed $FAIL"
[[ $FAIL == 0 ]]
