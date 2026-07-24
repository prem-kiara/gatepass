#!/usr/bin/env bash
# End-to-end lifecycle test against a local GatePass instance.
set -uo pipefail
API=http://127.0.0.1:3040/api
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
D="${TMPDIR:-/tmp}/gatepass-e2e"
mkdir -p "$D"
DB="${GATEPASS_TEST_DB:-gatepass_dev}"
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1 -- $2"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
# An empty id silently turns every later `grep "$ID"` into a match-anything test,
# which reads as a pass. Abort instead.
needid(){ if [ -z "$2" ]; then bad "$1" "id is empty — cannot continue"; echo "ABORTED"; exit 1; fi; }
# First "id" in the payload = the top-level object's own id. A greedy sed would
# instead grab the last one, which for a visit is a companion's id.
firstid(){ grep -o '"id":"[^"]*"' "$1" | head -1 | cut -d'"' -f4; }

login() { # user pass cookiejar
  curl -s -c "$3" -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" -o "$D/login.json" -w '%{http_code}'
}

echo "=== 0. Fresh database ==="
pkill -f "node index.js" 2>/dev/null; sleep 1
dropdb --if-exists "$DB" && createdb "$DB"
( cd $ROOT/server && npm run migrate >/dev/null 2>&1 && npm run seed >/dev/null 2>&1 )
rm -rf $ROOT/photos
( cd $ROOT/server && node index.js > "$D/server.log" 2>&1 & )
sleep 3
curl -sf "$API/health" >/dev/null && ok "server healthy on fresh database" || { bad "startup" "$(tail -5 "$D/server.log")"; exit 1; }

echo "=== 1. Auth ==="
code=$(login superadmin localtest123 "$D/su.txt"); check "superadmin login" "$code" "200"
code=$(login superadmin wrongpass "$D/bad.txt"); check "wrong password rejected" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/approvals/pending"); check "unauthenticated blocked" "$code" "401"

echo "=== 2. Superadmin creates users ==="
mk(){ curl -s -b "$D/su.txt" -X POST "$API/admin/users" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$1\",\"username\":\"$2\",\"password\":\"$3\",\"role\":\"$4\"}"; }
mk "Guard Ravi" guard1 guardpass123 SECURITY > "$D/u1.json"
mk "Admin Meena" admin1 adminpass123 ADMIN > "$D/u2.json"
mk "Admin Kumar" admin2 adminpass123 ADMIN > "$D/u3.json"
grep -q '"role":"SECURITY"' "$D/u1.json" && ok "security created" || bad "security created" "$(cat "$D/u1.json")"
grep -q '"role":"ADMIN"' "$D/u2.json" && ok "admin1 created" || bad "admin1 created" "$(cat "$D/u2.json")"
ADMIN1_ID=$(firstid "$D/u2.json")
needid "admin1 id captured" "$ADMIN1_ID"

code=$(curl -s -o "$D/dup.json" -w '%{http_code}' -b "$D/su.txt" -X POST "$API/admin/users" \
  -H 'Content-Type: application/json' -d '{"name":"X","username":"guard1","password":"pass12345","role":"SECURITY"}')
check "duplicate username rejected" "$code" "400"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/su.txt" -X POST "$API/admin/users" \
  -H 'Content-Type: application/json' -d '{"name":"X","username":"shorty","password":"short","role":"SECURITY"}')
check "short password rejected" "$code" "400"

echo "=== 3. Role separation ==="
login guard1 guardpass123 "$D/g.txt" > /dev/null
login admin1 adminpass123 "$D/a1.txt" > /dev/null
login admin2 adminpass123 "$D/a2.txt" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" "$API/admin/users"); check "security blocked from admin API" "$code" "403"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" "$API/admin/users"); check "admin blocked from user mgmt" "$code" "403"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" "$API/visits/today"); check "admin blocked from gate log" "$code" "403"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" "$API/approvals/pending"); check "security blocked from approvals" "$code" "403"

echo "=== 4. Create visit with companions ==="
node -e "
const sharp=require('$ROOT/server/node_modules/sharp');
(async()=>{for(const [n,c] of [['p','#c33'],['m1','#3c3'],['m2','#33c']])
 await sharp({create:{width:800,height:1000,channels:3,background:c}}).jpeg().toFile('$D/'+n+'.jpg');})()
