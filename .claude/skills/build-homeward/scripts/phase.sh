#!/usr/bin/env bash
# phase.sh — bookkeeping for the build-homeward skill.
#
# The skill (SKILL.md) tells Claude WHAT to do in each phase. This script does the parts that
# must be exact every time: which phase is next, progress and ETA, the build-check gate, the
# per-phase git commit, and the on-disk "done" markers that make the run resumable.
#
#   phase.sh next              print the next unfinished phase, its model and effort, or ALL DONE
#   phase.sh resolve <X>       find ONE named phase (number like 22, its name, or a unique part of it) and print it
#                              like `next` does, plus its state and any earlier phases not done (for `only X`)
#   phase.sh begin  <phase>    start a phase (banner, timing, status file); a finished phase is re-opened
#   phase.sh check             run the build check for the current phase (counts failed attempts)
#   phase.sh finish <phase>    commit, mark done, print progress (refused until the check passed)
#   phase.sh status            phase table + live state (prints ALL PHASES COMPLETE at the end)
#   phase.sh reset             forget all progress
#
# Optional config: skill-dir/config.env (see config.env.example). Environment variables also work:
#   CHECK_CMD   command run by `check`. Default: "npm run lint", "npm run typecheck" and "npm run build",
#               whichever package.json defines, chained with &&; fails until there is a package.json with at least one.
#               Set CHECK_CMD="" to disable the check.
#   MAX_FIX     failed checks allowed before the script says STOP (default 2 fix attempts)
#   GIT_COMMIT  1 = commit after each phase (default), 0 = don't
#   GIT_PUSH    1 = push after each commit (default), 0 = don't. Pushes the current branch;
#               sets the upstream on origin the first time.
#   PROMPT_DIR  prompts      LOG_DIR  logs

set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
[[ -f "$SKILL_DIR/config.env" ]] && . "$SKILL_DIR/config.env"

PROMPT_DIR="${PROMPT_DIR:-prompts}"
LOG_DIR="${LOG_DIR:-logs}"
GIT_COMMIT="${GIT_COMMIT:-1}"
GIT_PUSH="${GIT_PUSH:-1}"
PUSH_REMOTE="${PUSH_REMOTE:-origin}"
MAX_FIX="${MAX_FIX:-2}"
CHECK_TAIL="${CHECK_TAIL:-60}"
CHECK_CMD="${CHECK_CMD-__auto__}"
if [[ "$CHECK_CMD" == "__auto__" ]]; then
  CHECK_CMD=""
  if [[ -f package.json ]]; then
    for s in lint typecheck build; do
      if grep -Eq "\"$s\"[[:space:]]*:" package.json; then CHECK_CMD="${CHECK_CMD:+$CHECK_CMD && }npm run $s"; fi
    done
  fi
  # every phase builds the site, so with nothing to run the check must fail rather than pass by default
  if [[ -z "$CHECK_CMD" ]]; then
    CHECK_CMD='echo "no package.json with a lint, typecheck or build script yet: scaffold the app first" >&2; false'
  fi
fi

MODELS_FILE="${MODELS_FILE:-$PROMPT_DIR/models.conf}"
DEFAULT_MODEL="${DEFAULT_MODEL:-sonnet}"
DEFAULT_EFFORT="${DEFAULT_EFFORT:-medium}"
STATUS_FILE="$LOG_DIR/status.txt"
mkdir -p "$LOG_DIR"

die() { echo "phase.sh: $*" >&2; exit 2; }

