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

echo "=== 3b. Guard PIN sign-in ==="
GUARD_ID=$(firstid "$D/u1.json")
needid "guard id" "$GUARD_ID"
# The name-picker lists only active security staff, id + name only.
curl -s "$API/auth/gate-users" > "$D/gu.json"
grep -q '"name":"Guard Ravi"' "$D/gu.json" && ok "picker lists the guard" || bad "picker" "$(cat "$D/gu.json")"
grep -q 'Admin Meena' "$D/gu.json" && bad "picker excludes admins" "admins listed" || ok "picker excludes admins"

# Guard sets a PIN (authenticated by password).
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -c "$D/g.txt" -X POST "$API/auth/pin" -H 'Content-Type: application/json' -d '{"newPin":"482913"}')
check "guard sets a PIN" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -c "$D/g.txt" -X POST "$API/auth/pin" -H 'Content-Type: application/json' -d '{"newPin":"111111","currentPin":"482913"}')
check "all-same PIN rejected" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -c "$D/g.txt" -X POST "$API/auth/pin" -H 'Content-Type: application/json' -d '{"newPin":"123456","currentPin":"482913"}')
check "sequential PIN rejected" "$code" "400"
curl -s "$API/auth/gate-users" | grep -q '"has_pin":true' && ok "picker marks the guard as having a PIN" || bad "has_pin" ""

# Wrong PIN fails; correct PIN signs in and can use the gate.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$GUARD_ID\",\"pin\":\"000000\"}")
check "wrong PIN rejected" "$code" "401"
code=$(curl -s -o "$D/pinlogin.json" -c "$D/gpin.txt" -w '%{http_code}' -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$GUARD_ID\",\"pin\":\"482913\"}")
check "correct PIN signs in" "$code" "200"
grep -q '"role":"SECURITY"' "$D/pinlogin.json" && ok "PIN login returns the guard" || bad "pin login user" "$(cat "$D/pinlogin.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/gpin.txt" "$API/visits/today")
check "PIN session can use the gate" "$code" "200"

# Changing an existing PIN requires the current one.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -c "$D/g.txt" -X POST "$API/auth/pin" -H 'Content-Type: application/json' -d '{"newPin":"736251","currentPin":"999999"}')
check "change PIN with wrong current rejected" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -c "$D/g.txt" -X POST "$API/auth/pin" -H 'Content-Type: application/json' -d '{"newPin":"736251","currentPin":"482913"}')
check "change PIN with correct current accepted" "$code" "200"

# A PIN is a guard credential — admins cannot set one.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" -c "$D/a1.txt" -X POST "$API/auth/pin" -H 'Content-Type: application/json' -d '{"newPin":"445566"}')
check "admin cannot set a PIN" "$code" "400"

echo "--- a pre-pepper PIN still works and is upgraded in place ---"
# The guards already using PINs in production have un-peppered hashes. If those
# stopped verifying they would be locked out of their own gate, so prove the
# legacy path works and self-heals rather than assuming it.
mk "Legacy Guard" legacyguard guardpass123 SECURITY > "$D/leg.json"
LEG_ID=$(firstid "$D/leg.json")
needid "legacy guard id" "$LEG_ID"
# Write a raw bcrypt hash exactly as the pre-pepper code did.
LEGHASH=$(cd $ROOT/server && node -e "console.log(require('bcryptjs').hashSync('571394',12))")
psql -qtAX -d "$DB" -c "UPDATE users SET pin_hash='$LEGHASH', pin_set_at=now() WHERE id='$LEG_ID'" > /dev/null
FMT_BEFORE=$(psql -qtAX -d "$DB" -c "SELECT left(pin_hash,3) FROM users WHERE id='$LEG_ID'")
[ "$FMT_BEFORE" = '$2a' ] && ok "seeded a legacy (un-peppered) PIN hash" || bad "legacy seed" "got $FMT_BEFORE"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$LEG_ID\",\"pin\":\"571394\"}")
check "legacy PIN still signs in" "$code" "200"
FMT_AFTER=$(psql -qtAX -d "$DB" -c "SELECT left(pin_hash,3) FROM users WHERE id='$LEG_ID'")
[ "$FMT_AFTER" = 'p1$' ] && ok "legacy hash upgraded to peppered on sign-in" || bad "pin rehash" "got $FMT_AFTER"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$LEG_ID\",\"pin\":\"571394\"}")
check "same PIN still works after the upgrade" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$LEG_ID\",\"pin\":\"000000\"}")
check "wrong PIN still rejected after the upgrade" "$code" "401"

