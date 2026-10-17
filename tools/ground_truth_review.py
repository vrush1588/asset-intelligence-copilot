import json, os, sys, re, glob, collections
from datetime import datetime, date, timedelta

# Usage: python -I ground_truth_review.py <dataset-root> [--today YYYY-MM-DD]
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
    out = []
    if not os.path.exists(p): return out
    for i, line in enumerate(open(p, encoding="utf-8")):
        line = line.strip()
        if not line: continue
        try: out.append(json.loads(line))
        except Exception as e: print("BAD JSON", p, i, e)
    return out

def d(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))

areas = json.load(open(os.path.join(ROOT, "fleet/areas.json")))
users = {u["user_id"]: u for u in json.load(open(os.path.join(ROOT, "fleet/users.json")))["users"]}
area_of = {w: a["area_id"] for a in areas["areas"] for w in a["asset_ids"]}
aname = {a["area_id"]: a["name"] for a in areas["areas"]}

W = {}
issues = collections.defaultdict(list)
for wd in sorted(os.listdir(A)):
    p = os.path.join(A, wd)
    m = json.load(open(os.path.join(p, "metadata.json")))
    W[wd] = dict(meta=m, ins=jl(f"{p}/inspections.jsonl"), mnt=jl(f"{p}/maintenance.jsonl"),
                 reg=jl(f"{p}/regulatory-events.jsonl"), ctx=jl(f"{p}/context.jsonl"),
                 reports=set(os.listdir(f"{p}/maintenance-reports")) if os.path.isdir(f"{p}/maintenance-reports") else set())

# ---------- counts ----------
tot = collections.Counter()
for w, x in W.items():
    for k in ("ins", "mnt", "reg", "ctx"): tot[k] += len(x[k])
    tot["reports"] += len(x["reports"])
print("wells", len(W), dict(tot))
print("types", collections.Counter(x["meta"]["well_type"] for x in W.values()))
print("type x area", collections.Counter((x["meta"]["area_id"], x["meta"]["well_type"]) for x in W.values()))
print("status", collections.Counter(x["meta"]["recorded_status"] for x in W.values()))
print("note types", collections.Counter(c["note_type"] for x in W.values() for c in x["ctx"]))
print("reg types", collections.Counter((r["event_type"], r["protocol_id"], r["status"]) for x in W.values() for r in x["reg"]))
print("mnt types", collections.Counter(m["maintenance_type"] for x in W.values() for m in x["mnt"]))
print("methods", collections.Counter(i["method"] for x in W.values() for i in x["ins"]))
print("mnt issues (top)", collections.Counter(m["issue"] for x in W.values() for m in x["mnt"]).most_common(40))

