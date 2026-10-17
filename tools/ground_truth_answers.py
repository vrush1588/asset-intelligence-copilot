import json, os, sys, re, collections
from datetime import datetime, date, timedelta

# Usage: python -I ground_truth_answers.py <dataset-root> [--today YYYY-MM-DD]
ARGS = [a for i, a in enumerate(sys.argv[1:]) if a != "--today" and (i == 0 or sys.argv[i] != "--today")]
ROOT = ARGS[0]
A = os.path.join(ROOT, "assets")

def _default_today(root):
    # Day after the latest inspection, the same default the copilot uses.
    latest = ""
    adir = os.path.join(root, "assets")
    for w in os.listdir(adir):
        f = os.path.join(adir, w, "inspections.jsonl")
        if os.path.exists(f):
            for line in open(f, encoding="utf-8"):
                if line.strip():
                    latest = max(latest, json.loads(line)["inspected_at"][:10])
    return date.fromisoformat(latest) + timedelta(days=1)

TODAY = date.fromisoformat(sys.argv[sys.argv.index("--today") + 1]) if "--today" in sys.argv else _default_today(ROOT)
print(f"today = {TODAY}")
THR = {"T200": 15.0, "T350": 20.0}

def jl(p):
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []
def dt(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))
def dd(s): return dt(s).date()

areas = json.load(open(os.path.join(ROOT, "fleet/areas.json")))
users = {u["user_id"]: u["name"] for u in json.load(open(os.path.join(ROOT, "fleet/users.json")))["users"]}
byname = {a["name"]: a for a in areas["areas"]}
W = {}
for w in sorted(os.listdir(A)):
    p = os.path.join(A, w)
    W[w] = dict(meta=json.load(open(f"{p}/metadata.json")), ins=jl(f"{p}/inspections.jsonl"),
                mnt=jl(f"{p}/maintenance.jsonl"), reg=jl(f"{p}/regulatory-events.jsonl"), ctx=jl(f"{p}/context.jsonl"))
corr = {c["inspection_id"] for x in W.values() for c in x["ctx"] if c["note_type"] == "correction"}

def producing(w, i): return (i["wellhead_temp_c"] - i["ambient_temp_c"]) >= THR[W[w]["meta"]["well_type"]]
def real_spills(w): return [i for i in W[w]["ins"] if i["spill_detected"] and i["inspection_id"] not in corr]
def downtime(w, a, b): return 7 * sum(1 for i in W[w]["ins"] if a <= dd(i["inspected_at"]) <= b and not producing(w, i))

print("== Q1"); i = W["WELL-0001"]["ins"][-1]
print(i["inspection_id"], i["inspected_at"], i["method"], users[i["inspector_user_id"]], round(i["wellhead_temp_c"]-i["ambient_temp_c"],1), producing("WELL-0001", i), W["WELL-0001"]["meta"]["recorded_status"])
print("count ins WELL-0001:", len(W["WELL-0001"]["ins"]))

print("== Q2")
for w in byname["Northeast Block 8"]["asset_ids"]:
    i = W[w]["ins"][-1]
    if not producing(w, i):
        openm = [m["maintenance_id"]+" "+m["issue"]+" "+m["started_at"][:10] for m in W[w]["mnt"] if dd(m["completed_at"]) > TODAY or dd(m["started_at"]) > dd(i["inspected_at"]) - timedelta(days=30)]
        notes = [c["note_id"]+": "+c["text"] for c in W[w]["ctx"] if not c.get("valid_to") or c["valid_to"] >= "2026-09-01"]
        print(w, W[w]["meta"]["well_type"], i["inspected_at"][:10], round(i["wellhead_temp_c"]-i["ambient_temp_c"],1), W[w]["meta"]["recorded_status"], repr(i["notes"]), openm, notes)

print("== Q2 all areas: wells not producing now")
for a in areas["areas"]:
    ws = [w for w in a["asset_ids"] if not producing(w, W[w]["ins"][-1])]
    print(a["name"], ws)

print("== Q3")
for i in W["WELL-0001"]["ins"][-13:]:
    print(i["inspected_at"][:10], i["ambient_temp_c"], i["wellhead_temp_c"], producing("WELL-0001", i))