"
code=$(curl -s -o "$D/visit.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Suresh Kumar" -F "phone=9876543210" \
  -F "purpose=Loan enquiry" -F "host_admin_id=$ADMIN1_ID" \
  -F 'companions=[{"name":"Lakshmi"},{"name":"Arun"}]' \
  -F "companion_photos=@$D/m1.jpg" -F "companion_photos=@$D/m2.jpg")
check "visit created" "$code" "201"
VISIT_ID=$(firstid "$D/visit.json")
needid "visit id captured" "$VISIT_ID"
grep -q '"status":"PENDING"' "$D/visit.json" && ok "visit is PENDING" || bad "visit PENDING" "$(head -c 200 "$D/visit.json")"
grep -q '"companion_count":2' "$D/visit.json" && ok "2 companions attached" || bad "companions" "$(head -c 300 "$D/visit.json")"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "full_name=No Photo" -F "host_name=Someone")
check "photo required" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Bad Phone" -F "phone=12345" -F "host_name=Someone")
check "invalid phone rejected" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=No Host")
check "host required" "$code" "400"

echo "=== 5. Repeat visitor lookup ==="
curl -s -b "$D/g.txt" "$API/visitors/lookup?phone=9876543210" > "$D/lk.json"
grep -q '"found":true' "$D/lk.json" && ok "repeat visitor found" || bad "lookup" "$(cat "$D/lk.json")"
grep -q 'Suresh Kumar' "$D/lk.json" && ok "prefill has name" || bad "prefill name" "$(cat "$D/lk.json")"
curl -s -b "$D/g.txt" "$API/visitors/lookup?phone=9999999999" > "$D/lk2.json"
grep -q '"found":false' "$D/lk2.json" && ok "unknown phone returns not found" || bad "unknown phone" "$(cat "$D/lk2.json")"

echo "=== 6. Photo access control ==="
PHOTO=$(sed -n 's/.*"photo_path":"\([^"]*\)".*/\1/p' "$D/visit.json" | head -1)
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/photos/$PHOTO"); check "photo blocked when logged out" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" "$API/photos/$PHOTO"); check "photo served to admin" "$code" "200"
# --path-as-is stops curl from collapsing ../ before the request is even sent.
code=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' -b "$D/a1.txt" "$API/photos/..%2f..%2f..%2fetc%2fpasswd"); check "path traversal blocked" "$code" "400"

echo "=== 7. Shared queue visible to all admins ==="
curl -s -b "$D/a1.txt" "$API/approvals/pending" > "$D/p1.json"
curl -s -b "$D/a2.txt" "$API/approvals/pending" > "$D/p2.json"
grep -q "$VISIT_ID" "$D/p1.json" && ok "admin1 sees request" || bad "admin1 queue" "$(head -c 200 "$D/p1.json")"
grep -q "$VISIT_ID" "$D/p2.json" && ok "admin2 sees same request" || bad "admin2 queue" "$(head -c 200 "$D/p2.json")"
curl -s -b "$D/su.txt" "$API/approvals/pending" | grep -q "$VISIT_ID" && ok "superadmin sees request" || bad "superadmin queue" ""

echo "=== 8. Check-in before approval must fail ==="
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits/$VISIT_ID/check-in")
check "check-in blocked while PENDING" "$code" "409"

echo "=== 9. FIRST-APPROVAL-WINS RACE ==="
curl -s -o "$D/r1.json" -w '%{http_code}\n' -b "$D/a1.txt" -X POST "$API/visits/$VISIT_ID/approve" > "$D/c1.txt" &
curl -s -o "$D/r2.json" -w '%{http_code}\n' -b "$D/a2.txt" -X POST "$API/visits/$VISIT_ID/approve" > "$D/c2.txt" &
wait
C1=$(cat "$D/c1.txt"); C2=$(cat "$D/c2.txt")
echo "  (admin1 -> $C1, admin2 -> $C2)"
if { [ "$C1" = "200" ] && [ "$C2" = "409" ]; } || { [ "$C1" = "409" ] && [ "$C2" = "200" ]; }; then
  ok "exactly one admin won the race"
