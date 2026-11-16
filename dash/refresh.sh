#!/bin/bash
# Refresh both result pages' data from the latest usable GitHub Actions runs.
# Usage: bash refresh.sh   (needs node 18+ and gh with read access to the repo; optional NEXT_REFRESH="11-15 21:10" for the page,
#        MAIN_DIR=<folder for config copies> default /tmp/mainsrc)
# Output: out/{jd,douyin,tmall,runs,samples}.json  -> upload the first four to the dashboard (Data artifact)
#         universal/index.html                     -> publish to the universal page (HTML artifact)
# Fails closed: any problem -> non-zero exit, and nothing should be uploaded or published.
set -u
set -o pipefail   # a failed gh call inside a pipeline (gh api ... | base64 -d) must fail, not write an empty file
cd "$(dirname "$0")"
MAIN_DIR=${MAIN_DIR:-/tmp/mainsrc}; export MAIN_DIR
R=lijianjun004-star/tcl-live-monitor

# pick WORKFLOW_ID GREP_PATTERN OUTFILE : newest successful run whose log matches; log saved to OUTFILE.
# (log goes to a file first: `gh ... | grep -q` under pipefail breaks on SIGPIPE)
pick() {
  local wf="$1" pat="$2" out="$3" id ids
  # Eight runs can all be cooldown/no-sample runs. Search up to 100 MAIN runs.
  ids=$(gh api "repos/$R/actions/workflows/$wf/runs?per_page=100&status=success&branch=main" --jq '.workflow_runs[].id') || { echo "RUN_LIST_FAILED workflow=$wf" >&2; return 1; }
  for id in $ids; do
    gh run view "$id" -R "$R" --log > "$out.tmp" 2>/dev/null || { echo "LOG_UNAVAILABLE run=$id" >&2; continue; }
    if grep -q -- "$pat" "$out.tmp"; then mv "$out.tmp" "$out"; echo "$id"; return 0; fi
  done
  rm -f "$out.tmp"
  return 1
}

JD=$(pick 417538022 'R327_JD_DAY ' jd.log) || { echo "NO_JD_RUN_WITH_DATA"; exit 1; }
# A run skipped by the 24-hour cooldown still prints the ledger but samples nothing: use the newest run that sampled.
DY=$(pick 417529171 'R316_RPA {' dy.log) || { echo "NO_DOUYIN_RUN_WITH_DATA"; exit 1; }
TM=$(pick 417885046 'R329_TMALL {' tm.log) || { echo "NO_TMALL_RUN_WITH_DATA"; exit 1; }
echo "runs: jd=$JD douyin=$DY tmall=$TM"

# Registry config from main: used by the leak check, and by names.mjs for the store names shown on the universal page.
mkdir -p "$MAIN_DIR"
for f in probe-targets.json r316-douyin-rpa-targets.json r326-douyin-targets-scoring-b.json r329-douyin-targets-monitor-c.json r329-douyin-targets-monitor-d.json; do
  gh api "repos/$R/contents/config/$f?ref=main" --jq '.content' | base64 -d > "$MAIN_DIR/main-$f" || { echo "CONFIG_FETCH_FAILED $f"; exit 1; }
done
RUN_JD=$JD RUN_DY=$DY RUN_TM=$TM node build.mjs || { echo "BUILD_FAILED"; exit 1; }

echo "Using approved, versioned display-name map"

# Every successful Douyin/Tmall run of the latest broadcast day (06:00 Beijing onwards), for the sampling timeline.
SINCE=$(node -e '
const fs=require("fs"); const d=["douyin","tmall"].map(f=>JSON.parse(fs.readFileSync("out/"+f+".json","utf8")).rows.reduce((m,x)=>x.date>m?x.date:m,"")).sort()[0];
console.log(new Date(Date.parse(d+"T06:00:00+08:00")-15*60e3).toISOString().slice(0,19)+"Z")') || { echo "SINCE_FAILED"; exit 1; }
rm -rf runs && mkdir -p runs
for pair in dy:417529171 tm:417885046; do
  p=${pair%%:*}; wf=${pair##*:}
  for id in $(gh api "repos/$R/actions/workflows/$wf/runs?per_page=100&status=success&branch=main&created=>=$SINCE" --jq '.workflow_runs[].id'); do
    gh run view "$id" -R "$R" --log > "runs/$p-$id.log" 2>/dev/null || { echo "LOG_FETCH_FAILED $id"; rm -f "runs/$p-$id.log"; }
  done
done
echo "timeline logs since $SINCE: $(ls runs | tr '\n' ' ')"
node samples.mjs || { echo "SAMPLES_FAILED"; exit 1; }
node render.mjs || { echo "RENDER_FAILED"; exit 1; }

# privacy check: no registry identifier (key, secUid, Douyin ID, live room ID, Tmall account ID or room number)
# may appear in the datasets or the page. Store names are allowed on the universal page only (user request 11-14 21:25).
node leakcheck.mjs out/*.json universal/index.html || { echo "LEAK_FOUND_DO_NOT_UPLOAD"; exit 2; }
node -e 'const fs=require("fs");const n=JSON.parse(fs.readFileSync("private/names.json","utf8")).names;const t=["jd","douyin","tmall","runs"].map(f=>fs.readFileSync("out/"+f+".json","utf8")).join("");const hit=Object.values(n).filter(x=>t.includes(x.name));if(hit.length){console.log("NAMES_IN_DATASETS",hit.length);process.exit(2)}console.log("DATASETS_STAY_CODED")' || { echo "LEAK_FOUND_DO_NOT_UPLOAD"; exit 2; }
ls -l out/*.json universal/index.html
