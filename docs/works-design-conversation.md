# Works / Goals feature — design conversation transcript

Verbatim copy of the design conversation (2026-06-10) about artifact storage and the
"work/goal" multi-agent orchestration feature. Stored as-is for reference.

---

# User

I want to implement storage for artifacts and a "goal" functionality that keep agents running:
- I don't know how it works in docker but there should be a way to simply read and write files from the node process, maybe attaching a folder from the file system?
- A work or goal is a process that keeps one or more agents running towards a common goal. for example: "Write a multi-page article about what's new in Shopify in 2026", the "orchestrating" agent should write a plan, and decide how many agents are needed for the task and what is their role, for example 1 agent might pull content from the web and summarise it, while the other formats the word document.
There should be a work chat queue where agents can leave messages for each other to give instructions, for example: "I added more content to the txt file, please start update the word document".
There should be an hearbeat "scheduler" that every minute checks if the agents are running or not. If not running, the heartbeat should take the enqued message for that agent and send it to the agent conversation to resume work.

I imagine the database tables to be like this:

work
id | prompt | success_criterias | status

work_agents
id | agent | conversation | enqueued_message | status

The orchestrator should decide how many agents to spawn and which system prompt to give.
It should also decide to which agent it should give a message on the work_chat_queue.
The one that will have work_chat_queue on the next heartbeat will start. if only 1 out of 3 will have the work_chat_queue, the orchestrator should make sure that it gave instruction to the only working agent at the start to activate the other 2 agents when he's done his work.
When the work status is set to done, the orchestrator should compare the work with the success_criteria to check if everything looks fine or if new changes are needed.

-[UI Idea, DO NOT IMPLEMENT, just for reference] There should be another section on the sidebar for "works", by clicking "Start new work" a popup should open, here it should be possible to explain what should be the work or the goal, and it should also be possible to set time limits or token limits as safeguards.


What do you think of this idea? can you help me realize it?

---

# Assistant

Good idea, and it fits this codebase better than you might expect — you already have per-agent system prompts, persisted conversations, a tool-calling chat loop, and a single long-running Node process that can host a scheduler. Here's my honest assessment, including a few places where I'd change your design before building it.

## 1. Files in Docker: yes, it's just a volume