# ---------- integrity ----------
all_ins = {}
for w, x in W.items():
    m = x["meta"]
    if area_of.get(w) != m["area_id"]: issues["area mismatch"].append(w)
    ins = x["ins"]
    ids = [i["inspection_id"] for i in ins]
    if len(set(ids)) != len(ids): issues["dup ins id"].append(w)
    for i in ins:
        all_ins[i["inspection_id"]] = (w, i)
        if i["asset_id"] != w: issues["ins asset_id mismatch"].append(i["inspection_id"])
        if i["inspector_user_id"] not in users: issues["unknown inspector"].append((i["inspection_id"], i["inspector_user_id"]))
        sd = i["spill_detected"]
        if sd and (i["spill_area_pct"] is None or i["spill_est_volume_bbl"] is None): issues["spill w/o vol"].append(i["inspection_id"])
        if not sd and (i["spill_area_pct"] is not None or i["spill_est_volume_bbl"] is not None): issues["vol w/o spill"].append(i["inspection_id"])
        if i["ambient_temp_c"] is None or i["wellhead_temp_c"] is None: issues["null temps"].append(i["inspection_id"])
    ts = [d(i["inspected_at"]) for i in ins]
    if ts != sorted(ts): issues["ins not sorted"].append(w)
    gaps = [(ts[k+1]-ts[k]).days for k in range(len(ts)-1)]
    for k, g in enumerate(gaps):
        if g > 14: issues["RC-01 gap >14d"].append((w, ins[k]["inspection_id"], g))
        if g < 5: issues["ins gap <5d"].append((w, ins[k]["inspection_id"], g))
    if ins:
        last = ins[-1]
        li = m.get("last_inspection") or {}
        if li.get("inspection_id") != last["inspection_id"] or li.get("inspected_at") != last["inspected_at"]:
            issues["last_inspection stale"].append((w, li.get("inspection_id"), last["inspection_id"]))
        if d(ins[0]["inspected_at"]).date() < date.fromisoformat(m["installed_on"]):
            issues["inspection before install"].append(w)
    # temp alarm
    for i in ins:
        lim = 85 if m["well_type"] == "T200" else 95
        if i["wellhead_temp_c"] is not None and i["wellhead_temp_c"] > lim: issues["temp alarm"].append((i["inspection_id"], i["wellhead_temp_c"]))
    # maintenance
    mids = [mm["maintenance_id"] for mm in x["mnt"]]
    if len(set(mids)) != len(mids): issues["dup mnt id"].append(w)
    st = [d(mm["started_at"]) for mm in x["mnt"]]
    if st != sorted(st): issues["mnt not in date order"].append(w)
    for mm in x["mnt"]:
        c = mm["cost_usd"]
        if c["labor"] + c["parts"] != c["total"]: issues["cost sum mismatch"].append((mm["maintenance_id"], c))
        if d(mm["completed_at"]) < d(mm["started_at"]): issues["completed<started"].append(mm["maintenance_id"])
        hrs = (d(mm["completed_at"]) - d(mm["started_at"])).total_seconds()/3600
        if abs(hrs - mm["downtime_hours"]) > 0.01 and d(mm["completed_at"]).date() <= TODAY: issues["downtime_hours != duration"].append((mm["maintenance_id"], mm["downtime_hours"], round(hrs,1)))
        if mm["technician_user_id"] and mm["technician_user_id"] not in users: issues["unknown tech"].append(mm["maintenance_id"])
        t = mm["triggered_by_inspection_id"]
        if t and t not in {i["inspection_id"] for i in ins}: issues["dangling trigger"].append((mm["maintenance_id"], t))
        rf = mm["report_file"]
        if mm["maintenance_type"] == "corrective" and not rf: issues["corrective w/o report"].append(mm["maintenance_id"])
        if rf and os.path.basename(rf) not in x["reports"]: issues["report_file missing"].append((mm["maintenance_id"], rf))
        if d(mm["started_at"]).date() > TODAY: issues["mnt starts in future"].append(mm["maintenance_id"])
        if d(mm["completed_at"]).date() > TODAY: issues["mnt open (completed>today)"].append(mm["maintenance_id"])
    referenced = {os.path.basename(mm["report_file"]) for mm in x["mnt"] if mm["report_file"]}
    for r in x["reports"] - referenced: issues["orphan report file"].append((w, r))
    for r in x["reg"]:
        if r.get("related_inspection_id") and r["related_inspection_id"] not in {i["inspection_id"] for i in ins}: issues["reg dangling ins"].append(r["event_id"])
    for c in x["ctx"]:
        if c["author_user_id"] not in users: issues["unknown note author"].append((c["note_id"], c["author_user_id"]))
        if c["note_type"] == "correction":
            tgt = c.get("inspection_id")
            ii = next((i for i in ins if i["inspection_id"] == tgt), None)
            if ii is None: issues["correction dangling"].append(c["note_id"])
            elif not ii["spill_detected"]: issues["correction on non-spill"].append((c["note_id"], tgt))
        elif c.get("inspection_id"): pass

for k, v in issues.items():
    print(f"\n## {k}: {len(v)}")
    for e in v[:12]: print("   ", e)

