"""Select official live evidence and stage only private JSON inputs needed by the adapter."""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path


REPO = "lijianjun004-star/tcl-live-monitor"
WORKFLOW = ".github/workflows/v2-monitor.yml"
BASE = 44904350557
BASE_SHA = "e136adc323baacf385fd82c0aef416e9512976c0"
BASE_ARTIFACT = 14707476880
BASE_DIGEST = "700a5e0d42af34d248a39d58f9f5d9f7f9e47025dbd4308e9228ef2041e39382"
INPUTS = {"monitor_snapshot.json", "resolved_rooms.json", "run_summary.json", "control_live_result.json"}
REQUIRED = INPUTS | {"index.html", "SHA256SUMS.txt"}
MAX_BYTES = 32 * 1024 * 1024
CONCLUSIONS = {"success", "failure", "cancelled", "timed_out", "action_required", "neutral", "stale", "startup_failure"}
# Display-only continuity (dash/v2.mjs carryForward): up to six earlier verified rounds from the last 180 minutes.
PREVIOUS_LIMIT = 6
CARRY_WINDOW_SECONDS = 180 * 60
# This optional reader shares a 15-minute publication job with the legacy refresh.
lookup_deadline = None


class Rejected(ValueError):
    """Fixed categories only. Never log third-party names, contents or error messages."""


def require(condition, category):
    if not condition:
        raise Rejected(category)


def utc(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.utcoffset() is not None, "timestamp")
        return parsed.astimezone(timezone.utc)
    except (TypeError, AttributeError, ValueError):
        raise Rejected("timestamp") from None


def gh(path, output=subprocess.PIPE):
    timeout = min(35, lookup_deadline - time.monotonic()) if lookup_deadline is not None else 35
    require(timeout > 0, "lookup_timeout")
    try:
        return subprocess.run(
            ["gh", "api", "repos/" + REPO + "/actions/" + path],
            stdout=output, stderr=subprocess.DEVNULL, check=True, timeout=timeout
        ).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise Rejected("api_unavailable") from None


def api(path):
    try:
        result = json.loads(gh(path))
    except (UnicodeError, json.JSONDecodeError):
        raise Rejected("api_response") from None
    require(isinstance(result, dict), "api_response")
    return result


def verify_run(run):
    require(isinstance(run, dict) and type(run.get("id")) is int and run["id"] >= BASE
            and type(run.get("run_attempt")) is int and run["run_attempt"] > 0, "run_identity")
    require(all(isinstance(run.get(key), dict) and run[key].get("full_name") == REPO
                for key in ("repository", "head_repository")), "run_repository")
    require(run.get("head_branch") == "main" and run.get("path") == WORKFLOW
            and run.get("event") in ("workflow_dispatch", "schedule") and run.get("status") == "completed"
            and re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha", ""))), "run_identity")
    if run["id"] == BASE:
        require(run["head_sha"] == BASE_SHA and run["event"] == "workflow_dispatch", "baseline_identity")


def live_job(run, jobs):
    require(isinstance(jobs, list), "jobs_response")
    matches = [job for job in jobs if isinstance(job, dict) and job.get("name") == "live"]
    require(len(matches) == 1, "live_job")
    job = matches[0]
    require(job.get("run_id") == run["id"] and job.get("head_sha") == run["head_sha"]
            and job.get("run_attempt", run["run_attempt"]) == run["run_attempt"]
            and job.get("status") == "completed", "live_job_identity")
    require(job.get("conclusion") in CONCLUSIONS, "live_job_skipped")
    return job


def verify_eligible_job(run, jobs):
    verify_run(run)
    job = live_job(run, jobs)
    require(run.get("conclusion") == "success" and job["conclusion"] == "success", "live_job_failed")
    steps = job.get("steps")
    require(isinstance(steps, list), "live_steps")
    for name in ("Live V2 run", "Verify evidence checksums", "Upload evidence"):
        matching = [step for step in steps if isinstance(step, dict) and step.get("name") == name]
        require(len(matching) == 1 and matching[0].get("status") == "completed"
                and matching[0].get("conclusion") == "success", "live_steps")
    return job


def verify_artifact(artifact, run):
    verify_run(run)
    run_id, attempt = run["id"], run["run_attempt"]
    name = f"TCL_V2_Evidence_{run_id}_a{attempt}"
    require(isinstance(artifact, dict) and artifact.get("name") == name and artifact.get("expired") is False
            and type(artifact.get("id")) is int and artifact["id"] > 0
            and type(artifact.get("size_in_bytes")) is int and 0 < artifact["size_in_bytes"] <= MAX_BYTES
            and re.fullmatch(r"sha256:[0-9a-f]{64}", str(artifact.get("digest", ""))), "artifact_identity")
    # The list endpoint is scoped to this exact run. If an embedded run reference is
    # supplied by GitHub it must also agree, including on the repository when given.
    if "workflow_run" in artifact:
        parent = artifact["workflow_run"]
        require(isinstance(parent, dict) and parent.get("id") == run_id and parent.get("head_branch") == "main"
                and parent.get("head_sha") == run["head_sha"], "artifact_parent")
        for field, repo in (("repository_id", "repository"), ("head_repository_id", "head_repository")):
            if field in parent:
                require(parent[field] == run[repo].get("id"), "artifact_parent")
    if run_id == BASE:
        require(attempt == 1 and artifact["id"] == BASE_ARTIFACT
                and artifact["digest"] == "sha256:" + BASE_DIGEST, "baseline_identity")


def verified_members(archive):
    files = {}
    total = 0
    entries = archive.infolist()
    require(len(entries) <= 128, "archive_size")
    seen = set()
    for info in entries:
        name = info.orig_filename
        require(name == info.filename and name not in seen and not (info.flag_bits & 1), "archive_member")
        seen.add(name)
        mode = stat.S_IFMT(info.external_attr >> 16)
        if info.is_dir():
            require(name == "thumbs/" and mode in (0, stat.S_IFDIR), "archive_member")
            continue
        require(mode in (0, stat.S_IFREG) and (name in REQUIRED | {"drive_status.json"}
                or re.fullmatch(r"thumbs/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.jpg", name)), "archive_member")
        total += info.file_size
        require(total <= MAX_BYTES, "archive_size")
        files[name] = archive.read(info)   # verifies CRC32; never extract to an archive-controlled path
    require(REQUIRED <= files.keys(), "incomplete_archive")
    expected = files.keys() - {"SHA256SUMS.txt", "drive_status.json"}
    verified = set()
    for line in files["SHA256SUMS.txt"].decode("ascii").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match is not None, "manifest")
        digest, name = match.groups()
        require(name in expected and name not in verified and hashlib.sha256(files[name]).hexdigest() == digest,
                "manifest")
        verified.add(name)
    require(verified == expected, "manifest")
    selected = INPUTS | ({"drive_status.json"} & files.keys())
    return {name: files[name] for name in selected}


