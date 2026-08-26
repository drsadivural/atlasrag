# Never wait forever

The single worst failure mode is a task that never finishes: a poll loop waiting
for a condition that has already become impossible, because the thing that was
supposed to change the value died. Example: waiting for
`anthropic_models + gemini_models >= 20` while the Gemini sync has failed, so the
count is frozen at 12 forever. No error is raised, nothing crashes, the task just
shows "running" until the user kills it.

Assume any wait I write will eventually face a dead producer. Write it so that
case terminates.

---

## Hard rules

**1. Every wait is bounded — three bounds, always.**
No `while (true)`, no unbounded `for`, no naked `await` on something that may
never resolve. Each wait must carry:

- `max_attempts`
- per-attempt `timeout`
- an absolute `deadline` (wall-clock)

When a bound is hit, stop and report. Never extend a bound at runtime, never
"just one more round."

**2. Write the give-up branch before the success branch.**
If I can't say what happens when the condition is never met, I'm not allowed to
start the loop. The abandoned path must produce a result — partial data plus the
reason — not an exception swallowed by a retry.

**3. Poll the producer, not only the counter.**
The counter is a symptom. Every iteration, also check the health of whatever is
supposed to move it: process exit code, job status, last-error field, heartbeat
timestamp, log tail. If the producer is dead, failed, or has not touched anything
since the previous poll → abandon **immediately**. Do not wait out the timeout on
a corpse.

**4. Never wait on an aggregate condition.**
`a + b >= N` hides which side is broken and turns one failure into an infinite
wait. Wait on each source separately, each with its own bound and its own
failure, then combine the results:

```
anthropic: ok (12)
gemini:    FAILED after 3 attempts — auth error on models.list
total:     12/20 — threshold not reachable, aborting
```

**5. Detect stall, not just timeout.**
Record the observed value on every attempt. If it is unchanged for 3 consecutive
polls **and** the producer shows no activity, the wait is over — no amount of
extra time fixes it. Abort with "stalled at X" rather than burning the full
deadline.

**6. Log every attempt, one line, always visible.**
Silence is what turns a stuck wait into a mystery. Format:
`attempt 4/20 | total=12 (Δ0) | anthropic=12 ok | gemini=0 err=auth | 38s/300s`
If I cannot see progress in the log, neither can the user.

**7. Prefer events to thresholds.**
In order of preference: process exit / promise from the job itself → explicit job
status endpoint (`succeeded|failed|running`) → sentinel file → value polling.
Value polling is the last resort because it cannot distinguish "not yet" from
"never."

**8. A threshold I don't control is never a precondition.**
Don't gate my own work on an external count, an external service reaching a
state, or a number someone else populates. Fetch what exists, proceed with it,
and report the shortfall. External state is an input, not a gate.

**9. Retries need a circuit breaker.**
Identical inputs that failed twice will fail the third time. Retry only when
something changed (backoff elapsed, token refreshed, different endpoint). Cap
backoff (e.g. 30s) and cap total retry budget. Never retry a 4xx-class /
deterministic failure at all.

**10. Nothing in bash may block on stdin or stream forever.**

- Wrap anything network- or process-bound: `timeout 60 <cmd>`
- `--no-pager`, `-y`, `--yes`, `--non-interactive`, `</dev/null`
- Never `tail -f`, `watch`, `journalctl -f`, `docker logs -f`, or a dev server in
  the foreground
- Background long-lived processes and probe readiness with a **bounded** curl
  loop; kill them in a trap on exit

**11. Partial success is a deliverable, not a reason to keep waiting.**
12 of 20 models, clearly labelled, with the reason for the missing 8, is a
finished task. Blocking indefinitely for the other 8 is not.

**12. When genuinely blocked, surface it and stop.**
A blocked task gets marked blocked and reported to the user with: what I was
waiting for, what I observed, what I tried, and the two or three options for
unblocking. Do not silently absorb a blocker by waiting.

---

## Reference pattern — bash

```bash
wait_for() {                      # wait_for <desc> <max_attempts> <sleep> <check_cmd> <producer_health_cmd>
  local desc="$1" max="$2" gap="$3" check="$4" health="$5"
  local i last="" cur stall=0
  for ((i=1; i<=max; i++)); do
    cur="$(eval "$check" 2>&1)"
    echo "attempt $i/$max | $desc=$cur"
    [[ "$cur" == "READY" ]] && return 0

    if ! eval "$health" >/dev/null 2>&1; then
      echo "ABORT: producer for '$desc' is not healthy — condition unreachable"
      return 2
    fi
    if [[ "$cur" == "$last" ]]; then
      ((stall++))
      if ((stall >= 3)); then
        echo "ABORT: '$desc' stalled at '$cur' for 3 polls"
        return 3
      fi
    else
      stall=0
    fi
    last="$cur"
    sleep "$gap"
  done
  echo "ABORT: '$desc' exceeded $max attempts (last: $last)"
  return 1
}
```

## Reference pattern — TypeScript / Node

```ts
async function waitFor<T>(opts: {
  label: string;
  poll: () => Promise<T>;
  done: (v: T) => boolean;
  producerAlive: () => Promise<boolean>;
  maxAttempts?: number;
  intervalMs?: number;
  deadlineMs?: number;
}): Promise<{ ok: boolean; value: T | null; reason: string }> {
  const { label, poll, done, producerAlive } = opts;
  const maxAttempts = opts.maxAttempts ?? 20;
  const intervalMs = opts.intervalMs ?? 3000;
  const deadline = Date.now() + (opts.deadlineMs ?? 120_000);

  let last: string | null = null,
    stall = 0,
    value: T | null = null;

  for (let i = 1; i <= maxAttempts; i++) {
    if (Date.now() > deadline) return { ok: false, value, reason: `${label}: deadline exceeded` };

    value = await poll();
    const snap = JSON.stringify(value);
    console.log(`attempt ${i}/${maxAttempts} | ${label}=${snap}`);

    if (done(value)) return { ok: true, value, reason: 'satisfied' };

    if (!(await producerAlive()))
      return { ok: false, value, reason: `${label}: producer dead — condition unreachable` };

    stall = snap === last ? stall + 1 : 0;
    if (stall >= 3) return { ok: false, value, reason: `${label}: stalled at ${snap}` };
    last = snap;

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, value, reason: `${label}: attempts exhausted (last ${last})` };
}
```

---

## Pre-flight checklist — run before writing any loop or wait

- [ ] Bounded by attempts **and** wall-clock deadline?
- [ ] Is there an explicit give-up branch that returns a result?
- [ ] Does each iteration check the _producer's_ health, not just the value?
- [ ] Is the condition per-source rather than an aggregate?
- [ ] Is stall (value unchanged + no activity) detected separately from timeout?
- [ ] Does every attempt print a line showing value and delta?
- [ ] Could this be an event/exit-code wait instead of a poll?
- [ ] Is every shell command timeout-wrapped and non-interactive?
- [ ] Do retries stop on deterministic failures?
- [ ] If I hit the bound, is the partial result still useful to the user?