echo "--- lockout (on a separate guard, so it does not affect others) ---"
mk "Lock Guard" lockguard guardpass123 SECURITY > "$D/lg.json"
LOCK_ID=$(firstid "$D/lg.json")
needid "lock guard id" "$LOCK_ID"
login lockguard guardpass123 "$D/lgc.txt" > /dev/null
curl -s -o /dev/null -b "$D/lgc.txt" -c "$D/lgc.txt" -X POST "$API/auth/pin" -H 'Content-Type: application/json' -d '{"newPin":"246803"}'
for i in 1 2 3 4; do
  curl -s -o /dev/null -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$LOCK_ID\",\"pin\":\"000000\"}"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$LOCK_ID\",\"pin\":\"000000\"}")
check "PIN locks after 5 wrong tries" "$code" "429"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$LOCK_ID\",\"pin\":\"246803\"}")
check "correct PIN refused while locked" "$code" "429"

echo "--- superadmin reset (restore access without impersonation) ---"
code=$(curl -s -o "$D/reset.json" -w '%{http_code}' -b "$D/su.txt" -X POST "$API/admin/users/$LOCK_ID/reset-pin")
check "superadmin resets a locked guard" "$code" "200"
TEMP=$(sed -n 's/.*"tempPin":"\([0-9]*\)".*/\1/p' "$D/reset.json")
[ -n "$TEMP" ] && ok "reset returns a one-time PIN" || bad "temp pin" "$(cat "$D/reset.json")"
code=$(curl -s -o "$D/tl.json" -c "$D/temp.txt" -w '%{http_code}' -X POST "$API/auth/login-pin" -H 'Content-Type: application/json' -d "{\"userId\":\"$LOCK_ID\",\"pin\":\"$TEMP\"}")
check "temp PIN signs in after reset (lock cleared)" "$code" "200"
grep -q '"must_change_pin":true' "$D/tl.json" && ok "temp PIN forces a change" || bad "must_change_pin" "$(cat "$D/tl.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/su.txt" -X POST "$API/admin/users/$ADMIN1_ID/reset-pin")
check "cannot reset an admin's PIN" "$code" "400"

echo "--- a temp-PIN session is walled off until the PIN is replaced ---"
# The superadmin knows the temporary PIN, so a session opened with it must not be
# able to act as the guard. Enforced at the API, not just in the React client.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/temp.txt" "$API/visits/today")
check "temp-PIN session blocked from the gate" "$code" "403"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/temp.txt" -X POST "$API/visits" -F "full_name=Should Not Work" -F "from_type=PRIVATE")
check "temp-PIN session cannot log a visit" "$code" "403"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/temp.txt" "$API/auth/me")
check "temp-PIN session can still read its own identity" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/temp.txt" -c "$D/temp.txt" -X POST "$API/auth/pin" -H 'Content-Type: application/json' -d '{"newPin":"418362"}')
check "temp-PIN session can set a real PIN" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/temp.txt" "$API/visits/today")
check "gate opens once a real PIN is set" "$code" "200"