# ---------- report <-> record consistency ----------
print("\n## report header checks")
rep_iss = collections.Counter(); samples = collections.defaultdict(list)
for w, x in W.items():
    for mm in x["mnt"]:
        if not mm["report_file"]: continue
        p = os.path.join(A, w, mm["report_file"])
        if not os.path.exists(p): continue
        t = open(p, encoding="utf-8").read()
        h = re.search(r"# Maintenance Report — (\S+)", t)
        if not h or h.group(1) != mm["maintenance_id"]: rep_iss["header id mismatch"] += 1; samples["header id mismatch"].append((mm["maintenance_id"], h and h.group(1)))
        tot_m = re.search(r"\*\*Total\*\*\s*\|\s*\*\*([\d,]+)\*\*", t)
        if tot_m and int(tot_m.group(1).replace(",", "")) != mm["cost_usd"]["total"]:
            rep_iss["report total != record total"] += 1; samples["report total != record total"].append((mm["maintenance_id"], tot_m.group(1), mm["cost_usd"]["total"]))
        dh = re.search(r"Well stopped for this job:\*\*\s*(\d+)", t)
        if dh and int(dh.group(1)) != mm["downtime_hours"]: rep_iss["report hours != record"] += 1; samples["report hours != record"].append((mm["maintenance_id"], dh.group(1), mm["downtime_hours"]))
        tr = re.search(r"Triggered by:\*\*\s*inspection (\S+)", t)
        if tr and tr.group(1) != mm["triggered_by_inspection_id"]: rep_iss["report trigger != record"] += 1; samples["report trigger != record"].append((mm["maintenance_id"], tr.group(1), mm["triggered_by_inspection_id"]))
        if "Compliance check" not in t: rep_iss["no compliance section"] += 1
        if "contained about" in t and mm["triggered_by_inspection_id"]:
            ii = next(i for i in x["ins"] if i["inspection_id"] == mm["triggered_by_inspection_id"])
            vm = re.search(r"estimated ([\d.]+) bbl", t)
            if vm and ii["spill_est_volume_bbl"] is not None and float(vm.group(1)) != ii["spill_est_volume_bbl"]:
                rep_iss["report vol != inspection"] += 1; samples["report vol != inspection"].append((mm["maintenance_id"], vm.group(1), ii["spill_est_volume_bbl"]))
print(dict(rep_iss))
for k, v in samples.items(): print(k, v[:10])

# ---------- spills with/without reg events ----------
print("\n## SR-01 audit across fleet (corrected excluded)")
corr = {c["inspection_id"] for x in W.values() for c in x["ctx"] if c["note_type"] == "correction"}
for w, x in W.items():
    for i in x["ins"]:
        if i["spill_detected"] and i["inspection_id"] not in corr and i["spill_est_volume_bbl"] >= 5:
            regs = [r for r in x["reg"] if r.get("related_inspection_id") == i["inspection_id"]]
            print("  reportable", w, i["inspection_id"], i["inspected_at"][:10], i["spill_est_volume_bbl"], [(r["event_type"], r["hours_to_report"], r["status"]) for r in regs])
regs_no_spill = [(r["event_id"]) for x in W.values() for r in x["reg"] if r.get("related_inspection_id") and not all_ins[r["related_inspection_id"]][1]["spill_detected"]]
print("reg events pointing at non-spill inspections:", regs_no_spill[:10], len(regs_no_spill))
print("spill volume distribution:", collections.Counter(
    ("<1" if v < 1 else "1-5" if v < 5 else "5-25" if v < 25 else "25+") for x in W.values() for i in x["ins"] if i["spill_detected"] for v in [i["spill_est_volume_bbl"]]))
print("spill >5% pad:", sum(1 for x in W.values() for i in x["ins"] if i["spill_detected"] and i["spill_area_pct"] > 5))

# NOV responses
print("\n## NOV / RC-04")
for w, x in W.items():
    for r in x["reg"]:
        if r["event_type"] == "notice_of_violation":
            resp = [q for q in x["reg"] if q["event_type"] == "nov_response_filed" and q.get("related_inspection_id") == r.get("related_inspection_id")]
            print("  ", w, r["event_id"], r["date"], r["fine_usd"], r["status"], "responses:", [(q["event_id"], q["date"]) for q in resp])

json.dump({w: {"type": x["meta"]["well_type"]} for w, x in W.items()}, open(os.devnull, "w"))
