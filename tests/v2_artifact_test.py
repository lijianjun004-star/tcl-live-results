"""Offline acquisition checks. All archived records and API responses are synthetic."""
from collections import Counter
from copy import deepcopy
from datetime import timedelta
from functools import cache
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("fetch_v2", ROOT / "dash/fetch-v2.py")
fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)

REPO = "lijianjun004-star/tcl-live-monitor"
RUN_ID = 940000000001
HEAD = "a" * 40
AT = "2026-11-16T11:59:05Z"
WORKFLOW = ".github/workflows/v2-monitor.yml"


def run_record(attempt=1):
    return {
        "id": RUN_ID, "run_attempt": attempt, "run_number": 100, "workflow_id": 123,
        "head_branch": "main", "head_sha": HEAD, "path": WORKFLOW,
        "event": "workflow_dispatch", "status": "completed", "conclusion": "success",
        "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO},
        "created_at": AT, "run_started_at": AT, "updated_at": AT,
    }


def live_job(run):
    return {
        "id": 123, "name": "live", "run_id": run["id"], "run_attempt": run["run_attempt"],
        "head_sha": run["head_sha"], "head_branch": "main",
        "status": "completed", "conclusion": "success", "completed_at": AT,
        "steps": [
            {"name": name, "status": "completed", "conclusion": "success"}
            for name in ("Live V2 run", "Verify evidence checksums", "Upload evidence")
        ],
    }


@cache
def fixture():
    cmd = ["node", "--input-type=module", "-e",
           "import { tenTargetRound } from './tests/fixtures/v2.mjs'; "
           "process.stdout.write(JSON.stringify(tenTargetRound()))"]
    return json.loads(subprocess.check_output(cmd, cwd=ROOT))