echo "--- a credential change ends other sessions ---"
# Two independent sessions for the same admin; changing the password from one
# must invalidate the other, or a stolen session survives the victim's response.
login admin2 adminpass123 "$D/rev1.txt" > /dev/null
login admin2 adminpass123 "$D/rev2.txt" > /dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/rev2.txt" "$API/approvals/pending")
check "second session works before the change" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/rev1.txt" -c "$D/rev1.txt" -X POST "$API/auth/change-password" \
  -H 'Content-Type: application/json' -d '{"currentPassword":"adminpass123","newPassword":"adminpass456"}')
check "password changed" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/rev2.txt" "$API/approvals/pending")
check "other session is revoked" "$code" "401"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/rev1.txt" "$API/approvals/pending")
check "the session that made the change stays signed in" "$code" "200"
# Put the password back so later sections still authenticate.
curl -s -o /dev/null -b "$D/rev1.txt" -c "$D/rev1.txt" -X POST "$API/auth/change-password" \
  -H 'Content-Type: application/json' -d '{"currentPassword":"adminpass456","newPassword":"adminpass123"}'
login admin2 adminpass123 "$D/a2.txt" > /dev/null

echo "--- failures that used to be invisible ---"
# Deactivated account, correct password.
mk "Ghost User" ghost ghostpass123 ADMIN > "$D/gh.json"
GHOST_ID=$(firstid "$D/gh.json")
needid "ghost id" "$GHOST_ID"
curl -s -o /dev/null -b "$D/su.txt" -X PATCH "$API/admin/users/$GHOST_ID" -H 'Content-Type: application/json' -d '{"is_active":false}'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" -H 'Content-Type: application/json' -d '{"username":"ghost","password":"ghostpass123"}')
check "deactivated account cannot log in" "$code" "403"
curl -s -b "$D/su.txt" "$API/admin/users/$GHOST_ID/auth-events" | grep -q 'account_inactive' \
  && ok "sign-in against a deactivated account is logged" || bad "inactive log" ""
# An attempt made while the PIN is locked.
LOCKED=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM auth_events e JOIN users u ON u.id=e.user_id WHERE u.username='lockguard' AND e.detail->>'reason'='locked'")
[ "$LOCKED" -ge 1 ] && ok "attempts during a lock are logged ($LOCKED)" || bad "locked-attempt log" "got $LOCKED"
# A passkey presented and rejected.
curl -s -o /dev/null -X POST "$API/auth/webauthn/login/options"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/webauthn/login/verify" \
  -H 'Content-Type: application/json' -d '{"credential":{"id":"bogus-credential-id","response":{}}}')
[ "$code" = "400" ] || [ "$code" = "401" ] && ok "unknown passkey rejected ($code)" || bad "passkey reject" "got $code"
WAF=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM auth_events WHERE event='LOGIN_FAILED' AND method='WEBAUTHN'")
[ "$WAF" -ge 1 ] && ok "failed passkey attempt is logged ($WAF)" || bad "webauthn fail log" "got $WAF"

echo "--- auth audit log ---"
curl -s -b "$D/su.txt" "$API/admin/users/$GUARD_ID/auth-events" > "$D/ae.json"
grep -q '"event":"PIN_SET"' "$D/ae.json" && ok "PIN_SET recorded" || bad "pin_set log" "$(head -c 300 "$D/ae.json")"
grep -q '"event":"LOGIN"' "$D/ae.json" && ok "LOGIN recorded" || bad "login log" ""
curl -s -b "$D/su.txt" "$API/admin/users/$LOCK_ID/auth-events" | grep -q '"event":"PIN_RESET"' && ok "PIN_RESET recorded with actor" || bad "reset log" ""
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" "$API/admin/users/$GUARD_ID/auth-events")
check "guard cannot read the audit log" "$code" "403"
OUT=$(psql -qtAX -d "$DB" -c "DELETE FROM auth_events WHERE event='LOGIN_FAILED'" 2>&1)
echo "$OUT" | grep -q "append-only" && ok "auth_events DELETE blocked by database" || bad "auth delete guard" "$OUT"