def verify_archive(path, artifact, run, destination):
    verify_artifact(artifact, run)
    path = Path(path)
    require(path.stat().st_size == artifact["size_in_bytes"], "archive_size")
    require("sha256:" + hashlib.sha256(path.read_bytes()).hexdigest() == artifact["digest"], "archive_digest")
    try:
        with zipfile.ZipFile(path) as archive:
            members = verified_members(archive)
        summary = json.loads(members["run_summary.json"])
        require(isinstance(summary, dict) and summary.get("repository") == REPO and summary.get("branch") == "main"
                and summary.get("event") == run["event"] and summary.get("head_sha") == run["head_sha"]
                and str(summary.get("run_id")) == str(run["id"])
                and str(summary.get("run_attempt")) == str(run["run_attempt"])
                and summary.get("engine") == "live", "summary_origin")
    except (zipfile.BadZipFile, zlib.error, EOFError, UnicodeError, json.JSONDecodeError, NotImplementedError):
        raise Rejected("invalid_archive") from None
    for name, data in members.items():
        (destination / name).write_bytes(data)
    source = {"runId": str(run["id"]), "attempt": run["run_attempt"], "headSha": run["head_sha"], "event": run["event"]}
    (destination / "source.json").write_text(json.dumps(source))


def validate_candidate(directory):
    result = subprocess.run(["node", str(Path(__file__).with_name("v2.mjs")), str(directory)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    require(result.returncode == 0, "data_contract")


def fetch_candidate(run, directory):
    name = f"TCL_V2_Evidence_{run['id']}_a{run['run_attempt']}"
    listing = api(f"runs/{run['id']}/artifacts?name={name}&per_page=100")
    artifacts = listing.get("artifacts")
    require(isinstance(artifacts, list) and len(artifacts) == 1, "artifact_missing")
    artifact = artifacts[0]
    verify_artifact(artifact, run)
    with tempfile.TemporaryDirectory(dir=directory.parent) as work:
        archive = Path(work) / "download.zip"
        with archive.open("wb") as output:
            gh(f"artifacts/{artifact['id']}/zip", output)
        verify_archive(archive, artifact, run, directory)
    validate_candidate(directory)


def runs_to_check():
    path = "workflows/v2-monitor.yml/runs?branch=main&status=completed&per_page=100"
    result = []
    # GitHub's filtered workflow-runs endpoint returns up to 1,000 results.
    for page in range(1, 11):
        try:
            runs = api(path if page == 1 else f"{path}&page={page}").get("workflow_runs")
            require(isinstance(runs, list), "run_list")
        except Rejected:
            if page == 1:
                raise
            break
        for run in runs:
            try:
                verify_run(run)
                result.append(run)
            except Rejected:
                continue
        if len(runs) < 100 or any(isinstance(r, dict) and type(r.get("id")) is int and r["id"] <= BASE for r in runs):
            break
    return result


def utc_now():
    return datetime.now(timezone.utc)


def acquire_previous(output, selected, runs, checked):
    """Stage earlier verified rounds under output/previous/<n>. Never changes the selected round."""
    cutoff = utc_now().timestamp() - CARRY_WINDOW_SECONDS
    runs = sorted((r for r in runs if (r["id"], r["run_attempt"]) not in checked and r["id"] != selected["id"]),
                  key=lambda r: (r.get("updated_at") or "", r["id"], r["run_attempt"]), reverse=True)
    kept, seen = 0, set()
    for run in runs:
        key = (run["id"], run["run_attempt"])
        if kept >= PREVIOUS_LIMIT or key in seen:
            continue
        seen.add(key)
        try:
            if utc(run.get("updated_at")).timestamp() < cutoff:
                break
            jobs = api(f"runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100").get("jobs")
            ended = utc(live_job(run, jobs).get("completed_at"))
            if ended.timestamp() < cutoff:
                break
            require(ended <= selected["ended"], "previous_order")
            verify_eligible_job(run, jobs)
            target = output / "previous" / str(kept + 1)
            with tempfile.TemporaryDirectory(dir=output.parent) as work:
                candidate = Path(work)
                fetch_candidate(run, candidate)
                target.mkdir(parents=True)
                for file in candidate.iterdir():
                    file.replace(target / file.name)
            kept += 1
        except Rejected as error:
            if str(error) == "lookup_timeout":
                break
            print("V2 earlier round unavailable:", str(error), file=sys.stderr)


def acquire(output):
    latest = None
    selected = None
    try:
        runs = runs_to_check()
        health_known = True
    except Rejected:
        runs, health_known = [], False
    # The reviewed first attempt is also looked up explicitly if outside the list, or rerun.
    if not any(r["id"] == BASE and r["run_attempt"] == 1 for r in runs):
        try:
            first = api(f"runs/{BASE}/attempts/1")
            verify_run(first)
            require(first["id"] == BASE and first["run_attempt"] == 1, "baseline_identity")
            runs.append(first)
        except Rejected:
            pass
    # List responses are by creation. A rerun can finish later than a newly created run.
    checked = set()
    while runs:
        runs.sort(key=lambda r: (r.get("updated_at") or "", r["id"], r["run_attempt"]))
        run = runs.pop()
        key = (run["id"], run["run_attempt"])
        if key in checked:
            continue
        checked.add(key)
        try:
            jobs = api(f"runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100").get("jobs")
            job = live_job(run, jobs)
            ended = utc(job.get("completed_at"))
            require(ended <= datetime.now(timezone.utc), "timestamp")
            if latest is None and health_known:
                latest = {"runId": str(run["id"]), "attempt": run["run_attempt"],
                          "at": ended.isoformat().replace("+00:00", "Z"), "conclusion": job["conclusion"]}
            verify_eligible_job(run, jobs)
            with tempfile.TemporaryDirectory(dir=output.parent) as work:
                candidate = Path(work)
                fetch_candidate(run, candidate)
                for file in candidate.iterdir():
                    file.replace(output / file.name)
            selected = {"id": run["id"], "ended": ended}
            break
        except Rejected as error:
            if str(error) == "lookup_timeout":
                break
            if latest is None and str(error) in {"api_unavailable", "api_response", "timestamp", "jobs_response"}:
                health_known = False
            print("V2 candidate unavailable:", str(error), file=sys.stderr)
        if run["id"] > BASE and run["run_attempt"] > 1:
            try:
                previous = api(f"runs/{run['id']}/attempts/{run['run_attempt'] - 1}")
                verify_run(previous)
                require(previous["id"] == run["id"] and previous["run_attempt"] == run["run_attempt"] - 1
                        and previous["head_sha"] == run["head_sha"] and previous["event"] == run["event"], "previous_attempt")
                runs.append(previous)
            except Rejected:
                pass
    if selected is not None:
        acquire_previous(output, selected, runs, checked)
    (output / "latest.json").write_text(json.dumps(latest))


def main(output):
    global lookup_deadline
    lookup_deadline = time.monotonic() + 120
    os.umask(0o077)
    output = Path(output).absolute()
    checkout = Path(__file__).resolve().parents[1]
    if output.resolve().is_relative_to(checkout) or output.exists() or output.is_symlink():
        raise SystemExit("V2_PRIVATE_DIR must be a new private directory outside the checkout")
    with tempfile.TemporaryDirectory(dir=output.parent) as work:
        staging = Path(work) / "selected"
        staging.mkdir(mode=0o700)
        acquire(staging)
        staging.rename(output)
    print("V2 evidence selected" if (output / "source.json").is_file() else "V2 evidence unavailable")


if __name__ == "__main__":
    main(sys.argv[1])