else bad "race" "got $C1 and $C2 (expected one 200 and one 409)"; fi
LOSER=$([ "$C1" = "409" ] && echo "$D/r1.json" || echo "$D/r2.json")
grep -q 'ALREADY_DECIDED' "$LOSER" && ok "loser told ALREADY_DECIDED" || bad "loser payload" "$(head -c 200 "$LOSER")"
grep -q '"approved_by_name"' "$LOSER" && ok "loser payload names the decider" || bad "loser decider" ""

DECIDER=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM visits WHERE id='$VISIT_ID' AND approved_by IS NOT NULL")
check "exactly one decision stamped" "$DECIDER" "1"
NEVT=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM visit_events WHERE visit_id='$VISIT_ID' AND action='APPROVED'")
check "exactly one APPROVED audit event" "$NEVT" "1"

echo "=== 10. Check-in / check-out ==="
code=$(curl -s -o "$D/ci.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits/$VISIT_ID/check-in")
check "check-in after approval" "$code" "200"
grep -q '"status":"INSIDE"' "$D/ci.json" && ok "status INSIDE" || bad "INSIDE" "$(head -c 200 "$D/ci.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits/$VISIT_ID/check-in")
check "double check-in rejected" "$code" "409"
code=$(curl -s -o "$D/co.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits/$VISIT_ID/check-out")
check "check-out" "$code" "200"
grep -q '"status":"CHECKED_OUT"' "$D/co.json" && ok "status CHECKED_OUT" || bad "CHECKED_OUT" ""

echo "=== 11. Audit trail ==="
curl -s -b "$D/su.txt" "$API/admin/visits/$VISIT_ID/events" > "$D/ev.json"
for a in CREATED APPROVED CHECKED_IN CHECKED_OUT; do
  grep -q "\"$a\"" "$D/ev.json" && ok "audit has $a" || bad "audit $a" "$(head -c 300 "$D/ev.json")"
done
grep -q 'Guard Ravi' "$D/ev.json" && ok "audit names the security guard" || bad "audit actor" ""

echo "=== 12. Append-only enforcement ==="
OUT=$(psql -qtAX -d "$DB" -c "UPDATE visit_events SET action='TAMPERED' WHERE visit_id='$VISIT_ID'" 2>&1)
echo "$OUT" | grep -q 'append-only' && ok "UPDATE on visit_events blocked" || bad "append-only update" "$OUT"
OUT=$(psql -qtAX -d "$DB" -c "DELETE FROM visit_events WHERE visit_id='$VISIT_ID'" 2>&1)
echo "$OUT" | grep -q 'append-only' && ok "DELETE on visit_events blocked" || bad "append-only delete" "$OUT"

echo "=== 13. Rejection with reason ==="
code=$(curl -s -o "$D/v2.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Walk In" -F "host_name=Accounts Desk" -F "purpose=Delivery")
check "second visit created (free-text host)" "$code" "201"
V2=$(firstid "$D/v2.json")
needid "second visit id captured" "$V2"
code=$(curl -s -o "$D/rej.json" -w '%{http_code}' -b "$D/a2.txt" -X POST "$API/visits/$V2/reject" \
  -H 'Content-Type: application/json' -d '{"reason":"No appointment"}')
check "reject" "$code" "200"
grep -q 'No appointment' "$D/rej.json" && ok "rejection reason stored" || bad "reason" ""
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits/$V2/check-in")
check "cannot check in a rejected visit" "$code" "409"

echo "=== 14. Admin history is per-user ==="
curl -s -b "$D/a2.txt" "$API/approvals/history" > "$D/h2.json"
grep -q "$V2" "$D/h2.json" && ok "admin2 sees own rejection" || bad "history own" ""
curl -s -b "$D/a1.txt" "$API/approvals/history" > "$D/h1.json"
grep -q "$V2" "$D/h1.json" && bad "history leak" "admin1 sees admin2's decision" || ok "admin1 does not see admin2's decision"