echo "--- global sign-in ledger + tripwires ---"
curl -s -b "$D/su.txt" "$API/admin/auth-events?limit=200" > "$D/gae.json"
grep -q '"events"' "$D/gae.json" && ok "global auth-event feed returns" || bad "global feed" "$(head -c 200 "$D/gae.json")"
grep -q '"actor_name"' "$D/gae.json" && ok "feed names the actor" || bad "feed actor" ""
# The filtered view must hide routine sign-ins and keep the concerning ones.
curl -s -b "$D/su.txt" "$API/admin/auth-events?concerning=1&limit=200" > "$D/gac.json"
grep -q '"event":"LOGIN"' "$D/gac.json" && bad "concerning filter" "plain LOGIN leaked into filtered view" || ok "filtered view excludes routine sign-ins"
grep -q '"event":"LOGIN_FAILED"\|"event":"PIN_RESET"' "$D/gac.json" && ok "filtered view keeps failures and resets" || bad "concerning content" ""
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" "$API/admin/auth-events")
check "admin cannot read the global ledger" "$code" "403"
# Locking a PIN and resetting one both alert the superadmins.
LOCKN=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.type='SECURITY_PIN_LOCKED' AND u.role='SUPERADMIN'")
[ "$LOCKN" -ge 1 ] && ok "PIN lock alerts the superadmin ($LOCKN)" || bad "lock alert" "got $LOCKN"
RESETN=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.type='SECURITY_PIN_RESET' AND u.role='SUPERADMIN'")
[ "$RESETN" -ge 1 ] && ok "PIN reset alerts the superadmin ($RESETN)" || bad "reset alert" "got $RESETN"
GUARDN=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.type LIKE 'SECURITY_%' AND u.role<>'SUPERADMIN'")
check "security alerts go to superadmins only" "$GUARDN" "0"

echo "=== 3c. Passkeys (biometric) — endpoint wiring ==="
# The ceremony itself needs a real authenticator; here we prove the endpoints are
# present, correctly gated, and returning a challenge.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/webauthn/register/options")
check "register options needs auth" "$code" "401"
# A guard cannot register biometric (PIN is their credential).
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/auth/webauthn/register/options")
check "guard cannot register a passkey" "$code" "400"
# An admin gets registration options with a challenge.
curl -s -b "$D/a1.txt" -X POST "$API/auth/webauthn/register/options" > "$D/waro.json"
grep -q '"challenge"' "$D/waro.json" && ok "admin gets registration options" || bad "wa reg options" "$(head -c 200 "$D/waro.json")"
# Passwordless login options are public and carry a challenge.
curl -s -X POST "$API/auth/webauthn/login/options" > "$D/walo.json"
grep -q '"challenge"' "$D/walo.json" && ok "login options carry a challenge" || bad "wa login options" "$(head -c 200 "$D/walo.json")"
# Device list is per-user and starts empty.
curl -s -b "$D/a1.txt" "$API/auth/webauthn/devices" > "$D/wad.json"
grep -q '"devices":\[\]' "$D/wad.json" && ok "admin has no devices yet" || bad "wa devices" "$(cat "$D/wad.json")"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/auth/webauthn/devices")
check "device list needs auth" "$code" "401"

echo "=== 4. Create visit with companions ==="
node -e "
const sharp=require('$ROOT/server/node_modules/sharp');
(async()=>{for(const [n,c] of [['p','#c33'],['m1','#3c3'],['m2','#33c']])
 await sharp({create:{width:800,height:1000,channels:3,background:c}}).jpeg().toFile('$D/'+n+'.jpg');})()
"
code=$(curl -s -o "$D/visit.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Suresh Kumar" -F "phone=9876543210" \
  -F "purpose=Loan enquiry" -F "from_type=COMPANY" -F "from_detail=Kiara Global Services" -F "host_admin_id=$ADMIN1_ID" \
  -F 'companions=[{"name":"Lakshmi"},{"name":"Arun"}]' \
  -F "companion_photos=@$D/m1.jpg" -F "companion_photos=@$D/m2.jpg")
