"""Drive one native review transaction by executing provider-issued commands verbatim.

Usage: review_drive.py <repo> <status-command-from-assess>
Stops and prints the raw envelope on anything other than the approved path.
Consent is answered "granted" under the owner's standing instruction (2026-10-13).
"""
import json
import shlex
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

repo = sys.argv[1]
status_cmd = sys.argv[2]


def run(cmd):
    proc = subprocess.run(cmd, shell=True, cwd=repo, capture_output=True, text=True)
    out = proc.stdout.strip()
    try:
        return json.loads(out), proc
    except json.JSONDecodeError:
        end = out.rfind("}")
        if end != -1:
            try:
                return json.loads(out[: end + 1]), proc
            except json.JSONDecodeError:
                pass
        print("UNPARSEABLE OUTPUT from:", cmd)
        print(out[:3000])
        print(proc.stderr[:2000])
        sys.exit(2)


def stop(label, envelope):
    print("STOP:", label)
    print(json.dumps(envelope, indent=1, ensure_ascii=False)[:6000])
    sys.exit(3)


def summarize_findings(envelope):
    for result in envelope.get("reviewer_results", []):
        for f in result.get("findings", []):
            print(f"FINDING [{f.get('severity')}] {f.get('id')} @ {f.get('location')}")
            print("   ", f.get("claim", "")[:700])


def finish(envelope):
    print("STATE:", envelope.get("state"))
    summarize_findings(envelope)
    ack = envelope.get("acknowledgement")
    if envelope.get("state") == "approved" and ack:
        acked, _ = run(ack["command"])
        print("ACK:", acked.get("action"), acked.get("authority"), acked.get("lineage_id"))
        sys.exit(0)
    stop("final capture did not approve", envelope)


last_status_cmd = status_cmd
env, _ = run(status_cmd)
for _ in range(12):
    schema = env.get("schema", "")
    if "consent" in schema:
        print("CONSENT:", env.get("risk_level"), env.get("changed_files"), "files", env.get("changed_lines"), "lines", env.get("risk_evidence"))
        granted = [c for c in env["choices"] if c["answer"] == "granted"]
        if len(granted) != 1:
            stop("consent envelope without a single granted choice", env)
        env, _ = run(granted[0]["invocation"])
        continue
    if env.get("state") == "approved" and env.get("acknowledgement"):
        finish(env)
    nt = env.get("next_transition")
    if not nt:
        stop("no next_transition", env)
    kind = nt.get("kind")
    if kind == "execute":
        print("EXECUTE:", nt["execute"]["operation"], nt.get("reason_code"))
        if nt["execute"]["operation"] == "review.start":
            print("LENSES/START for lineage in command")
        if nt["execute"]["operation"] == "review.status":
            last_status_cmd = nt["execute"]["command"]
        env, _ = run(nt["execute"]["command"])
        if env.get("selected_lenses"):
            print("SELECTED LENSES:", env["selected_lenses"], "risk", env.get("risk_level"))
        continue
    if kind == "collect":
        inputs = nt["collect"]["inputs"]
        cmds = []
        for item in inputs:
            if item.get("capture_operation") != "review.capture-result":
                stop("unexpected collect input", env)
            tokens = " ".join(shlex.quote(a["token"]) for a in item["arguments"])
            cmds.append("gentle-ai review capture-result " + tokens)
        print("COLLECT:", len(cmds), "capture(s)")
        with ThreadPoolExecutor(max_workers=len(cmds)) as pool:
            results = list(pool.map(run, cmds))
        last = None
        for captured, _proc in results:
            if captured.get("state") in ("approved", "correction_required") or captured.get("acknowledgement"):
                last = captured
        if last is not None:
            if last.get("state") == "approved":
                finish(last)
            stop("review did not approve", last)
        env, _ = run(last_status_cmd)
        continue
    stop(f"transition kind {kind}", env)
stop("loop limit reached", env)