echo "=== 15. Console: dashboard, filters, CSV ==="
curl -s -b "$D/su.txt" "$API/admin/dashboard" > "$D/dash.json"
grep -q 'per_admin' "$D/dash.json" && ok "dashboard returns per-admin counts" || bad "dashboard" "$(head -c 200 "$D/dash.json")"
grep -q 'never_checked_out' "$D/dash.json" && ok "dashboard has never-checked-out list" || bad "ncо" ""
curl -s -b "$D/su.txt" "$API/admin/visits?status=REJECTED" > "$D/fv.json"
grep -q "$V2" "$D/fv.json" && ok "status filter works" || bad "status filter" ""
grep -q "$VISIT_ID" "$D/fv.json" && bad "status filter" "returned a non-rejected visit" || ok "status filter excludes others"
curl -s -b "$D/su.txt" "$API/admin/visits?q=Suresh" | grep -q "$VISIT_ID" && ok "search by name" || bad "search" ""
curl -s -b "$D/su.txt" "$API/admin/visits?approved_by=$ADMIN1_ID" > "$D/fa.json"
grep -q '"total"' "$D/fa.json" && ok "approved_by filter accepted" || bad "approved_by" ""
curl -s -b "$D/su.txt" "$API/admin/report/daily?format=csv" > "$D/r.csv"
head -1 "$D/r.csv" | grep -q 'Visit ID' && ok "CSV export has header" || bad "csv" "$(head -1 "$D/r.csv")"
grep -q 'Suresh Kumar' "$D/r.csv" && ok "CSV contains visit rows" || bad "csv rows" ""
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" "$API/admin/report/daily"); check "admin blocked from reports" "$code" "403"

echo "=== 16. Notifications ==="
# Fresh visit so the notification assertions are not entangled with earlier ones.
code=$(curl -s -o "$D/v3.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Notify Test" -F "purpose=Meeting" -F "host_admin_id=$ADMIN1_ID")
check "visit for notification test created" "$code" "201"
V3=$(firstid "$D/v3.json")
needid "third visit id captured" "$V3"

N_A1=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND n.type='VISIT_PENDING' AND u.username='admin1'")
N_A2=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND n.type='VISIT_PENDING' AND u.username='admin2'")
N_SU=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND n.type='VISIT_PENDING' AND u.username='superadmin'")
N_G=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND u.username='guard1'")
check "admin1 notified of new request" "$N_A1" "1"
check "admin2 notified of new request" "$N_A2" "1"
check "superadmin notified of new request" "$N_SU" "1"
check "guard not notified of own request" "$N_G" "0"

# Guard sees nothing yet; the API must be scoped per user.
curl -s -b "$D/g.txt" "$API/notifications" > "$D/ng.json"
grep -q '"Notify Test"' "$D/ng.json" && bad "scoping" "guard sees an admin notification" || ok "notification list is scoped per user"

echo "--- approve, then check the decision reaches the guard ---"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" -X POST "$API/visits/$V3/approve")
check "approve for notification test" "$code" "200"
sleep 1
N_GA=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND n.type='VISIT_APPROVED' AND u.username='guard1'")
check "guard notified of approval" "$N_GA" "1"

# The other admins' broadcast is now stale and must be resolved, not deleted.
RESOLVED=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications WHERE visit_id='$V3' AND type='VISIT_PENDING' AND resolved_at IS NOT NULL")
STILL=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications WHERE visit_id='$V3' AND type='VISIT_PENDING'")
check "stale broadcasts resolved" "$RESOLVED" "3"
check "resolved notifications still exist (nothing lost)" "$STILL" "3"

echo "--- check-in notifies the host admin only ---"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits/$V3/check-in")
check "check-in for notification test" "$code" "200"
sleep 1
N_HOST=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND n.type='VISIT_CHECKED_IN' AND u.username='admin1'")
N_OTHER=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND n.type='VISIT_CHECKED_IN' AND u.username='admin2'")
check "host admin notified of check-in" "$N_HOST" "1"
check "non-host admin not notified of check-in" "$N_OTHER" "0"

echo "--- history, unread count and read state ---"
curl -s -b "$D/a1.txt" "$API/notifications" > "$D/n1.json"
grep -q '"Notify Test' "$D/n1.json" && ok "history returns notifications" || bad "history" "$(head -c 200 "$D/n1.json")"
UNREAD=$(curl -s -b "$D/a1.txt" "$API/notifications/unread-count" | sed -n 's/.*"unread":\([0-9]*\).*/\1/p')
[ "$UNREAD" -ge 2 ] && ok "unread count reflects new notifications ($UNREAD)" || bad "unread count" "got $UNREAD"