check "visit created" "$code" "201"
VISIT_ID=$(firstid "$D/visit.json")
needid "visit id captured" "$VISIT_ID"
grep -q '"status":"PENDING"' "$D/visit.json" && ok "visit is PENDING" || bad "visit PENDING" "$(head -c 200 "$D/visit.json")"
grep -q '"companion_count":2' "$D/visit.json" && ok "2 companions attached" || bad "companions" "$(head -c 300 "$D/visit.json")"
grep -q '"from_type":"COMPANY"' "$D/visit.json" && ok "from_type stored" || bad "from_type" "$(head -c 500 "$D/visit.json")"
grep -q '"from_detail":"Kiara Global Services"' "$D/visit.json" && ok "from_detail stored" || bad "from_detail" "$(head -c 500 "$D/visit.json")"
grep -q '"from_display":"Kiara Global Services"' "$D/visit.json" && ok "from_display computed" || bad "from_display" "$(head -c 500 "$D/visit.json")"

# Company must name which company; Government likewise. Private need not.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Missing Detail" -F "from_type=COMPANY" -F "host_name=Someone")
check "company without detail rejected" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Bad Type" -F "from_type=NONSENSE" -F "host_name=Someone")
check "invalid from_type rejected" "$code" "400"
code=$(curl -s -o "$D/vpriv.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Private Person" -F "from_type=PRIVATE" -F "host_name=Reception")
check "private without detail accepted" "$code" "201"
grep -q '"from_display":"Private"' "$D/vpriv.json" && ok "private shows as Private" || bad "private display" "$(head -c 400 "$D/vpriv.json")"
code=$(curl -s -o "$D/vgov.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Officer Rao" -F "from_type=GOVERNMENT" -F "from_detail=Income Tax Dept" -F "host_name=MD Office")
check "government with detail accepted" "$code" "201"
grep -q '"from_display":"Income Tax Dept"' "$D/vgov.json" && ok "government display is the entity" || bad "gov display" "$(head -c 400 "$D/vgov.json")"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "full_name=No Photo" -F "host_name=Someone")
check "photo required" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Bad Phone" -F "phone=12345" -F "host_name=Someone")
check "invalid phone rejected" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=No Host" -F "from_type=PRIVATE")
check "host required" "$code" "400"
# Visiting-from is mandatory for every visitor.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=No From" -F "host_name=Someone")
check "visiting-from is required" "$code" "400"

echo "=== 5. Repeat visitor lookup ==="
curl -s -b "$D/g.txt" "$API/visitors/lookup?phone=9876543210" > "$D/lk.json"
grep -q '"found":true' "$D/lk.json" && ok "repeat visitor found" || bad "lookup" "$(cat "$D/lk.json")"
grep -q 'Suresh Kumar' "$D/lk.json" && ok "prefill has name" || bad "prefill name" "$(cat "$D/lk.json")"
grep -q '"from_type":"COMPANY"' "$D/lk.json" && ok "prefill has from_type" || bad "prefill from_type" "$(cat "$D/lk.json")"
grep -q 'Kiara Global Services' "$D/lk.json" && ok "prefill has from_detail" || bad "prefill from_detail" "$(cat "$D/lk.json")"
curl -s -b "$D/g.txt" "$API/visitors/lookup?phone=9999999999" > "$D/lk2.json"
grep -q '"found":false' "$D/lk2.json" && ok "unknown phone returns not found" || bad "unknown phone" "$(cat "$D/lk2.json")"

echo "=== 5b. Real-time SSE ==="
# Open an admin's event stream in the background, create a visit as security,
# and confirm the admin's stream receives the live event within a second.
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/events"); check "SSE requires auth" "$code" "401"