shopt -s nullglob
files=("$PROMPT_DIR"/[0-9][0-9]*.md)
total=${#files[@]}
(( total > 0 )) || die "no prompt files found in $PROMPT_DIR/ (expected 01-name.md, 02-name.md, ...)"
names=()
for f in "${files[@]}"; do names+=("$(basename "$f" .md)"); done

now() { date +%s; }

# conf_for NAME -> "<model> <effort>" from models.conf ("<NN or name> <model> [effort]", # comments allowed)
conf_for() {
  local name="$1" num="${1%%-*}" key m e
  if [[ -f "$MODELS_FILE" ]]; then
    while read -r key m e _; do
      [[ -z "$key" || "$key" == \#* ]] && continue
      if [[ "$key" == "$num" || "$key" == "$name" ]]; then
        [[ -z "$e" || "$e" == \#* ]] && e="$DEFAULT_EFFORT"
        echo "$m $e"; return
      fi
    done <"$MODELS_FILE"
  fi
  echo "$DEFAULT_MODEL $DEFAULT_EFFORT"
}
model_for()  { local c; c="$(conf_for "$1")"; echo "${c%% *}"; }
effort_for() { local c; c="$(conf_for "$1")"; echo "${c##* }"; }

fmt_dur() {
  local s="${1:-0}"; (( s < 0 )) && s=0
  if   (( s >= 3600 )); then printf '%dh%02dm' $((s / 3600)) $((s % 3600 / 60))
  elif (( s >= 60 ));   then printf '%dm%02ds' $((s / 60)) $((s % 60))
  else printf '%ds' "$s"; fi
}

bar() {
  local n="$1" t="$2" w=20 f i out=""
  f=$(( t > 0 ? n * w / t : 0 ))
  for (( i = 0; i < w; i++ )); do if (( i < f )); then out+="█"; else out+="░"; fi; done
  printf '%s' "$out"
}

done_count() {
  local c=0 n
  for n in "${names[@]}"; do
    if [[ -f "$LOG_DIR/$n.done" ]]; then c=$((c + 1)); fi
  done
  echo "$c"
}

index_of() {
  local i
  for i in "${!names[@]}"; do
    if [[ "${names[$i]}" == "$1" ]]; then echo $((i + 1)); return 0; fi
  done
  return 1
}

eta_text() {
  local remaining sum=0 cnt=0 n s
  remaining=$(( total - $(done_count) ))
  if (( remaining <= 0 )); then printf 'finished'; return; fi
  for n in "${names[@]}"; do
    if [[ -f "$LOG_DIR/$n.secs" ]]; then s="$(cat "$LOG_DIR/$n.secs")"; sum=$((sum + s)); cnt=$((cnt + 1)); fi
  done
  if (( cnt > 0 )); then printf '~%s left (rough)' "$(fmt_dur $(( sum / cnt * remaining )))"; else printf 'estimating'; fi
}

overall_line() {
  local d pct start=0
  d="$(done_count)"; pct=$(( d * 100 / total ))
  [[ -f "$LOG_DIR/.run_start" ]] && start="$(cat "$LOG_DIR/.run_start")"
  (( start > 0 )) || start="$(now)"
  printf 'overall [%s] %d/%d phases · %d%% · elapsed %s · %s' \
    "$(bar "$d" "$total")" "$d" "$total" "$pct" "$(fmt_dur $(( $(now) - start )))" "$(eta_text)"
}

# write_status "<phase>" "<state>"  -> logs/status.txt
write_status() {
  local phase="$1" state="$2" idx=0 pstart=0 tmp="$STATUS_FILE.tmp"
  idx="$(index_of "$phase" 2>/dev/null || echo 0)"
  [[ -f "$LOG_DIR/$phase.start" ]] && pstart="$(cat "$LOG_DIR/$phase.start")"
  (( pstart > 0 )) || pstart="$(now)"
  {
    echo "phase:      ${idx}/${total} ${phase}"
    echo "state:      ${state}"
    echo "phase time: $(fmt_dur $(( $(now) - pstart )))"
    echo "$(overall_line)"
    echo "updated:    $(date '+%F %T')"
  } >"$tmp" && mv "$tmp" "$STATUS_FILE"
}

current_phase() { cat "$LOG_DIR/.current" 2>/dev/null || true; }

cmd_next() {
  local i n
  for i in "${!names[@]}"; do
    n="${names[$i]}"
    if [[ ! -f "$LOG_DIR/$n.done" ]]; then
      echo "PHASE $((i + 1))/$total $n $PROMPT_DIR/$n.md $(model_for "$n") $(effort_for "$n")"
      return 0
    fi
  done
  echo "ALL DONE"
}

# resolve <number | name | part of a name> -> the one phase named, like `next` prints it, then its state.
# Used by `/build-orange only X`. Exits 2 (listing the candidates) when nothing or several match.
cmd_resolve() {
  local q="$*" n i padded
  local hits=() undone=()
  q="${q#[Pp]hase}"; q="${q# }"; q="${q#-}"      # "phase 22" and "phase-22" mean 22
  [[ -n "$q" ]] || die "usage: phase.sh resolve <number | name | part of a name>"
  if [[ "$q" =~ ^[0-9]+$ ]]; then
    printf -v padded '%02d' "$((10#$q))"
    for n in "${names[@]}"; do
      if [[ "${n%%-*}" == "$padded" ]]; then hits+=("$n"); fi
    done
  else
    for n in "${names[@]}"; do
      if [[ "$n" == "$q" ]]; then hits=("$n"); break; fi
    done
    if (( ${#hits[@]} == 0 )); then
      for n in "${names[@]}"; do
        if [[ "$n" == *"$q"* ]]; then hits+=("$n"); fi
      done
    fi
  fi
  if (( ${#hits[@]} == 0 )); then
    echo "NO SUCH PHASE: '$q'. The phases are:" >&2
    printf '  %s\n' "${names[@]}" >&2
    exit 2
  fi
  if (( ${#hits[@]} > 1 )); then
    echo "AMBIGUOUS: '$q' matches several phases:" >&2
    printf '  %s\n' "${hits[@]}" >&2
    exit 2
  fi
  n="${hits[0]}"
  echo "PHASE $(index_of "$n")/$total $n $PROMPT_DIR/$n.md $(model_for "$n") $(effort_for "$n")"
  if [[ -f "$LOG_DIR/$n.done" ]]; then echo "STATE done (it will be re-run over the existing code)"; else echo "STATE pending"; fi
  for i in "${names[@]}"; do
    if [[ "$i" == "$n" ]]; then break; fi
    if [[ ! -f "$LOG_DIR/$i.done" ]]; then undone+=("$i"); fi
  done
  if (( ${#undone[@]} > 0 )); then echo "NOTE earlier phases not done: ${undone[*]}"; fi
}

cmd_begin() {
  local name="${1:-}" idx resume=""
  [[ -n "$name" ]] || die "usage: phase.sh begin <phase>"
  [[ -f "$PROMPT_DIR/$name.md" ]] || die "no such phase: $name"
  idx="$(index_of "$name")"
  if [[ -f "$LOG_DIR/$name.done" ]]; then
    # `only X` on a finished phase: re-open it, so a run that fails leaves it unfinished rather than falsely done
    resume=" (re-running a finished phase: its earlier work is already in the repo)"
    rm -f "$LOG_DIR/$name.done" "$LOG_DIR/$name.secs"
  elif [[ -f "$LOG_DIR/$name.start" ]]; then
    resume=" (resuming a phase that was interrupted: check the repo for work already done)"
  fi
  [[ -f "$LOG_DIR/.run_start" ]] || now >"$LOG_DIR/.run_start"
  now >"$LOG_DIR/$name.start"
  rm -f "$LOG_DIR/$name.checked" "$LOG_DIR/$name.fails"
  echo "$name" >"$LOG_DIR/.current"
  echo "================================"
  echo "Phase $idx/$total · $name · model: $(model_for "$name") · effort: $(effort_for "$name")$resume"
  overall_line; echo
  echo "================================"
  write_status "$name" "working"
}

cmd_check() {
  local name rc fails
  name="$(current_phase)"
  [[ -n "$name" ]] || die "no phase in progress: run phase.sh begin <phase> first"

  if [[ -z "$CHECK_CMD" ]]; then
    touch "$LOG_DIR/$name.checked"
    echo "No build check configured (set CHECK_CMD in config.env). Treated as passed."
    return 0
  fi

  write_status "$name" "checking: $CHECK_CMD"
  echo "Running check: $CHECK_CMD"
  set +e
  bash -c "$CHECK_CMD" >"$LOG_DIR/$name.check.log" 2>&1
  rc=$?
  set -e

  if (( rc == 0 )); then
    touch "$LOG_DIR/$name.checked"
    rm -f "$LOG_DIR/$name.fails"
    echo "CHECK PASSED: $CHECK_CMD"
    write_status "$name" "check passed"
    return 0
  fi

  rm -f "$LOG_DIR/$name.checked"
  fails=$(( $(cat "$LOG_DIR/$name.fails" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" >"$LOG_DIR/$name.fails"
  echo "CHECK FAILED (exit $rc): $CHECK_CMD"
  echo "--- last $CHECK_TAIL lines of $LOG_DIR/$name.check.log ---"
  tail -n "$CHECK_TAIL" "$LOG_DIR/$name.check.log"
  echo "---"
  if (( fails > MAX_FIX )); then
    write_status "$name" "STOPPED: check still failing after $MAX_FIX fix attempts"
    echo "STOP: the check has failed $fails times (limit: $MAX_FIX fix attempts). Do not continue. Report the failure to the user."
  else
    write_status "$name" "fixing a failed check (attempt $fails/$MAX_FIX)"
    echo "Fix the underlying cause (do not disable or weaken the check), then run phase.sh check again. Fix attempt $fails of $MAX_FIX."
  fi
  exit 1
}

# push the current branch (all unpushed commits, so a failed push catches up next time)
push_branch() {
  local branch out
  branch="$(git branch --show-current)"
  [[ -n "$branch" ]] || { echo "PUSH FAILED: detached HEAD, nothing pushed."; return 1; }
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    out="$(git push 2>&1)" || { echo "PUSH FAILED: $out" | tail -n 5; return 1; }
  else
    local remote="$PUSH_REMOTE"
    if ! git remote | grep -qx "$remote"; then remote="$(git remote | head -n 1)"; fi
    [[ -n "$remote" ]] || { echo "PUSH FAILED: this repo has no git remote."; return 1; }
    out="$(git push -u "$remote" "$branch" 2>&1)" || { echo "PUSH FAILED: $out" | tail -n 5; return 1; }
  fi
  echo "Pushed: $branch -> $(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "$PUSH_REMOTE/$branch")"
}

cmd_finish() {
  local name="${1:-}" before after msg_file secs start=0 steps_left push_failed=0
  [[ -n "$name" ]] || die "usage: phase.sh finish <phase>"
  [[ -f "$PROMPT_DIR/$name.md" ]] || die "no such phase: $name"
  if [[ ! -f "$LOG_DIR/$name.checked" ]]; then
    echo "REFUSED: the build check has not passed for $name. Run phase.sh check (and fix any failures) first." >&2
    exit 1
  fi

  # commit: header + description from prompts/<phase>.commit; the prompts, the skill and the asset tools are left out
  if [[ "$GIT_COMMIT" == 1 ]] && ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "STOP: this folder is not a git repository, so nothing can be committed or pushed. Run 'git init' and add a remote, then finish this phase again." >&2
    exit 1
  fi
  if [[ "$GIT_COMMIT" == 1 ]]; then
    before="$(git rev-parse -q --verify HEAD 2>/dev/null || echo none)"
    git add -A -- . ":!$LOG_DIR" ":!$PROMPT_DIR" ":!.claude" ":!tools" ":!art/prompts.json" >/dev/null 2>&1 || true
    msg_file="$PROMPT_DIR/$name.commit"
    if [[ -f "$msg_file" ]]; then
      git commit -q -F "$msg_file" >/dev/null 2>&1 || true
    else
      git commit -q -m "$(printf 'chore: %s\n\nCompleted build step %s.' "$(sed -E 's/^[0-9]+-//; s/-/ /g' <<<"$name")" "${name%%-*}")" >/dev/null 2>&1 || true
    fi
    after="$(git rev-parse -q --verify HEAD 2>/dev/null || echo none)"
    if [[ "$before" != "$after" ]]; then echo "Committed: $(git log -1 --format=%s)"; else echo "Nothing to commit for this phase."; fi
    if [[ "$GIT_PUSH" == 1 ]]; then push_branch || push_failed=1; fi
  fi

  [[ -f "$LOG_DIR/$name.start" ]] && start="$(cat "$LOG_DIR/$name.start")"
  if (( start > 0 )); then secs=$(( $(now) - start )); else secs=0; fi
  echo "$secs" >"$LOG_DIR/$name.secs"
  touch "$LOG_DIR/$name.done"
  rm -f "$LOG_DIR/.current"

  echo "✓ phase $(index_of "$name")/$total finished in $(fmt_dur "$secs")"
  if (( push_failed )); then
    echo "STOP: the commit is saved locally but the push failed. Fix access to the remote, run 'git push', then continue."
  fi
  overall_line; echo
  steps_left=$(( total - $(done_count) ))
  if (( steps_left == 0 )); then
    write_status "$name" "ALL PHASES COMPLETE"
    echo "ALL PHASES COMPLETE"
  else
    write_status "$name" "phase finished"
    echo "Next up: $(cmd_next)"
  fi
}

cmd_status() {
  local n cur
  cur="$(awk '/^phase:/ {print $3}' "$STATUS_FILE" 2>/dev/null || true)"
  for n in "${names[@]}"; do
    if   [[ -f "$LOG_DIR/$n.done" ]]; then printf '  ✓ %-7s %-7s %s\n' "$(model_for "$n")" "$(effort_for "$n")" "$n"
    elif [[ "$n" == "$cur" || "$n" == "$(current_phase)" ]]; then printf '  → %-7s %-7s %s\n' "$(model_for "$n")" "$(effort_for "$n")" "$n"
    else printf '  · %-7s %-7s %s\n' "$(model_for "$n")" "$(effort_for "$n")" "$n"; fi
  done
  echo
  overall_line; echo
  if [[ -f "$STATUS_FILE" ]]; then sed -n '1,3p;5p' "$STATUS_FILE"; fi
  if (( $(done_count) == total )); then echo "ALL PHASES COMPLETE"; fi
}

cmd_reset() {
  rm -f "$LOG_DIR"/*.done "$LOG_DIR"/*.start "$LOG_DIR"/*.secs "$LOG_DIR"/*.checked \
        "$LOG_DIR"/*.fails "$LOG_DIR/.current" "$LOG_DIR/.run_start" "$STATUS_FILE"
  echo "Progress cleared. Next: $(cmd_next)"
}

case "${1:-}" in
  next)   cmd_next ;;
  resolve) shift; cmd_resolve "$@" ;;
  begin)  shift; cmd_begin "$@" ;;
  check)  cmd_check ;;
  finish) shift; cmd_finish "$@" ;;
  status) cmd_status ;;
  reset)  cmd_reset ;;
  *) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
