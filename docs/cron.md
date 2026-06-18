# Recurring jobs (cron)

Scheduled prompts: at each occurrence the backend executes the job's prompt
against its agent **as the creating user** — same memory scope, same tools —
and saves the result as a new private conversation in the creator's sidebar.
One-time jobs double as reminders.

## Data model (`lib/global/schema.ts`)

- `cron_jobs` — one row per job: `agent_id`, `user_id` (creator; runs use their
  identity), `title` (display name; NULL → the runner generates one with the
  job's model on the next run and saves it), `prompt`, `days_of_week` (int[],
  0 = Sunday … 6 = Saturday), `time` ("HH:MM"), `recurrence`
  (`once | weekly | biweekly | monthly`), `timezone` (IANA name captured from
  the creator's browser), optional `provider`/`model`, `paused` (bool, default
  `false` — paused jobs stay in the list but the scheduler skips them), and
  `next_run_at` — the precomputed absolute instant the scheduler polls on.
- `cron_job_runs` — run history. Rows are **self-contained** (own `user_id`,
  `agent_id`, `title`, `prompt` copies; `job_id` is `set null` on job deletion)
  because `once` jobs delete themselves after succeeding and the record that
  they ran must survive. `conversation_id` links to the run's output
  conversation. Display uses `title`, falling back to `prompt`.

## Scheduling semantics (`lib/agent/cron-schedule.ts`)

All times are wall-clock in the job's timezone; conversion to UTC instants is
done with `Intl` (DST-aware, no date library).

- **weekly** — every selected weekday at the given time.
- **biweekly** — selected weekdays of an "on" week, then a week is skipped.
  Remaining selected days of the current week still run after one fires
  (week identity = Sunday-start week index in the job's timezone).
- **monthly** — the first occurrence of a selected weekday that lands in a
  later calendar month.
- **once** — runs at `next_run_at`, then the job deletes itself (only after a
  *successful* run; failures keep the job on a weekly retry cadence). Created
  either from days+time (next occurrence) or from an absolute `at` datetime.

## Scheduler (`lib/agent/cron.ts`)

`startCronScheduler()` (wired in `index.ts`, `CRON=off` disables) ticks every
60s: it loads jobs with `next_run_at <= now` **and `paused = false`**, advances
`next_run_at` with a compare-and-swap (`claimCronJob`) so overlapping ticks or a
second server never double-run a job, then runs each claimed job. A job missed
during downtime runs once and skips ahead — no catch-up backlog.

Runs mirror the chat route's prompt assembly (base prompt + agent prompt +
memory + search/files/notes tools) but use non-streaming `generateText`. The
model is the job's stored `provider`/`model` resolved against the creator's
provider settings at run time, falling back to the env default if unset or
deconfigured. The conversation row is persisted before generation (parity with
the chat route), then updated with the assistant's reply.

## API (`api/agent/jobs*.ts`)

- `GET /agent/jobs` — the caller's jobs, with agent names.
- `POST /agent/jobs` — create; body: `agent_id`, `prompt`, `recurrence`,
  `timezone`, and either `days_of_week`+`time` or `at` (ISO datetime, `once`
  only), plus optional `title` and `provider`/`model` (validated like a chat
  request).
- `PATCH /agent/jobs` — partial update, creator only. Any schedule field
  reschedules from now; `title: null` clears the title (regenerated on the
  next run); `provider: null` returns the job to the env default model;
  `paused: true|false` pauses/resumes the job (resuming recomputes
  `next_run_at` from now so a slot missed during the pause doesn't fire).
- `DELETE /agent/jobs?id=` — creator only.
- `GET /agent/jobs/runs` — run history (self-contained rows + agent name).
- `POST /agent/jobs/trigger` — manual run, creator only. Returns 202 and runs
  in the background (model calls can outlive proxy timeouts); `next_run_at`
  is untouched. The UI polls the runs list until the run lands.

## Agent tools (`lib/agent/cron-tools.ts`)

`buildCronTools(scope)` gives the chat agent `scheduleJob`,
`listScheduledJobs`, `updateScheduledJob`, and `cancelScheduledJob`, scoped to
the current agent + user. The chat request body carries the sender's IANA
`timezone` (sent by the UI on every turn, server timezone as fallback) so
"tomorrow at 9" means the user's 9 o'clock; new jobs pin the chat's current
`provider`/`model`. `buildCronToolsPrompt(timezone)` documents the tools in the
system prompt and is stable per session (KV-cache friendly).

## UI (`agent-ui`)

Sidebar → **Recurring Jobs** opens a dialog: run history + scheduled jobs
(each shows an active/paused status and has pause-resume, run-now, and delete
controls), and a create form (multi-select day chips,
time, recurrence incl. **Once**, agent, model picker mirroring the chat's
selector, prompt). Clicking a successful run opens its conversation. After a
manual trigger the dialog polls `GET /agent/jobs/runs` (~3s interval, up to
5 min) and toasts the outcome.

## Testing

- `test/unit/cron.test.ts` — occurrence/recurrence math (incl. DST and
  multi-day biweekly) and the DB layer (claim CAS, run-history scoping,
  survival of runs after job deletion).
- `test/api/jobs.test.ts` — route auth/validation, `at` handling, and the
  async trigger → run-recorded pipeline (membership is sabotaged so the run
  fails before touching a model; the api tier has none).
- The schedulers in test servers are harmless: jobs are always created with a
  future `next_run_at`.