def create_archive(directory, run, summary_changes=None, corrupt_member=False, room_count=10, transform=None):
    run_id = str(run["id"])
    attempt = run["run_attempt"]
    evidence = deepcopy(fixture()["evidence"])
    summary = evidence["summary"]
    summary.update({"run_id": run_id, "run_attempt": str(attempt), "head_sha": run["head_sha"],
                    "event": run["event"]})
    for key in ("snapshot", "resolved"):
        evidence[key]["run_id"] = f"{run_id}.{attempt}"
        evidence[key]["rooms"] = evidence[key]["rooms"][:room_count]
    if transform is not None:
        evidence = transform(evidence)
        summary = evidence["summary"]
    # Counts describe the shortened round itself; stale totals cannot cause its rejection.
    rows = evidence["snapshot"]["rooms"]
    codes = dict(Counter(row["code"] for row in rows))
    platforms = dict(Counter(row["platform"] for row in rows))
    summary.update(targets_total=room_count, by_code=codes, by_platform=platforms)
    evidence["snapshot"]["summary"].update(total=room_count, live=codes.get("OK", 0),
                                           offline=codes.get("OFFLINE", 0),
                                           abnormal=room_count - codes.get("OK", 0) - codes.get("OFFLINE", 0),
                                           by_code=codes, by_platform=platforms)
    summary.update(summary_changes or {})
    members = {
        name + ".json": json.dumps(evidence[key]).encode()
        for name, key in (("run_summary", "summary"), ("monitor_snapshot", "snapshot"),
                          ("resolved_rooms", "resolved"), ("control_live_result", "control"))
    }
    members["index.html"] = b"<title>synthetic</title>"
    members["SHA256SUMS.txt"] = "".join(
        f"{hashlib.sha256(body).hexdigest()}  {name}\n" for name, body in sorted(members.items())
    ).encode()
    if corrupt_member:
        # Safe, parseable JSON. Only the inner hash distinguishes this member.
        members["resolved_rooms.json"] += b"\n"
    path = directory / f"evidence-{run_id}-{attempt}.zip"
    with ZipFile(path, "w") as archive:
        for name, body in members.items():
            archive.writestr(name, body)
    artifact = {
        "id": (run["id"] - RUN_ID) * 100 + 2000 + attempt, "name": f"TCL_V2_Evidence_{run_id}_a{attempt}",
        "expired": False, "size_in_bytes": path.stat().st_size,
        "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}",
        "workflow_run": {"id": run["id"], "head_sha": run["head_sha"], "head_branch": "main"},
    }
    return path, artifact


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.run_record = run_record()

    def verify(self, archive, artifact):
        destination = self.directory / "accepted"
        destination.mkdir(exist_ok=True)
        fetch.verify_archive(archive, artifact, self.run_record, destination)
        return destination

    def test_matching_outer_and_member_digests(self):
        archive, artifact = create_archive(self.directory, self.run_record)
        output = self.verify(archive, artifact)
        self.assertTrue((output / "monitor_snapshot.json").is_file())
        self.assertFalse((output / "index.html").exists())
        self.assertFalse((output / "SHA256SUMS.txt").exists())

    def test_rejects_mismatched_outer_digest(self):
        archive, artifact = create_archive(self.directory, self.run_record)
        artifact["digest"] = "sha256:" + "0" * 64
        with self.assertRaises(ValueError):
            self.verify(archive, artifact)

    def test_rejects_member_corruption_even_with_correct_outer_digest(self):
        archive, artifact = create_archive(self.directory, self.run_record, corrupt_member=True)
        with self.assertRaises(ValueError):
            self.verify(archive, artifact)

    def test_valid_archive_hash_cannot_substitute_for_attested_run(self):
        changes = [
            {"repository": "fixture/fork"}, {"branch": "other"}, {"event": "push"}, {"event": "schedule"},
            {"run_id": "1234"}, {"run_attempt": "2"}, {"head_sha": "b" * 40},
            {"engine": "fake"},
        ]
        for change in changes:
            with self.subTest(change=change):
                archive, artifact = create_archive(self.directory, self.run_record, change)
                with self.assertRaises(ValueError):
                    self.verify(archive, artifact)

    def test_run_and_job_provenance_and_successful_steps(self):
        run = self.run_record
        job = live_job(run)
        self.assertEqual(fetch.verify_eligible_job(run, [job]), job)
        for update in (
            {"id": fetch.BASE - 1}, {"repository": {"full_name": "fixture/fork"}},
            {"head_repository": {"full_name": "fixture/fork"}}, {"event": "push"},
            {"head_branch": "other"}, {"path": ".github/workflows/offline.yml"},
            {"head_sha": "bad"}, {"status": "queued"}, {"conclusion": "failure"},
        ):
            with self.subTest(run=update), self.assertRaises(ValueError):
                fetch.verify_eligible_job({**run, **update}, [job])
        for update in (
            {"conclusion": "skipped"}, {"conclusion": "failure"}, {"run_attempt": 2},
            {"run_id": RUN_ID + 1}, {"head_sha": "b" * 40}, {"steps": []},
            {"steps": [{**step, "conclusion": "failure"} if step["name"] == "Live V2 run"
                       else step for step in job["steps"]]},
        ):
            with self.subTest(job=update), self.assertRaises(ValueError):
                fetch.verify_eligible_job(run, [{**job, **update}])

    def test_first_round_is_pinned_to_a_specific_head_attempt_artifact_and_digest(self):
        run = {**self.run_record, "id": fetch.BASE, "head_sha": fetch.BASE_SHA}
        registered = {
            "name": f"TCL_V2_Evidence_{fetch.BASE}_a1", "id": fetch.BASE_ARTIFACT,
            "expired": False, "size_in_bytes": 1024, "digest": "sha256:" + fetch.BASE_DIGEST,
        }
        fetch.verify_artifact(registered, run)
        for artifact, identity in (
            ({**registered, "id": registered["id"] + 1}, run),
            ({**registered, "digest": "sha256:" + "f" * 64}, run),
            (registered, {**run, "head_sha": "b" * 40}),
            (registered, {**run, "event": "schedule"}),
            ({**registered, "name": f"TCL_V2_Evidence_{fetch.BASE}_a2"}, {**run, "run_attempt": 2}),
        ):
            with self.subTest(identity=identity), self.assertRaises(ValueError):
                fetch.verify_artifact(artifact, identity)

    def test_artifact_is_bound_to_run_attempt_and_parent(self):
        _, artifact = create_archive(self.directory, self.run_record)
        parent = artifact["workflow_run"]
        for update in (
            {"name": "v2-state"}, {"name": f"TCL_V2_Evidence_{RUN_ID}_a2"},
            {"workflow_run": {**parent, "id": RUN_ID + 1}},
            {"workflow_run": {**parent, "head_sha": "b" * 40}},
            {"workflow_run": {**parent, "head_branch": "alternate"}},
        ):
            with self.subTest(update=update), self.assertRaises(ValueError):
                fetch.verify_artifact({**artifact, **update}, self.run_record)