print("== Q4")
s = real_spills("WELL-0001"); print(len(s), round(sum(i["spill_est_volume_bbl"] for i in s), 1), [(i["inspected_at"][:10], i["spill_est_volume_bbl"]) for i in s])
print("detections", sum(i["spill_detected"] for i in W["WELL-0001"]["ins"]))

print("== Q5")
print(downtime("WELL-0001", date(2025,1,1), date(2025,12,31)), [i["inspected_at"][:10] for i in W["WELL-0001"]["ins"] if dd(i["inspected_at"]).year == 2025 and not producing("WELL-0001", i)])

print("== Q6")
a, b = date(2026,6,16), TODAY
r = sorted(((downtime(w, a, b), w, W[w]["meta"]["well_type"]) for w in byname["Northeast Block 7"]["asset_ids"]), reverse=True)[:6]; print(r)

print("== Q7")
for w in byname["Northeast Block 8"]["asset_ids"]:
    for i in real_spills(w):
        if dd(i["inspected_at"]) >= TODAY - timedelta(days=90):
            print(w, i["inspected_at"][:10], i["spill_est_volume_bbl"], W[w]["meta"]["location"])
print(" (boundary 90d start:", TODAY - timedelta(days=90), ")")

print("== Q8")
for ar in areas["areas"]:
    c = collections.Counter(dd(i["inspected_at"]).month for w in ar["asset_ids"] for i in real_spills(w) if dd(i["inspected_at"]).year == 2026)
    raw = collections.Counter(dd(i["inspected_at"]).month for w in ar["asset_ids"] for i in W[w]["ins"] if i["spill_detected"] and dd(i["inspected_at"]).year == 2026)
    print(ar["name"], [c[m] for m in range(1, 11)], sum(c.values()), "raw", sum(raw.values()))

print("== Q9 WELL-0001 flowline corrective last 12mo / RC-02")
for m in W["WELL-0001"]["mnt"]:
    if dd(m["started_at"]) >= TODAY - timedelta(days=365):
        print(m["maintenance_id"], m["started_at"][:10], m["maintenance_type"], m["equipment_kind"], m["issue"], m["report_file"])

print("== Q10 SW-24 spills 90d containment")
for w in byname["Southwest Block 24"]["asset_ids"]:
    for i in real_spills(w):
        if dd(i["inspected_at"]) >= TODAY - timedelta(days=90):
            rep = [m for m in W[w]["mnt"] if m["triggered_by_inspection_id"] == i["inspection_id"]]
            hrs = None
            for m in rep:
                if m["report_file"]:
                    t = open(os.path.join(A, w, m["report_file"]), encoding="utf-8").read()
                    h = re.search(r"contained (?:about )?([\d.]+) hours", t); hrs = h and float(h.group(1))
            print(w, i["inspection_id"], i["inspected_at"][:10], i["spill_est_volume_bbl"], [m["maintenance_id"] for m in rep], hrs, "BREACH" if hrs and hrs > 4 else "")

print("== Containment >4h fleet-wide, any date; also no 'contained' phrase")
miss = 0; breach = []
for w in W:
    for i in real_spills(w):
        rep = [m for m in W[w]["mnt"] if m["triggered_by_inspection_id"] == i["inspection_id"] and m["report_file"]]
        if not rep: miss += 1; continue
        t = open(os.path.join(A, w, rep[0]["report_file"]), encoding="utf-8").read()
        h = re.search(r"contained (?:about )?([\d.]+) hours", t)
        if not h: print("  no containment phrase:", w, rep[0]["maintenance_id"], re.findall(r"[^.]*contain[^.]*\.", t)[:2])
        elif float(h.group(1)) > 4: breach.append((w, i["inspected_at"][:10], float(h.group(1))))
print("real spills w/o report:", miss, " SR-02 breaches:", len(breach), breach[-8:])

print("== Q11 repair cost 2026")
for w in ["WELL-0121", "WELL-0138", "WELL-0107"]:
    print(w, sum(m["cost_usd"]["total"] for m in W[w]["mnt"] if dd(m["started_at"]).year == 2026))