: > "$D/sse.log"
curl -s -N -b "$D/a1.txt" -H 'Accept: text/event-stream' --max-time 6 "$API/events" > "$D/sse.log" 2>/dev/null &
SSE_PID=$!
sleep 1  # let the stream connect and register its listener
curl -s -o /dev/null -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Live Ping" -F "from_type=PRIVATE" -F "host_admin_id=$ADMIN1_ID"
# Give the event a moment to travel, then decide it to emit a second event type.
sleep 1
LIVE_ID=$(psql -qtAX -d "$DB" -c "SELECT v.id FROM visits v JOIN visitors vis ON vis.id=v.visitor_id WHERE vis.full_name='Live Ping' ORDER BY v.created_at DESC LIMIT 1")
curl -s -o /dev/null -b "$D/a1.txt" -X POST "$API/visits/$LIVE_ID/approve" 2>/dev/null
sleep 1
wait $SSE_PID 2>/dev/null
grep -q 'event: approvals_changed' "$D/sse.log" && ok "admin stream got approvals_changed live" || bad "sse approvals" "$(head -c 200 "$D/sse.log")"
grep -q 'event: notification' "$D/sse.log" && ok "admin stream got notification live" || bad "sse notification" "$(head -c 200 "$D/sse.log")"

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
  -F "photo=@$D/p.jpg" -F "full_name=Walk In" -F "from_type=PRIVATE" -F "host_name=Accounts Desk" -F "purpose=Delivery")
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
curl -s -b "$D/su.txt" "$API/admin/visits?q=Kiara" | grep -q "$VISIT_ID" && ok "search by from-detail" || bad "search from-detail" ""
curl -s -b "$D/su.txt" "$API/admin/visits?approved_by=$ADMIN1_ID" > "$D/fa.json"
grep -q '"total"' "$D/fa.json" && ok "approved_by filter accepted" || bad "approved_by" ""
curl -s -b "$D/su.txt" "$API/admin/report/daily?format=csv" > "$D/r.csv"
head -1 "$D/r.csv" | grep -q 'Visit ID' && ok "CSV export has header" || bad "csv" "$(head -1 "$D/r.csv")"
grep -q 'Suresh Kumar' "$D/r.csv" && ok "CSV contains visit rows" || bad "csv rows" ""
head -1 "$D/r.csv" | grep -q 'Visiting From' && ok "CSV has Visiting From column" || bad "csv from header" "$(head -1 "$D/r.csv")"
grep -q 'Kiara Global Services' "$D/r.csv" && ok "CSV includes from-detail value" || bad "csv from value" ""
grep -q 'Income Tax Dept' "$D/r.csv" && ok "CSV includes a government entity" || bad "csv gov value" ""
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/a1.txt" "$API/admin/report/daily"); check "admin blocked from reports" "$code" "403"

echo "=== 16. Notifications ==="
# Fresh visit so the notification assertions are not entangled with earlier ones.
code=$(curl -s -o "$D/v3.json" -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits" \
  -F "photo=@$D/p.jpg" -F "full_name=Notify Test" -F "purpose=Meeting" -F "from_type=COMPANY" -F "from_detail=Acme Corp" -F "host_admin_id=$ADMIN1_ID")
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

echo "--- check-out notifies the host admin ---"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$D/g.txt" -X POST "$API/visits/$V3/check-out")
check "check-out for notification test" "$code" "200"
sleep 1
N_OUT=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND n.type='VISIT_CHECKED_OUT' AND u.username='admin1'")
N_OUT_OTHER=$(psql -qtAX -d "$DB" -c "SELECT count(*) FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.visit_id='$V3' AND n.type='VISIT_CHECKED_OUT' AND u.username='admin2'")
check "host admin notified of check-out" "$N_OUT" "1"
check "non-host admin not notified of check-out" "$N_OUT_OTHER" "0"

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