NID=$(psql -qtAX -d "$DB" -c "SELECT n.id FROM notifications n JOIN users u ON u.id=n.user_id WHERE u.username='admin1' ORDER BY n.id DESC LIMIT 1")
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" -X POST "$API/notifications/$NID/read")
check "mark one notification read" "$code" "200"
# admin2 must not be able to touch admin1's notification.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a2.txt" -X POST "$API/notifications/$NID/read")
check "cannot mark another user's notification read" "$code" "404"

curl -s -b "$D/a1.txt" -X POST "$API/notifications/read-all" > /dev/null
UNREAD2=$(curl -s -b "$D/a1.txt" "$API/notifications/unread-count" | sed -n 's/.*"unread":\([0-9]*\).*/\1/p')
check "read-all clears the unread count" "$UNREAD2" "0"
TOTAL=$(curl -s -b "$D/a1.txt" "$API/notifications" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')
[ "$TOTAL" -ge 3 ] && ok "history retained after marking read ($TOTAL)" || bad "history retained" "got $TOTAL"

echo "--- nothing can be deleted ---"
OUT=$(psql -qtAX -d "$DB" -c "DELETE FROM notifications WHERE visit_id='$V3'" 2>&1)
echo "$OUT" | grep -q "permanent" && ok "DELETE on notifications blocked by database" || bad "delete guard" "$OUT"

echo "--- push subscription plumbing ---"
curl -s -b "$D/a1.txt" "$API/notifications/push/public-key" > "$D/pk.json"
grep -q '"enabled":true' "$D/pk.json" && ok "VAPID public key served" || bad "public key" "$(cat "$D/pk.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" -X POST "$API/notifications/push/subscribe" \
  -H 'Content-Type: application/json' \
  -d '{"subscription":{"endpoint":"https://fcm.googleapis.com/fcm/send/e2e-test-endpoint","keys":{"p256dh":"BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=","auth":"tBHItJI5svbpez7KI4CCXg=="}}}')
check "device subscription stored" "$code" "201"
SUBS=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fcm/send/e2e-test-endpoint'")
check "exactly one subscription row" "$SUBS" "1"
# Re-subscribing the same device must update, not duplicate.
curl -s -o /dev/null -b "$D/a1.txt" -X POST "$API/notifications/push/subscribe" \
  -H 'Content-Type: application/json' \
  -d '{"subscription":{"endpoint":"https://fcm.googleapis.com/fcm/send/e2e-test-endpoint","keys":{"p256dh":"BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=","auth":"tBHItJI5svbpez7KI4CCXg=="}}}' > /dev/null
SUBS2=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fcm/send/e2e-test-endpoint'")
check "re-subscribing same device does not duplicate" "$SUBS2" "1"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" -X POST "$API/notifications/push/unsubscribe" \
  -H 'Content-Type: application/json' -d '{"endpoint":"https://fcm.googleapis.com/fcm/send/e2e-test-endpoint"}')
check "unsubscribe" "$code" "200"

echo "=== 17. Deactivation cuts access immediately ==="
GID=$(psql -qtAX -d "$DB" -c "SELECT id FROM users WHERE username='guard1'")
curl -s -b "$D/su.txt" -X PATCH "$API/admin/users/$GID" -H 'Content-Type: application/json' -d '{"is_active":false}' > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" "$API/visits/today")
check "deactivated user's live session rejected" "$code" "401"
code=$(login guard1 guardpass123 "$D/g2.txt"); check "deactivated user cannot log in" "$code" "403"
SUID=$(psql -qtAX -d "$DB" -c "SELECT id FROM users WHERE username='superadmin'")
code=$(curl -s -o "$D/last.json" -w '%{http_code}' -b "$D/su.txt" -X PATCH "$API/admin/users/$SUID" \
  -H 'Content-Type: application/json' -d '{"is_active":false}')
check "last superadmin cannot be deactivated" "$code" "400"

echo
echo "================================"
echo "  PASSED: $PASS   FAILED: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ]
