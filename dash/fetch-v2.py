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
from datetime import datetime, timedelta, timezone
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
HISTORY_LIMIT = 12
HISTORY_WINDOW = timedelta(minutes=180)
HISTORY_CODES = {"CAPTCHA_X5SEC", "GROUP_CIRCUIT_OPEN"}
CONCLUSIONS = {"success", "failure", "cancelled", "timed_out", "action_required", "neutral", "stale", "startup_failure"}
# This optional reader shares a 15-minute publication job with the legacy refresh.
lookup_deadline = None


class Rejected(ValueError):
    """Fixed categories only. Never log third-party names, contents or error messages."""


class RunListing(list):
    """The legacy selector can use partial listings; history must prove coverage."""

    complete = False


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
    timeout = min(35, lookup_deadline - time.monotonic()) if lookup_deadline is not None else 35
    require(timeout > 0, "lookup_timeout")
    try:
        result = subprocess.run(["node", str(Path(__file__).with_name("v2.mjs")), str(directory)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Rejected("lookup_timeout") from None
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
    result = RunListing()
    seen_count = 0
    valid_listing = True
    expected_total = None
    listed_identities = set()
    # GitHub's filtered workflow-runs endpoint returns up to 1,000 results.
    for page in range(1, 11):
        try:
            response = api(path if page == 1 else f"{path}&page={page}")
            runs = response.get("workflow_runs")
            require(isinstance(runs, list), "run_list")
        except Rejected:
            if page == 1:
                raise
            break
        seen_count += len(runs)
        if "total_count" in response:
            total = response["total_count"]
            if type(total) is not int or total < 0 or (expected_total is not None and total != expected_total):
                valid_listing = False
            expected_total = total
        for run in runs:
            try:
                verify_run(run)
                identity = (run["id"], run["run_attempt"])
                if identity in listed_identities:
                    # Pagination can shift while runs finish. A duplicated record
                    # must not conceal a missing intermediate OFFLINE observation.
                    valid_listing = False
                listed_identities.add(identity)
                result.append(run)
            except Rejected:
                # Other event types are intentionally outside this reader. A broken
                # record in its accepted scope is a possible missing observation.
                if not isinstance(run, dict) or (run.get("event") in ("workflow_dispatch", "schedule")
                        and (type(run.get("id")) is not int or run["id"] >= BASE)):
                    valid_listing = False
                continue
        at_baseline = any(isinstance(r, dict) and type(r.get("id")) is int and r["id"] <= BASE for r in runs)
        if len(runs) < 100 or at_baseline:
            result.complete = valid_listing and (at_baseline or expected_total is None or expected_total <= seen_count)
            break
    return result


def run_times(run):
    created, started, updated = (utc(run.get(key)) for key in ("created_at", "run_started_at", "updated_at"))
    require(created <= started <= updated <= datetime.now(timezone.utc), "history_time")
    return created, started, updated


def history_needed(directory):
    snapshot = json.loads((directory / "monitor_snapshot.json").read_text())
    return any(room.get("platform") in ("tmall", "taobao") and room.get("code") in HISTORY_CODES
               for room in snapshot["rooms"])


def verified_interval(directory, run, job):
    """Cross-check archive time against its attested run, not a refresh clock."""
    summary = json.loads((directory / "run_summary.json").read_text())
    started, completed = utc(summary.get("started_utc")), utc(summary.get("completed_utc"))
    _, run_started, updated = run_times(run)
    ended = utc(job.get("completed_at"))
    require(run_started <= started <= completed <= ended <= updated, "history_time")
    snapshot = json.loads((directory / "monitor_snapshot.json").read_text())
    captured = utc(snapshot.get("generated_at"))
    require(started <= captured <= completed and all(started <= utc(room.get("observed_at")) <= captured
            for room in snapshot["rooms"]), "history_time")
    return started, completed


def acquire_history(output, selected, selected_job, listing, latest):
    """Stage a complete, bounded chain; any gap discards the whole private chain.

    The files are original validated observations, including OFFLINE rounds. They
    never replace current inputs or participate in collector notification state.
    """
    unavailable = {"status": "unavailable", "entries": []}
    if selected is None or latest is None or (latest["runId"], latest["attempt"], latest["conclusion"]) != (
            str(selected["id"]), selected["run_attempt"], "success"):
        return unavailable
    try:
        if not history_needed(output):
            return {"status": "complete", "entries": []}
        require(listing.complete, "history_listing_incomplete")
        # A workflow list only exposes its latest attempt. Do not silently omit
        # intermediate attempts, whose observations could invalidate an older LIVE.
        require(selected["run_attempt"] == 1, "history_retry")
        _, anchor = verified_interval(output, selected, selected_job)
        cutoff = anchor - HISTORY_WINDOW
        selected_updated = run_times(selected)[2]
        candidates = {}
        for run in listing:
            if run["id"] == selected["id"] and run["run_attempt"] == selected["run_attempt"]:
                require(run == selected, "history_duplicate")
                continue
            _, _, updated = run_times(run)
            if updated < cutoff:
                continue  # No download for an archive certainly outside the window.
            require(updated <= selected_updated and run["run_attempt"] == 1, "history_retry_or_order")
            # Failed first attempts have no accepted successful evidence. A rerun
            # above was rejected because its hidden prior attempt may have one.
            if run.get("conclusion") != "success":
                continue
            key = (run["id"], run["run_attempt"])
            require(key not in candidates or candidates[key] == run, "history_duplicate")
            candidates[key] = run
        require(len(candidates) <= HISTORY_LIMIT, "history_limit")
        entries = []
        with tempfile.TemporaryDirectory(dir=output.parent) as work:
            staging = Path(work) / "history"
            staging.mkdir(mode=0o700)
            for run in sorted(candidates.values(), key=lambda r: (utc(r["updated_at"]), r["id"]), reverse=True):
                require(lookup_deadline is None or time.monotonic() < lookup_deadline, "lookup_timeout")
                jobs = api(f"runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100").get("jobs")
                job = verify_eligible_job(run, jobs)
                directory = staging / f"{run['id']}-{run['run_attempt']}"
                directory.mkdir(mode=0o700)
                fetch_candidate(run, directory)
                _, completed = verified_interval(directory, run, job)
                require(completed <= anchor, "history_time")
                # updated_at includes artifact upload time. A borderline old round
                # can be validated yet contain no observations inside the window.
                if completed >= cutoff:
                    entries.append("history/" + directory.name)
            require(lookup_deadline is None or time.monotonic() < lookup_deadline, "lookup_timeout")
            staging.rename(output / "history")
        return {"status": "complete", "entries": entries}
    except (Rejected, OSError, UnicodeError, json.JSONDecodeError):
        # The root selected snapshot remains usable. Never expose a partial chain.
        print("V2 history unavailable", file=sys.stderr)
        return unavailable


def acquire(output):
    latest = None
    selected = selected_job = None
    try:
        runs = runs_to_check()
        health_known = True
    except Rejected:
        runs, health_known = RunListing(), False
    listing = RunListing(runs)
    listing.complete = runs.complete
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
            selected, selected_job = run, job
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
    (output / "latest.json").write_text(json.dumps(latest))
    history = acquire_history(output, selected, selected_job, listing, latest)
    (output / "history.json").write_text(json.dumps(history))


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