Docker volumes are transparent to the Node process — you read/write with plain `fs` and Docker handles persistence. Your compose template already does this twice (`pgdata`, `models` in [compose.ts:76-78](../agent-cli/src/templates/compose.ts#L76-L78)). You'd add an `artifacts:` named volume mounted at `/artifacts`, set `ARTIFACTS_DIR=/artifacts` in `app.env`, and in dev it's just a gitignored local folder. No magic.

The two things that actually matter:

- **Scope per work**: root every work at `ARTIFACTS_DIR/<work_id>/` so cleanup is `rm -rf` of one directory and parallel works can't trample each other.
- **Path sandboxing**: file paths will come from model tool calls, so every file tool must resolve the path and verify it stays inside the work's directory (`path.resolve` + prefix check, and `fs.realpath` to defeat symlinks). This is the one genuinely security-sensitive piece — a prompt-injected web page telling the agent to write to `/models/...` or read `app.env` must hit a wall.

One reality check on the example: "formats the Word document" implies binary `.docx` generation. I'd start with text/markdown artifacts (the model can actually read and edit those incrementally) and treat docx as an export step later (the `docx` npm package can do it). An LLM can't meaningfully "edit" a binary file through tools.

## 2. Your schema is close, but `enqueued_message` is a race condition

A single `enqueued_message` column on `work_agents` loses messages: if the orchestrator and a worker both leave a message for agent B before the next heartbeat, one overwrites the other — and with LLM-driven coordination, dropped instructions are exactly the failure you can't debug. Make the queue a real table:

```
works
  id, agent_id (the user's agent it belongs to → reuses member/permission model),
  created_by, prompt, success_criteria,
  status: planning | running | reviewing | done | failed | cancelled,
  provider, model,                          -- resolved via creator's provider settings
  max_tokens, deadline_at, tokens_used,     -- safeguards as first-class columns
  created_at, updated_at

work_agents
  id, work_id, name, system_prompt, is_orchestrator,
  conversation_id,
  status: idle | running,
  run_started_at, last_run_at

work_messages
  id, work_id, from_work_agent_id (NULL = system/user),
  to_work_agent_id, content,
  status: pending | delivered,
  created_at, delivered_at
```

Notes on this versus your sketch:

- **Don't reuse the `agents` table for workers.** Your `agents` are personas with memory pools and members; work agents are ephemeral workers. Spawning three rows into `agents` per work would pollute the sidebar and create empty memory pools. Tie the *work* to a real agent (for permissions/visibility), but give workers their own table. I'd also skip the memory system entirely for work agents — their shared state is the work chat plus the artifact files, which is simpler and keeps memories clean.
- **Do reuse the `conversations` table** for each worker's transcript (add a nullable `work_agent_id`, filter them out of the normal conversation list). You get persistence and UI rendering for free.
- **The orchestrator should just be a work agent too** — the first row, `is_orchestrator: true`, with extra tools. Then the heartbeat has exactly one job for every agent: "deliver pending messages and run a turn." No special orchestrator code path.

## 3. The heartbeat: right instinct, three fixes

Polling every minute is the right call — it's simple and, crucially, **self-healing**: if the container restarts mid-work, the next tick just resumes from the queue. A `setInterval` in [index.ts](index.ts) is fine for a single-container home deployment. But:

1. **Claim atomically.** Ticks can overlap a slow turn, and a tick can race itself. Claim with one statement — `UPDATE work_agents SET status='running', run_started_at=now() WHERE id=$1 AND status='idle' RETURNING id` — and only run a turn if you got the row back.
2. **Handle stuck locks.** If the process dies mid-turn, that agent is `running` forever and the work deadlocks. Treat `running` with `run_started_at` older than ~10 minutes as dead: reset to `idle`, leave the messages pending, let the next tick retry.
3. **Don't make every hop cost 60 seconds.** Pure polling means orchestrator → worker → orchestrator takes up to 3 minutes of idle waiting. Fix: when a turn finishes (and when a message is enqueued for an idle agent), immediately kick the delivery check instead of waiting for the tick. The heartbeat then becomes a recovery sweep rather than the primary engine — same robustness, none of the latency.

Also deliver **all** pending messages for an agent in one turn (concatenated, ordered), not one per tick — otherwise a backlog drains at one message per minute.

One refactor this forces: the turn logic in [conversation.ts](api/agent/conversation.ts) is welded to an Express request and session auth. Work turns shouldn't fake HTTP sessions — extract a `runWorkTurn(workAgent, messages)` in `lib/agent/` that calls `generateText` directly (no streaming needed, with `stepCountIs` as you already do). The system prompt per work agent is fixed at spawn time, which conveniently matches your KV-cache-stability rule.

## 4. The lifecycle, concretely

1. User creates a work → row in `works` (status `planning`) + an orchestrator `work_agent` + a system message in `work_messages`: the prompt and success criteria.
2. First tick (or immediate kick): orchestrator runs. Its tools: `spawn_agent(name, system_prompt, first_message)`, `send_message(to, content)`, file tools, web search, `complete_work()` / `fail_work(reason)`.
3. Workers get: file tools, web search, `send_message` (to orchestrator or peers), `report_done(summary)`. Your "tell agent 1 to activate agents 2 and 3 when done" scenario falls out naturally — but honestly, the orchestrator sequencing the handoff itself (worker reports done → orchestrator messages the next worker) is more reliable than hoping a worker remembers a standing instruction from three turns ago.
4. A worker (or orchestrator) signals completion → work goes to `reviewing` → the heartbeat enqueues a review message to the orchestrator with the success criteria → it either calls `complete_work()` or sends out fix-up instructions and flips back to `running`. Cap review cycles (e.g. 3) or this loops forever on criteria the model can't satisfy.

## 5. Two honest warnings

**Safeguards are not optional UI polish — build them into the schema from day one.** This system spends tokens autonomously with nobody watching. `max_tokens`, `deadline_at`, and a max-turns counter must be enforced by the heartbeat (refuse delivery, mark `failed: budget_exceeded`) before the first real work ever runs, especially once Anthropic/Google providers are in play. Also a kill switch: cancelling a work must stop deliveries immediately.

**Your default local model will be the weakest link.** Orchestration — writing coherent sub-agent system prompts, routing messages, judging success criteria — is frontier-model work. A gemma-4-e4b-class model will produce mushy plans and forget the protocol. Two mitigations: design so **N=1 is the happy path** (the orchestrator can simply do the work itself with its tools, spawning workers only when genuinely parallel — for your article example, one agent that searches, writes to files, then formats would likely beat three coordinating ones), and let the work's provider/model be chosen at creation so users can point works at a stronger model than their chat default.

## Verdict

The architecture is sound and notably well-matched to what exists: DB-backed queue, polling scheduler with immediate-kick optimization, orchestrator-as-agent, files on a volume. The pieces I'd insist on changing are the message queue table (instead of the `enqueued_message` column), atomic claiming with stale-lock recovery, and budget enforcement from day one.

If you want to proceed, I'd build it in phases: **(1)** artifact storage + sandboxed file tools with tests, **(2)** schema + heartbeat + single-agent works (orchestrator working alone end-to-end), **(3)** spawn/message tools for multi-agent, **(4)** the review loop. Each phase is independently testable with the existing vitest setup (fake timers for the heartbeat, the ai tier for an end-to-end work). Want me to draft the detailed implementation plan for phase 1 and 2, or adjust the design first?

---

# User

Your ideas are great, can you also read online on multi-agent systems, where are they useful, how to properly implement them etc.

---

# Assistant

Done reading — I went through Anthropic's engineering post on their multi-agent research system, Cognition's "Don't Build Multi-Agents" counterpoint, LangChain's synthesis of the two, the Berkeley MAST failure-taxonomy study (1,600+ execution traces), and a few production-patterns writeups. Here's what the field has actually learned, and what it changes about your design.

## TLDR

The research validates your architecture choice (orchestrator-worker with durable, DB-backed state) but sharpens one rule that should change how your orchestrator splits work: **parallelize reading, never writing.** Multi-agent wins big on breadth-first research tasks and loses on tightly-coupled creation tasks. And the failure data says the things most likely to kill your works are vague task specs and missing termination conditions — both preventable in the orchestrator's tool design.

## The two camps, and where they actually agree

[Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) is the strongest pro case: a lead agent spawning parallel search subagents beat single-agent Claude Opus 4 by **90.2%** on research evals. But the wins came with hard numbers attached: multi-agent burned **~15× the tokens** of a normal chat (single agent: ~4×), and token spend explained ~80% of performance variance. Their conclusion: only worth it for high-value, breadth-first tasks that exceed one context window — and explicitly *not* for tasks with tight interdependencies, which is most coding.

[Cognition's "Don't Build Multi-Agents"](https://cognition.ai/blog/dont-build-multi-agents) is the counterpoint, and its core insight is the one I'd tattoo on your orchestrator prompt: **actions carry implicit decisions, and parallel agents that can't see each other's decisions produce conflicting results.** Their example: one subagent builds a Mario-style background, another a photorealistic bird, and the final assembly can't be reconciled. Each was "correct" per its instructions; the conflict lived in the unstated assumptions. Their prescription: prefer a single linear agent with full context; when you must split, share full traces (not just summary messages), and only give subagents tasks so well-defined that no design decision is left to them.

[LangChain's reconciliation](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems) points out the two posts agree more than their titles suggest, and distills the cleanest decision rule:

- **"Read" tasks parallelize well** — research, gathering, summarizing. Conflicting assumptions cost little when the output is information.
- **"Write" tasks don't** — code, documents, anything where two agents' implicit style/structure decisions collide. Notably, even Anthropic's research system funnels all *synthesis* through a single agent; only the searching fans out.

Your Shopify-article example happens to fit this well: N agents pulling and summarizing web content in parallel (read), **one** agent owning the document (write). What the rule forbids is ever having two agents editing the same artifact.

## Why these systems fail in practice

The [MAST study](https://arxiv.org/abs/2503.13657) annotated 1,642 traces across 7 frameworks and found failure rates of 41–87% (!), sorted into three buckets:

1. **Specification and design issues — 41.8%.** Task misinterpretation, ambiguous roles, duplicated agent responsibilities, and *missing termination conditions*. The single biggest bucket, and it's all preventable at design time.
2. **Inter-agent misalignment — 36.9%.** Context lost in handoffs, agents ignoring peer input, conflicting assumptions — Cognition's whole argument, quantified.
3. **Weak verification — 21.3%.** Nobody competent checks the output before it's declared done.

A related point from the [production-patterns literature](https://www.truefoundry.com/blog/multi-agent-architecture): reliability compounds multiplicatively — five chained 95%-reliable steps yield a ~77% reliable system. Every handoff you add is a multiplication.

Anthropic's own early failure modes read like a checklist of what your heartbeat must prevent: spawning 50 subagents for a simple query, endless searching for sources that don't exist, agents spamming each other with updates, and a planner→generator infinite refinement loop.

## Implementation practices the sources converge on

- **Orchestrator-worker is the dominant production pattern** — your instinct was right. Hierarchies and meshes mostly add failure surface.
- **Detailed task specs, enforced structurally.** "Research semiconductors" caused duplicate work; specs with objective, output format, tool guidance, and explicit boundaries fixed it. Make your `spawn_agent` tool schema *require* these fields (objective, output file(s) owned, what's out of scope, effort budget) instead of accepting one free-text prompt — that moves the fix from "hope the model writes good prompts" to the type system.
- **Explicit effort-scaling rules in the orchestrator prompt.** Anthropic literally writes rules like "simple fact-finding = 1 agent, 3–10 tool calls." This is your N=1-by-default, in prompt form.
- **Share context through an external artifact, not chat alone.** Anthropic's agents summarize completed phases to external memory before handoffs. In your design this is free: make the orchestrator's first action writing `plan.md` to the work's artifact folder, and instruct every worker to read it before acting. Your file store doubles as the "blackboard" that fixes Cognition's conflicting-assumptions problem.
- **Durable execution: checkpoint and resume, never restart.** Long-running agent systems must persist state after each step and resume from the last good point ([Microsoft](https://techcommunity.microsoft.com/blog/appsonazureblog/building-durable-and-deterministic-multi-agent-orchestrations-with-durable-execu/4408842) and others are formal about this). Your DB-backed message queue + heartbeat *is* a durable execution engine — this is the most validated part of your design. The corollary to honor: message delivery must be idempotent (the atomic claim we discussed), because steps *will* be retried after crashes.
- **Guard against handoff loops.** A↔B ping-pong and infinite refinement cycles are named failure modes everywhere; cap review cycles and per-work message counts, don't trust the model to stop.
- **Verification as a first-class stage.** Your success-criteria review step addresses MAST's third bucket. Make it rubric-based: the orchestrator scores the output against each criterion explicitly rather than vibing "looks good."
- **Evaluate small, trace everything.** Anthropic started with ~20 representative test queries plus an LLM-as-judge rubric, and invested heavily in tracing decision patterns. You get tracing nearly free — every turn and every `work_messages` row is already in Postgres; just make the UI show the full work timeline. A handful of fixed test works in your `test:ai` tier mirrors their approach exactly.

## What I'd change in our design after this reading

Three concrete amendments, all cheap:

1. **Encode the read/write split as a hard rule**: each artifact file gets exactly one owning agent (declared at spawn, enforceable in the file tools — reject writes to files owned by someone else). Parallel readers, single writer per file.
2. **`plan.md` as mandatory shared context**: orchestrator writes it first; spawned workers get it injected (or are required to read it) — this is the cheap version of Cognition's "share full traces" that fits your KV-cache and token constraints.
3. **Structured spawn schema + effort budgets** instead of free-text system prompts, per above.

Everything else we designed — DB queue, atomic claiming, stale-lock recovery, budget columns, capped review loop — comes out of this reading looking right, and the 15× token figure confirms the safeguards belong in phase 1, not as polish. The one sober note stands: these failure rates were measured mostly on frontier models, so the N=1-by-default and pick-a-strong-model-per-work decisions matter even more on local models.

Want me to fold these three amendments into the design and draft the phase 1–2 implementation plan?

Sources:
- [How we built our multi-agent research system — Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Don't Build Multi-Agents — Cognition](https://cognition.ai/blog/dont-build-multi-agents)
- [How and when to build multi-agent systems — LangChain](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems)
- [Why Do Multi-Agent LLM Systems Fail? (MAST, arXiv:2503.13657)](https://arxiv.org/abs/2503.13657)
- [Multi Agent Architecture: Patterns, Use Cases & Production Reality — TrueFoundry](https://www.truefoundry.com/blog/multi-agent-architecture)
- [Building Durable and Deterministic Multi-Agent Orchestrations — Microsoft](https://techcommunity.microsoft.com/blog/appsonazureblog/building-durable-and-deterministic-multi-agent-orchestrations-with-durable-execu/4408842)
- [Agent Orchestration Patterns — GuruSup](https://gurusup.com/blog/agent-orchestration-patterns)
- [Single vs Multi-Agent System? — Phil Schmid](https://www.philschmid.de/single-vs-multi-agents)

---

# User

can you just store our conversaton in an artifact for now? copy paste it, no modifications