print("== Q12 WELL-0164 last ins")
i = W["WELL-0164"]["ins"][-1]; print(i["inspection_id"], i["ambient_temp_c"], i["wellhead_temp_c"], i["notes"], users[i["inspector_user_id"]], i["method"])
print("== Q13 WELL-0151")
i = next(i for i in W["WELL-0151"]["ins"] if i["inspection_id"] == "INS-0151-0201"); print(i["inspected_at"], i["spill_est_volume_bbl"], W["WELL-0151"]["reg"])
print(" +60d:", dd(i["inspected_at"]) + timedelta(days=60))

print("== Q14 pump jack RCA NE-07 (corrective, last 12 months)")
for w in byname["Northeast Block 7"]["asset_ids"]:
    n = sum(1 for m in W[w]["mnt"] if m["maintenance_type"] == "corrective" and m["equipment_kind"] == "pump_jack" and dd(m["started_at"]) > TODAY - timedelta(days=365))
    if n >= 2: print(w, W[w]["meta"]["well_type"], n)
print("== RCA trigger fleet-wide (>=3 same kind, 12 mo)")
for w in W:
    c = collections.Counter(m["equipment_kind"] for m in W[w]["mnt"] if m["maintenance_type"] == "corrective" and dd(m["started_at"]) > TODAY - timedelta(days=365))
    hits = {k: v for k, v in c.items() if v >= 3}
    if hits: print(" ", w, hits)

print("== Q15 NE-08 spills last 90d >=5 bbl")
print([(w, i["spill_est_volume_bbl"]) for w in byname["Northeast Block 8"]["asset_ids"] for i in real_spills(w) if dd(i["inspected_at"]) >= TODAY - timedelta(days=90) and i["spill_est_volume_bbl"] >= 4])
print("== Q17 WELL-0175 / Q18 WELL-0101")
i = W["WELL-0175"]["ins"][-1]; print(i["inspection_id"], users[i["inspector_user_id"]], round(i["wellhead_temp_c"]-i["ambient_temp_c"],1))
i = next(i for i in W["WELL-0101"]["ins"] if i["inspected_at"].startswith("2026-08-20")); print(i)
print([c for c in W["WELL-0101"]["ctx"]]); print([m["maintenance_id"] for m in W["WELL-0101"]["mnt"] if m["triggered_by_inspection_id"] == i["inspection_id"]])

print("== recorded_status vs latest inspection")
mism = [(w, W[w]["meta"]["recorded_status"], producing(w, W[w]["ins"][-1])) for w in W if (W[w]["meta"]["recorded_status"] == "active") != producing(w, W[w]["ins"][-1])]
print(len(mism), mism)
print("== downtime >14 consecutive days (>=3 consecutive non-producing inspections) in last 12 months")
for w in W:
    run = 0; best = 0
    for i in W[w]["ins"]:
        if dd(i["inspected_at"]) < TODAY - timedelta(days=365): continue
        run = run + 1 if not producing(w, i) else 0; best = max(best, run)
    if best >= 3: print(" ", w, best * 7)
print("== disagreement notes (non-correction mentioning an inspection id)")
for w in W:
    for c in W[w]["ctx"]:
        if c["note_type"] != "correction" and re.search(r"INS-\d{4}-\d{4}", c["text"]): print(" ", c["note_id"], users[c["author_user_id"]], c["text"][:110])
print("== operator_feedback notes")
for w in W:
    for c in W[w]["ctx"]:
        if c["note_type"] == "operator_feedback": print(" ", c)
print("== borderline deltas (|delta - thr| < 0.5)")
bl = [(w, i["inspection_id"], round(i["wellhead_temp_c"]-i["ambient_temp_c"],2)) for w in W for i in W[w]["ins"] if abs(i["wellhead_temp_c"]-i["ambient_temp_c"]-THR[W[w]["meta"]["well_type"]]) < 0.05]
print(len(bl), bl[:10])
print("== hot idle wellheads (>=45C, not producing):", sum(1 for w in W for i in W[w]["ins"] if i["wellhead_temp_c"] >= 45 and not producing(w, i)))
print("== T350 with delta in [15,20) (type-threshold trap):", sum(1 for w in W for i in W[w]["ins"] if W[w]["meta"]["well_type"]=="T350" and 15 <= i["wellhead_temp_c"]-i["ambient_temp_c"] < 20))