class AcquisitionTests(unittest.TestCase):
    """Mock only GitHub transport and use the real validator with a synthetic roster."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.output = self.directory / "selected"
        self.output.mkdir()
        dash = self.directory / "dash"
        (dash / "private").mkdir(parents=True)
        shutil.copy(ROOT / "dash/v2.mjs", dash)
        (dash / "private/v2-roster.json").write_text(json.dumps(fixture()["registry"]))
        location = patch.object(fetch, "__file__", str(dash / "fetch-v2.py"))
        location.start()
        self.addCleanup(location.stop)
        self.responses = {f"runs/{fetch.BASE}/attempts/1": None}
        self.downloads = {}
        self.requests = Counter()

    def provide(self, run, *, job_result="success", expired=False, room_count=10,
                transform=None, summary_changes=None, corrupt_member=False, completed_at=None):
        rid, attempt = run["id"], run["run_attempt"]
        job = {**live_job(run), "conclusion": job_result}
        if completed_at is not None:
            job["completed_at"] = completed_at
        self.responses[f"runs/{rid}/attempts/{attempt}"] = run
        self.responses[f"runs/{rid}/attempts/{attempt}/jobs?per_page=100"] = {"jobs": [job]}
        if job_result != "success":
            return None
        archive, artifact = create_archive(self.directory, run, room_count=room_count, transform=transform,
                                           summary_changes=summary_changes, corrupt_member=corrupt_member)
        artifact["expired"] = expired
        self.responses[f"runs/{rid}/artifacts?name={artifact['name']}&per_page=100"] = {
            "artifacts": [artifact]
        }
        download = f"artifacts/{artifact['id']}/zip"
        self.downloads[download] = archive.read_bytes()
        return download

    def acquire(self, listed, total_count=None):
        listing = "workflows/v2-monitor.yml/runs?branch=main&status=completed&per_page=100"
        self.responses[listing] = {"workflow_runs": listed}
        if total_count is not None:
            self.responses[listing]["total_count"] = total_count

        def github(path, output=None):
            self.requests[path] += 1
            if output is not None:
                self.assertIn(path, self.downloads)
                output.write(self.downloads[path])
                return None
            self.assertIn(path, self.responses)
            if self.responses[path] is None:
                raise fetch.Rejected("api_unavailable")
            return json.dumps(self.responses[path]).encode()

        with patch.object(fetch, "gh", side_effect=github):
            fetch.acquire(self.output)
        latest = json.loads((self.output / "latest.json").read_text())
        source = self.output / "source.json"
        return latest, json.loads(source.read_text()) if source.exists() else None

    def test_selects_newest_eligible_run_across_manual_and_scheduled_events(self):
        manual = run_record()
        scheduled = {**manual, "id": RUN_ID + 1, "event": "schedule", "updated_at": "2026-11-16T12:05:00Z"}
        later_manual = {**manual, "id": RUN_ID + 2, "updated_at": "2026-11-16T12:10:00Z"}
        push = {**manual, "id": RUN_ID + 3, "event": "push", "updated_at": "2026-11-16T12:15:00Z"}
        for run in (manual, scheduled, later_manual):
            self.provide(run)
        cases = (([manual, push, scheduled], scheduled), ([later_manual, push, scheduled], later_manual))
        for listed, expected in cases:
            with self.subTest(event=expected["event"]):
                latest, selected = self.acquire(listed)
                self.assertEqual(latest["runId"], str(expected["id"]))
                self.assertEqual((selected["runId"], selected["event"]), (str(expected["id"]), expected["event"]))

    def test_previous_attempt_of_the_same_run_must_have_the_same_event(self):
        failed = {**run_record(2), "event": "schedule", "conclusion": "failure"}
        self.provide(failed, job_result="failure")
        download = self.provide(run_record(1))  # same run ID and commit, different event
        latest, selected = self.acquire([failed])
        self.assertIsNone(selected)
        self.assertEqual((latest["runId"], latest["attempt"]), (str(RUN_ID), 2))
        self.assertEqual(self.requests[download], 0)

    def test_failed_rerun_keeps_earlier_observations_and_latest_failed_health(self):
        current = {**run_record(2), "conclusion": "failure"}
        previous = run_record(1)
        self.provide(current, job_result="failure")
        download = self.provide(previous)
        latest, selected = self.acquire([current, current])
        self.assertEqual((latest["attempt"], latest["conclusion"]), (2, "failure"))
        self.assertEqual((selected["runId"], selected["attempt"]), (str(RUN_ID), 1))
        self.assertEqual(self.requests[download], 1)
        self.assertEqual(self.requests[f"runs/{RUN_ID}/attempts/2/jobs?per_page=100"], 1)

    def test_expired_and_six_target_runs_fall_back_to_valid_ten_target_round(self):
        older = run_record()
        six = {**older, "id": RUN_ID + 1}
        expired = {**older, "id": RUN_ID + 2}
        selected_download = self.provide(older)
        self.provide(six, room_count=6)
        expired_download = self.provide(expired, expired=True)
        latest, selected = self.acquire([six, older, expired])
        self.assertEqual(latest["runId"], str(expired["id"]))
        self.assertEqual(selected["runId"], str(older["id"]))
        self.assertEqual(self.requests[expired_download], 0)
        self.assertEqual(self.requests[selected_download], 1)
        evidence = json.loads((self.output / "monitor_snapshot.json").read_text())
        self.assertEqual(len(evidence["rooms"]), 10)
        self.assertEqual(evidence["generated_at"], fixture()["evidence"]["snapshot"]["generated_at"])

    def test_duplicate_successful_attempt_selected_once_without_previous_attempt(self):
        current = run_record(2)
        download = self.provide(current)
        latest, selected = self.acquire([current, current])
        self.assertEqual(latest["attempt"], 2)
        self.assertEqual(selected["attempt"], 2)
        self.assertEqual(self.requests[download], 1)
        self.assertEqual(self.requests[f"runs/{RUN_ID}/attempts/1"], 0)

    def test_all_artifacts_expired_or_skipped_preserves_only_latest_live_job_health(self):
        expired = run_record()
        skipped = {**expired, "id": RUN_ID + 1}
        self.provide(skipped, job_result="skipped")
        download = self.provide(expired, expired=True)
        latest, selected = self.acquire([skipped, expired, expired])
        self.assertEqual((latest["runId"], latest["attempt"]), (str(expired["id"]), 1))
        self.assertIsNone(selected)
        self.assertEqual(self.requests[download], 0)
        self.assertEqual(sorted(path.name for path in self.output.iterdir()), ["history.json", "latest.json"])

    def history_record(self, number, seconds_ago=0, attempt=1):
        end = fetch.utc(AT) - timedelta(seconds=seconds_ago)
        stamp = lambda dt: dt.isoformat().replace("+00:00", "Z")
        return {**run_record(attempt), "id": RUN_ID + number,
                "created_at": stamp(end - timedelta(seconds=30)),
                "run_started_at": stamp(end - timedelta(seconds=29)), "updated_at": stamp(end)}

    def provide_history(self, run, outcome=None, **kwargs):
        delta = fetch.utc(run["updated_at"]) - fetch.utc(AT)

        def transform(evidence):
            def shift(value):
                if isinstance(value, dict):
                    return {key: shift(item) for key, item in value.items()}
                if isinstance(value, list):
                    return [shift(item) for item in value]
                if isinstance(value, str) and value.startswith("2026-11-16T"):
                    return (fetch.utc(value) + delta).isoformat().replace("+00:00", "Z")
                return value
            evidence = shift(evidence)
            if outcome:
                row = evidence["snapshot"]["rooms"][0]
                row.update(code=outcome, live_status="live" if outcome == "OK" else "offline",
                           live_id="80000000001" if outcome == "OK" else None,
                           reason=None, diagnostics={"identity_verified": True, "network": {"allowed": 1},
                           "passive_observation": {"navigation_attempted": True},
                           "offline_evidence": outcome == "OFFLINE", "offline_rule_validated": outcome == "OFFLINE"})
            return evidence
        return self.provide(run, transform=transform, completed_at=run["updated_at"], **kwargs)

    def history_manifest(self):
        return json.loads((self.output / "history.json").read_text())

    def test_history_keeps_all_rounds_including_intervening_offline_and_original_current_bytes(self):
        older, offline, newer, current = [self.history_record(n, (3 - n) * 1800) for n in range(4)]
        self.provide_history(older, "OK")
        self.provide_history(offline, "OFFLINE")
        self.provide_history(newer, "OK")
        self.provide_history(current)
        _, selected = self.acquire([current, newer, offline, older])
        self.assertEqual(selected["runId"], str(current["id"]))
        manifest = self.history_manifest()
        self.assertEqual(manifest, {"status": "complete", "entries": [
            f"history/{run['id']}-1" for run in (newer, offline, older)]})
        offline_snapshot = json.loads((self.output / manifest["entries"][1] / "monitor_snapshot.json").read_text())
        self.assertEqual(offline_snapshot["rooms"][0]["code"], "OFFLINE")
        with ZipFile(self.directory / f"evidence-{current['id']}-1.zip") as archive:
            for name in fetch.INPUTS:
                self.assertEqual((self.output / name).read_bytes(), archive.read(name))

    def test_history_excludes_old_runs_without_requesting_their_jobs_or_archives(self):
        current = self.history_record(2)
        old = self.history_record(0, 10802)
        boundary = self.history_record(1, 10799)
        self.provide_history(current)
        self.provide_history(boundary, "OK")
        old_download = self.provide_history(old, "OK")
        self.acquire([current, boundary, old])
        self.assertEqual(self.history_manifest(), {"status": "complete", "entries": [f"history/{boundary['id']}-1"]})
        self.assertEqual(self.requests[old_download], 0)
        self.assertEqual(self.requests[f"runs/{old['id']}/attempts/1/jobs?per_page=100"], 0)

    def test_history_unavailable_when_more_than_twelve_rounds_are_in_window(self):
        rounds = [self.history_record(n, (13 - n) * 180) for n in range(14)]
        current_download = self.provide_history(rounds[-1])
        _, selected = self.acquire(list(reversed(rounds)))
        self.assertEqual(selected["runId"], str(rounds[-1]["id"]))
        self.assertEqual(self.requests[current_download], 1)
        self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})
        self.assertFalse((self.output / "history").exists())

    def test_history_accepts_exactly_twelve_prior_rounds_without_truncating(self):
        rounds = [self.history_record(n, (12 - n) * 180) for n in range(13)]
        for run in rounds:
            self.provide_history(run, "OK" if run != rounds[-1] else None)
        self.acquire(list(reversed(rounds)))
        self.assertEqual(self.history_manifest(), {"status": "complete", "entries": [
            f"history/{run['id']}-1" for run in reversed(rounds[:-1])]})

    def test_login_and_timeout_do_not_request_extra_history(self):
        for code in ("LOGIN_REQUIRED", "NAV_TIMEOUT"):
            with self.subTest(code=code):
                current, prior = self.history_record(1), self.history_record(0, 1800)

                def transform(evidence):
                    for room in evidence["snapshot"]["rooms"]:
                        if room["platform"] == "tmall":
                            room["code"] = code
                    return evidence

                self.provide(current, transform=transform)
                self.acquire([current, prior])
                self.assertEqual(self.history_manifest(), {"status": "complete", "entries": []})
                self.assertEqual(self.requests[f"runs/{prior['id']}/attempts/1/jobs?per_page=100"], 0)

    def test_missing_expired_corrupt_and_contract_rejected_middle_round_discard_all_history(self):
        for failure in ("missing", "expired", "corrupt", "contract", "parent"):
            with self.subTest(failure=failure):
                older, middle, newer, current = [self.history_record(n, (3 - n) * 1800) for n in range(4)]
                self.provide_history(current)
                self.provide_history(newer, "OK")
                older_download = self.provide_history(older, "OK")
                self.provide_history(middle, "OFFLINE", expired=failure == "expired",
                                     corrupt_member=failure == "corrupt", room_count=6 if failure == "contract" else 10)
                path = f"runs/{middle['id']}/artifacts?name=TCL_V2_Evidence_{middle['id']}_a1&per_page=100"
                if failure == "missing":
                    self.responses[path] = None
                if failure == "parent":
                    self.responses[path]["artifacts"][0]["workflow_run"]["head_sha"] = "b" * 40
                _, selected = self.acquire([current, newer, middle, older])
                self.assertEqual(selected["runId"], str(current["id"]))
                self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})
                self.assertFalse((self.output / "history").exists())
                self.assertEqual(self.requests[older_download], 0)

    def test_history_unavailable_after_pagination_failure_without_harming_current(self):
        current = self.history_record(1)
        self.provide_history(current)
        second_page = "workflows/v2-monitor.yml/runs?branch=main&status=completed&per_page=100&page=2"
        self.responses[second_page] = None
        _, selected = self.acquire([current] * 100)
        self.assertEqual(selected["runId"], str(current["id"]))
        self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})

    def test_history_unavailable_when_total_count_discloses_missing_source_rows(self):
        current = self.history_record(1)
        self.provide_history(current)
        self.acquire([current], total_count=2)
        self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})

    def test_duplicate_listing_records_cannot_claim_complete_history(self):
        current = self.history_record(1)
        self.provide_history(current)
        _, selected = self.acquire([current, current], total_count=2)
        self.assertEqual(selected["runId"], str(current["id"]))
        self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})

    def test_history_rejects_hidden_retry_attempts_even_when_latest_attempt_failed(self):
        for conclusion in ("success", "failure"):
            with self.subTest(conclusion=conclusion):
                current = self.history_record(1)
                prior = {**self.history_record(0, 1800, attempt=2), "conclusion": conclusion}
                self.provide_history(current)
                self.acquire([current, prior])
                self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})
                self.assertEqual(self.requests[f"runs/{prior['id']}/attempts/1"], 0)

    def test_history_rejects_unparseable_and_reversed_run_times(self):
        for index, changes in enumerate(({"updated_at": "invalid"}, {"run_started_at": "2026-11-16T12:59:00Z"})):
            with self.subTest(changes=changes):
                current = self.history_record(1)
                prior = {**self.history_record(0, 1800), **changes}
                self.provide_history(current)
                # Invalid updated_at would change the old selector's lexical order;
                # place it before the valid candidate so this tests history alone.
                listing = fetch.RunListing([current, prior])
                listing.complete = True
                selected_dir = self.directory / f"direct-{index}"
                selected_dir.mkdir()
                archive, artifact = create_archive(self.directory, current)
                fetch.verify_archive(archive, artifact, current, selected_dir)
                latest = {"runId": str(current["id"]), "attempt": 1, "conclusion": "success"}
                outcome = fetch.acquire_history(selected_dir, current, live_job(current), listing, latest)
                self.assertEqual(outcome, {"status": "unavailable", "entries": []})

    def test_history_rejects_archive_time_later_than_attested_job(self):
        current, prior = self.history_record(1), self.history_record(0, 1800)
        self.provide_history(current)
        self.provide_history(prior, "OK", summary_changes={"completed_utc": current["updated_at"]})
        _, selected = self.acquire([current, prior])
        self.assertEqual(selected["runId"], str(current["id"]))
        self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})

    def test_history_budget_exhaustion_preserves_already_selected_current_snapshot(self):
        current, prior = self.history_record(1), self.history_record(0, 1800)
        self.provide_history(current)
        with patch.object(fetch, "lookup_deadline", 1), patch.object(fetch.time, "monotonic", side_effect=[0, 2]):
            _, selected = self.acquire([current, prior])
        self.assertEqual(selected["runId"], str(current["id"]))
        self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})

    def test_history_no_extra_fetch_when_current_is_an_older_selection_fallback(self):
        current, prior = self.history_record(1), self.history_record(0, 1800)
        self.provide_history(current, expired=True)
        self.provide_history(prior, "OK")
        latest, selected = self.acquire([current, prior])
        self.assertEqual(latest["runId"], str(current["id"]))
        self.assertEqual(selected["runId"], str(prior["id"]))
        self.assertEqual(self.history_manifest(), {"status": "unavailable", "entries": []})
