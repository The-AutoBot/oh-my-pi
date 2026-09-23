<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="omp">
</p>

<p align="center">
  <strong>A coding agent with the IDE wired in.</strong>
  <strong><a href="https://omp.sh">omp.sh</a></strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent"><img src="https://img.shields.io/npm/v/@oh-my-pi/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a> 
</p>

The most capable agent surface that ships. Continuously tuned by real-world use — complete out of the box, open all the way down.

**60+** providers · **31** built-in tools · **14** lsp ops · **28** dap ops · **~80k** lines of Rust core.

> [!NOTE]
> Pull requests are **temporarily open to everyone** as a trial. We previously
> required a vouch before accepting PRs; that requirement is lifted for now
> while we evaluate how open contributions go. Depending on the results, the
> vouch system may return.

## Install

**macOS · Linux**

```sh
curl -fsSL https://omp.sh/install | sh
```

> **Alpine / musl:** the prebuilt musl binary links `libstdc++`/`libgcc` dynamically, which stock Alpine does not ship. Install them first: `apk add libstdc++ libgcc`.

**Homebrew**

```sh
brew install can1357/tap/omp
```

**Bun (recommended)**

```sh
bun install -g @oh-my-pi/pi-coding-agent
```

**Nix**

```sh
# Run without installing
nix run github:can1357/oh-my-pi

# Or install into the active profile
nix profile install github:can1357/oh-my-pi
```

Flake consumers can use `packages.<system>.omp`, `overlays.default`, `nixosModules.default`, or `homeManagerModules.default`. A Home Manager configuration can install OMP and own its settings declaratively:

```nix
{
  inputs.omp.url = "github:can1357/oh-my-pi";

  # In your Home Manager module:
  imports = [ inputs.omp.homeManagerModules.default ];
  programs.omp = {
    enable = true;
    settings.startup.quiet = true;
  };
}
```

**Windows (PowerShell)**

```powershell
irm https://omp.sh/install.ps1 | iex
```

**Pinned versions (mise)**

```sh
mise use -g github:can1357/oh-my-pi
```

macOS · Linux · Windows · bun ≥ 1.3.14

### Shell completions

`omp` generates its own completion scripts for **bash**, **zsh**, and **fish** from the live command/flag metadata, so they never drift from the actual CLI. Subcommands, flags, and enum values complete statically; model names (`--model`, `--smol`, `--slow`, `--plan`) resolve against the bundled model catalog and `--resume` against your on-disk sessions.

```sh
# zsh — add to ~/.zshrc (or write the output into a file on your $fpath)
eval "$(omp completions zsh)"

# bash — add to ~/.bashrc
eval "$(omp completions bash)"

# fish
omp completions fish > ~/.config/fish/completions/omp.fish
```

## Every tool, _benchmaxxed_.

Edits that land on the first attempt. Reads that summarize files instead of dumping their content. Searches that return instantly. Pick any model — omp will get it right.

| model            | metric       | what                                                                  |
| ---------------- | ------------ | --------------------------------------------------------------------- |
| Grok Code Fast 1 | 6.7% → 68.3% | Tenfold lift the moment the edit format stops eating the model alive. |
| Gemini 3 Flash   | +5 pp        | Over str_replace — beats Google's own best attempt at the format.     |
| Grok 4 Fast      | −61% tokens  | Output collapses once the retry loop on bad diffs disappears.         |
| MiniMax          | 2.1×         | Pass rate more than doubles. Same weights, same prompt.               |

- `read` : summarized snippets · ideal defaults · selector hit rate
- `grep` : fastest in the west
- `lsp` : everything your IDE knows, the agent knows
- `prompts` : adjusted relentlessly for each model

[Read the full post ↗](https://blog.can.ac/2026/02/12/the-harness-problem/)

## The Pi _you love_, with **batteries included**.

Originally built on [Mario Zechner](https://github.com/mariozechner)'s wonderful [Pi](https://github.com/badlogic/pi-mono), omp adds everything you're missing.

### 01 · Code execution w/ tool-calling

Most harnesses give the agent a Python sandbox and call it done. Ours runs persistent Python and a Bun worker, and either kernel can call back into the agent's own tools — read, search, task — over a loopback bridge. The agent loads a CSV with tool.read from inside Python, charts it from JavaScript, and never leaves the cell.

![omp TUI running Python code and rendering a chart.](assets/python.webp)

### 02 · LSP wired into every write

Ask for a rename and you get a rename. The call goes through workspace/willRenameFiles, so re-exports, barrel files, and aliased imports update before the file moves. Everything your IDE knows, the agent knows.

![omp TUI with TypeScript and Biome language servers active.](assets/lspv.webp)

_[Read the LSP config docs](docs/lsp-config.md)_

### 03 · Drives a real debugger

A C binary segfaults: the agent attaches lldb, steps to the bad pointer, reads the frame. A Go service hangs: it attaches dlv and walks the goroutines. A Python process is wedged: debugpy, pause, inspect, evaluate. Most agents are still sprinkling print statements.

![omp TUI: a live lldb-dap session against a native binary at /tmp/omp-native/demo. Adapter=lldb-dap, Status=stopped, Frame=xorshift32, Instruction pointer 0x10000055C, Location demo.c:6:10. Debug scopes and Debug variables cards show locals (x = 57351) and the agent confirms the math: x went from 7 → 57351 (= 7 ^ (7<<13)).](https://omp.sh/clips/dap-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/dap.mp4)_

### 04 · Time-traveling stream rules

Your rules sit dormant until the model goes off-script. A regex match aborts the stream mid-token, injects the rule as a system reminder, and retries from the same point. You get course-correction without paying context tax on every turn. Injections survive compaction, so the fix sticks.

![omp TUI: agent reading src.rs and about to write Box::leak when the request aborts (red `Error: Request was aborted`), an amber `⚠ Injecting rule: box-leak` card injects the rule body `Don't reach for Box::leak in production code paths`, and the agent then course-corrects by proposing `Arc<str>` and asking the user to confirm.](https://omp.sh/clips/ttsr-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/ttsr.mp4)_

### 05 · First-class subagents

Split a job across workers and get typed results back. task fans out into isolated worktrees, each worker runs its own tool surface, and the final yield is a schema-validated object the parent reads directly. No prose to parse, no merge conflicts between siblings, no orphaned edits.

![omp TUI showing `task` spawning two subagents `ComponentsExports` and `RoutesExports`, the constraints block requiring an IRC DM between peers, the per-subagent status cards with cost and duration, and a final Findings section listing both exports plus an honest 'IRC coordination note' about a one-sided handshake.](https://omp.sh/clips/irc-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/irc.mp4)_

Watch the fan-out while it runs: `Alt+A` opens [Agent Hub](docs/agent-hub.md), where the roster shows current activity and usage for every subagent. Open one to read its live transcript, type a steering message, revive a parked worker, or kill a stuck one without aborting the parent session.

### 06 · A second model, watching every turn.

Pair a reviewer model to the 'advisor' role and it reads every turn the main agent takes, injecting notes inline — a quiet aside, a concern, or a hard blocker. It runs on its own context and its own model, so it catches what the doer rushed past. The main agent sees the note and course-corrects, or tells you why it won't.

![omp TUI: /advisor status shows the advisor running on openai-codex/gpt-5.5; after the main agent scopes a catch to ENOENT instead of swallowing every error, an amber 'Advisor 1 note (concern)' card warns the fix no longer matches the user's literal acceptance criterion.](https://omp.sh/clips/advisor-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/advisor.mp4)_

### 07 · Hand someone the link, they're in.

/collab puts your live session on a relay and hands back a link — and a QR. A teammate joins from another terminal with omp join, or just opens it in a browser. Share read-write to pair on the same agent, or /collab view for a read-only link anyone can watch but no one can steer. Frames are sealed client-side; the relay never sees your keys.

![omp TUI: /collab view prints 'Collab session started!' with an omp join command, a my.omp.sh browser link, the note 'Anyone with this link can watch the session but cannot prompt the agent', and a large scannable QR code.](https://omp.sh/clips/collab-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/collab.mp4)_

### 08 · Read a pdf on arxiv, why not?

web_search chains twenty-three ranked providers and hands whatever URLs it finds straight to read. Arxiv PDFs, GitHub pages, Stack Overflow threads come back as structured markdown with anchors intact — the same tool surface you use on local files. Cite, follow, quote, never lose where you came from.

![omp TUI: web_search returns 10 ranked Perplexity sources for inference-time compute scaling, the agent picks an arxiv paper, calls read https://arxiv.org/pdf/2604.10739v1, and summarizes the paper's headline result with real numbers.](https://omp.sh/clips/web-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/web.mp4)_

### 09 · Unapologetically native. Even on Windows.

Other agents shell out to rg, grep, find, and bash. On many machines those binaries don't exist, and on the ones where they do, every call costs a fork-exec round-trip. omp links the real implementations into the process. ripgrep, glob, find: in-process. brush is the bash — with sessions that survive across calls, and 58 command-line utilities (ls, sed, sort, xargs, even jq) ported into the builtins crate and run in-process, zero fork/exec. The same omp binary runs on macOS, Linux, and Windows — no WSL bridge.

### 10 · Code review with priorities and a verdict

Get a clear verdict on whether the change ships, with every issue ranked P0 through P3 and scored for confidence. /review spawns dedicated reviewer subagents that sweep branches, single commits, or uncommitted work in parallel. You tackle what blocks release first; nothing important hides in a wall of prose.

### 11 · Hashline: edit by content hash

Perfect edits, fewer tokens. The model points at anchors instead of retyping the lines it wants to change, so whitespace battles and string-not-found loops just stop happening. Edit a stale file and the anchors diverge — we reject the patch before it corrupts anything. Grok 4 Fast spends 61% fewer output tokens on the same work.

### 12 · GitHub is just another filesystem

Other harnesses bolt on gh_issue_view, gh_pr_view, gh_search — each with its own parameters the agent has to learn and you have to debug. We skipped that. read already handles paths; PRs are paths. One interface to teach the model, one surface to keep correct.

### 13 · Memory the agent curates

The agent remembers your codebase between sessions. It writes facts mid-run with retain, captures reusable lessons with learn, pulls them back with recall, and compresses each session into a mental model that loads on the first turn of the next one. Pick the engine with `memory.backend` — local, Hindsight, or Mnemopi. Project-scoped by default, so what it learns about this repo stays with this repo.

### 14 · ACP: editor-drivable agent

Run omp inside Zed and you get the same agent you drive from the terminal — reading the buffer you're actually looking at, writing through the editor's save path, spawning shells in the editor's terminal. Destructive tools pause for a permission prompt you can answer once and forget. No bridge, no plugin, no second brain to keep in sync.

### 15 · Inherits what your other tools already wrote

Every other agent ships an importer and expects you to convert. omp reads the eight formats already on disk in their native shape — Cursor MDC, Cline .clinerules, Codex AGENTS.md, Copilot applyTo, and the rest. No migration script, no YAML-to-TOML port, no "supported subset" footnotes. The config your team wrote last quarter still works tonight.

### 16 · omp commit: atomic splits, validated messages

omp reads the working tree through git_overview, git_file_diff, and git_hunk, then splits unrelated changes into atomic commits ordered by their dependencies. Cycles are rejected before anything is written. Source files score above tests, docs, and configs, so the headline commit is the one that matters. Lock files are excluded from analysis entirely.

### 17 · Read PRs. _Walk skills._ Pull JSON out of subagents.

Sixteen internal schemes — `pr://`, `issue://`, `agent://`, `skill://`, `ssh://`, and the rest — resolve transparently inside every FS-shaped tool the agent already calls. `read pr://1428` returns the same shape as `read src/foo.ts`. `grep` walks a diff like a directory. `agent://<id>/findings.0.path` pulls a field out of a subagent's output by path.

### 18 · Conflict resolution, made easy.

Each merge conflict becomes one URL. The agent writes `@theirs`, `@ours`, or `@base` to `conflict://N` and the file resolves cleanly. Bulk form: `conflict://*`.

![omp TUI: ✓ Read src/session.ts (⚠ 1 conflict), then ✓ Write conflict://1 · 1 line with content @theirs, then a confirmation 'Resolved.'](https://omp.sh/clips/conflict-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/conflict.mp4)_

### 19 · Preview, then accept.

`ast_edit` returns a _(proposed)_ card with the replacement count. The change is staged. The agent writes a one-line reason to `xd://resolve`; the TUI turns it into an **Accept** card and the disk move happens — atomic, all or nothing.

![omp TUI: ✓ AST Edit: console.log($X) (proposed) 3 replacements · 1 file, then ✓ Accept: 3 replacements in 1 file (AST Edit), followed by 'Applied 3 replacements in src/auth.ts.'](https://omp.sh/clips/codemod-poster.webp)

_[Watch the capture ↗](https://omp.sh/clips/codemod.mp4)_

### 20 · Drives a _real browser_. _Or your Slack?_

Eval's `browser.open(...)` returns a tab handle with direct navigation, inspection, interaction, and element helpers; `tab.run(...)` handles custom JavaScript. It drives Chromium or Electron in an isolated tab runtime. Stealth is on by default, while the browser relay can adopt Chrome tabs you already have open without stealing focus.

### 21 · Hands on the desktop itself

Eval's `computer` helpers — `computer.window(...)`, `win.screenshot()`, `win.ax()`, `el.press()`, plus `computer.run(fnOrCode, options)` for multi-step scripts — control the real host: enumerate windows and displays, capture screenshots, send native input, walk the OS accessibility tree, and use the clipboard. It exposes no browser DOM.

## Whatever the task needs, _it's already in the box_.

Core tools live in the same namespace as `read` and `bash`. Pin the active set with `--tools read,edit,bash,…`; rarely used discoverable tools stay behind `xd://` devices. `read xd://` lists them, and `write xd://<tool>` runs one when `tools.xdev` is enabled.

**Files & search**

- `read` — files, dirs, archives, SQLite, PDFs, notebooks, URLs, remote `ssh://` paths, and internal `://` schemes through one path.
- `write` — create or overwrite a file, archive entry, or SQLite row.
- `edit` — hashline patches with content-hash anchors and stale-anchor recovery.
- `ast_edit` — structural rewrites previewed before apply, via ast-grep.
- `ast_grep` — structural code queries over 50+ tree-sitter grammars.
- `grep` — regex over files, globs, and internal URLs.
- `glob` — glob-based path lookup; reach for `grep` when you need content matches.

**Runtime**

- `bash` — workspace shell with 46 in-process coreutils, optional PTY, and background-job dispatch.
- `eval` — persistent Python and JavaScript cells with shared prelude and tool re-entry.

**Code intelligence**

- `lsp` — diagnostics, navigation, symbols, renames, code actions, raw requests.
- `debug` — drive a DAP session — breakpoints, stepping, threads, stack, variables.
- `security_scan` — plan and run native security reviews; drives Codex Security cloud scans.

**Coordination**

- `task` — fan out subagents in parallel, optionally workspace-isolated.
- `hub` — message live agents, wait on or cancel background jobs, and supervise long-running processes.
- `todo` — ordered mutations over the session todo list with phase tracking.
- `ask` — structured follow-up questions for interactive runs.

**Desktop & web**

- `browser` — Puppeteer tabs over headless Chromium, CDP-attached apps, or your own Chrome via the relay.
- `computer` — persistent JS against the host desktop: windows, screenshots, native input, AX tree, clipboard.
- `web_search` — one query across configured providers, returning answer plus citations.
- `github` — GitHub CLI ops — repo, PR, issues, code search, Actions run-watch.
- `generate_image` — generate or edit raster images via Gemini, GPT, or xAI Grok image models.
- `tts` — text-to-speech via xAI Grok Voice — five built-in voices, WAV or MP3.

**Memory & skills**

- `checkpoint` — mark conversation state for a later collapse-and-report.
- `rewind` — prune exploratory context, keep a concise report.
- `retain` — queue durable facts into the active memory bank.
- `recall` — search the memory bank for raw memories.
- `reflect` — synthesize an answer over the bank.
- `memory_edit` — update, forget, or invalidate stored memories by id.
- `learn` — capture a reusable lesson; optionally promote it into a managed skill.
- `manage_skill` — create, update, or delete an isolated managed skill.

Setting-gated, off by default: `github`, `security_scan`, `generate_image`, `tts`, `checkpoint`, `rewind`, and the memory tools (`retain`/`recall`/`reflect`/`memory_edit`, per `memory.backend`).

[Full reference →](https://omp.sh/docs/tools)

### Prompt controls

Three standalone, lowercase words opt a turn into specialized agent behavior:

- `ultrathink` — request careful multi-step reasoning and the highest supported automatic thinking effort.
- `orchestrate` — run substantial independent work through parallel subagents and verify each phase.
- `workflowz` — build a deterministic multi-subagent workflow with the active `task` tool.

They trigger only in prose, not inside code spans, fenced code blocks, XML/HTML sections, identifiers, or paths. See [Magic keywords](docs/magic-keywords.md) for exact matching rules and configuration.

### Session controls

Slash commands shift how a whole session runs:

- `/vibe` — enter [Vibe mode](docs/vibe-mode.md): act as a director driving persistent `fast`/`good` worker sessions with a `read`-only toolset.
- `/fresh` — reset the provider stream state (stale prompt cache, wedged stream) without changing the local transcript. See [Session operations](docs/session-operations-export-share-fork-resume.md#fresh).

## Sixty-plus providers, a thousand models, _one /model away_.

Nine roles route work by intent. `default` for normal turns. `smol` for cheap subagent fan-out. `slow` for deep reasoning. `plan` for plan mode. `commit` for changelogs. Plus `vision`, `task`, `advisor`, and `tiny` for their namesakes. Override at launch with `--smol`, `--slow`, or `--plan`; cycle through the configured models for the active role with `Ctrl+P`. Swap the active model mid-session with the `/model` slash command.

Auth tags below: `oauth` signs in with your provider account, `plan` routes through a coding-plan subscription, `local` runs against a local server with the key optional.

### Frontier APIs

Direct APIs and gateways. Mix providers per role.

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · DeepInfra · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · Command Code · Charm Hyper · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

### Coding plans

Subscription-routed. `/login` attaches the session.

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### Run it yourself

OpenAI-compatible `/v1/models`. Local instances skip the key.

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

### Custom OpenAI-compatible providers

Define custom providers in `~/.omp/agent/models.yml`:

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

Run `omp models spark` to verify discovery. Then run `omp setup` and choose the model in the default-model step, or open `/model` in a session and assign it to the `default` role.

To preconfigure the default without the picker, add the selector to `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: spark/minimax-m3
```

### Four knobs that make routing useful

- **Custom providers** — Declare anything that speaks `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `typesafe`, or `openrouter-decisions` (the two judge APIs) in `~/.omp/agent/models.yml`.
- **Fallback chains** — Per-role or per-model chains under `retry.fallbackChains`. When the primary throws 429s or hits a quota wall, the next entry takes the rest of the turn — restored on cooldown.
- **Path-scoped models** — Scope `enabledModels` and `disabledProviders` entries to a `path:` prefix to pin a different model set on one repo without touching the global config. Scoped entries cover the path and everything under it.
- **Round-robin credentials** — Stack API keys per provider and the runtime rotates with session affinity and per-credential backoff. Useful when one key would burn its quota by lunch.

Full provider & routing reference at [omp.sh/docs/providers](https://omp.sh/docs/providers).

## Twenty-three backends. _One tool the agent already knows_.

`web_search` is built in, not bolted on. `auto` walks a twenty-three-provider chain; pin one by name if you already pay for it. Behind every hit, site-aware extraction turns GitHub, registries, arXiv, Stack Overflow, and docs into structured markdown — anchors and link targets survive.

### Search providers

Twenty-three backends. Pin one, or let `auto` walk the chain in order.

| provider     | auth                                      |
| ------------ | ----------------------------------------- |
| `auto`       | chain                                     |
| `perplexity` | `PERPLEXITY_API_KEY` (anonymous fallback) |
| `gemini`     | oauth                                     |
| `anthropic`  | oauth                                     |
| `codex`      | oauth                                     |
| `xai`        | oauth or `XAI_API_KEY`                    |
| `zai`        | `ZAI_API_KEY`                             |
| `exa`        | `EXA_API_KEY` (or mcp)                    |
| `tinyfish`   | `TINYFISH_API_KEY`                        |
| `jina`       | `JINA_API_KEY`                            |
| `kagi`       | `KAGI_API_KEY`                            |
| `tavily`     | `TAVILY_API_KEY`                          |
| `firecrawl`  | `FIRECRAWL_API_KEY` (keyless fallback)    |
| `brave`      | `BRAVE_API_KEY`                           |
| `kimi`       | `/login kimi-code` or search key          |
| `parallel`   | `PARALLEL_API_KEY`                        |
| `synthetic`  | `SYNTHETIC_API_KEY`                       |
| `searxng`    | self-hosted                               |
| `duckduckgo` | no key                                    |
| `startpage`  | no key                                    |
| `google`     | no key (browser)                          |
| `ecosia`     | no key (browser)                          |
| `mojeek`     | no key (browser)                          |
| `public`     | no key (all of the above, consolidated)   |

Exa also accepts a stored API key through `/login exa`; explicit keyless selection uses the public MCP fallback.

### Specialised handlers

The agent gets structured content, not stripped HTML.

- **Code hosts** — github, gitlab
- **Package registries** — npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **Research sources** — arxiv, semantic scholar
- **Forums** — stack overflow, reddit, hn
- **Docs** — mdn, readthedocs, docs.rs

Pages convert to markdown with link structure intact. The agent can cite, follow, and quote without losing anchors.

### Security databases

Vuln lookups answer with vendor data, not blog summaries.

- **NVD** — national vulnerability database
- **OSV** — open source vuln feed
- **CISA KEV** — known exploited vulns

[`web_search` reference ↗](https://omp.sh/docs/tools#web_search)

## Roughly **~80,000** lines of Rust, doing the work other harnesses shell out for.

Six crates, one platform-tagged N-API addon. Search, shell, AST, highlight, PTY, desktop control, image decode, BPE counting — all in-process on the libuv pool. No fork/exec on the hot path. Another ~80k lines ride along vendored: the brush bash fork, plus 58 command-line utilities — coreutils, findutils, sed, jq, ripgrep-backed grep, fd, diff, moreutils — ported into the builtins crate and compiled straight into the shell.

- Crates: `pi-natives`, `pi-shell`, `pi-ast`, `pi-iso`, `pi-voice`, `pi-walker`
- Platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64` — x64 ships dual AVX2 and baseline binaries

Per crate, code lines only:

| Crate         | What it does                                                                           |   ~LoC |
| ------------- | -------------------------------------------------------------------------------------- | -----: |
| pi-shell      | Embedded bash engine · persistent sessions · in-process coreutils dispatch · minimizer | 38,000 |
| pi-natives    | The N-API surface — every module in the table below                                    | 25,000 |
| pi-walker     | Parallel ignore-aware walker + scan cache shared by grep · glob · workspace · shell    |  5,200 |
| pi-iso        | Workspace isolation · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy        |  3,300 |
| pi-ast        | tree-sitter + ast-grep matching, block resolution, structural summaries                |  2,900 |
| pi-voice      | Audio capture/playback · Opus · live WebRTC                                            |  1,000 |

Inside `pi-natives`, the per-module breakdown (glue and tests omitted):

| Module        | What it does                                                                      | Powered by                                |   ~LoC |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | -----: |
| desktop       | Window/display enumeration · screenshot · native input · AX tree for `computer`   | xcap · enigo · OS AX FFI                  | 10,600 |
| grep          | Regex search · parallel/sequential · glob & type filters · fuzzy find             | grep-regex · grep-searcher                |  3,280 |
| text          | ANSI-aware width · truncation · column slicing · SGR-preserving wrap              | unicode-width · segmentation              |  2,070 |
| snapcompact   | Bitmap-frame rasterization + PNG encode for context compression                   | image · png                               |  1,760 |
| keys          | Kitty keyboard protocol with xterm fallback · PHF perfect-hash lookup             | phf                                       |  1,740 |
| ast           | ast-grep pattern matching and structural rewrites                                 | ast-grep-core                             |  1,510 |
| diff          | Structured file diffing for tools and previews                                    | in-tree                                   |  1,030 |
| pty           | Native PTY allocation for sudo · ssh interactive prompts                          | portable-pty                              |    630 |
| crash_handler | Native crash capture and reporting                                                | in-tree                                   |    610 |
| highlight     | Syntax highlighting · 11 semantic categories · 30+ aliases                        | syntect                                   |    550 |
| appearance    | Mode 2031 + native macOS dark/light via CoreFoundation FFI                        | core-foundation                           |    450 |
| task          | Blocking work on libuv thread pool · cancellation · timeout · profiling           | tokio · napi                              |    440 |
| glob          | Discovery with glob · type filters · mtime sort · gitignore respect               | ignore · globset                          |    430 |
| fd            | Filesystem walker for find-tool replacement                                       | ignore                                    |    385 |
| clipboard     | Text copy and image read from system clipboard · no xclip/pbcopy                  | arboard                                   |    370 |
| workspace     | Workspace walker with gitignore + AGENTS.md discovery in one pass                 | ignore                                    |    275 |
| power         | macOS power-assertion API for idle/system/display-sleep prevention                | IOKit FFI                                 |    270 |
| prof          | Circular buffer profiler with folded-stack and SVG flamegraph output              | inferno                                   |    240 |
| file_lock     | Cross-process advisory file locking                                               | in-tree                                   |    210 |
| ps            | Cross-platform process-tree kill and descendant listing                           | libc · libproc · CreateToolhelp32Snapshot |    195 |
| tokens        | O200k / Cl100k BPE token counting · both tables embedded                          | tiktoken-rs                               |     70 |
| html          | HTML to Markdown with optional content cleaning                                   | html-to-markdown-rs                       |     60 |
| sixel         | Terminal image rendering · decode PNG · JPEG · WebP · GIF · resize · SIXEL encode | icy_sixel · image                         |     55 |

## Four entry points: _interactive_, _one-shot_, RPC, and ACP.

Same engine, four wrappers. `omp` runs the TUI. `omp -p` answers a single prompt and exits. The Node SDK embeds the session in your process. `omp --mode rpc` and `omp acp` hand the wheel to another program over stdio.

### Interactive — when in doubt, the agent asks

The TUI is the default surface. Tool calls render as cards, edits preview before they land, and ambiguity routes through the `ask` tool — a structured option picker the agent can call mid-turn. The keyboard handles the rest.

The same prompt cards surface over ACP, so editors get the picker without writing one.

![omp TUI showing a multi-select question from the ask tool.](assets/ask.webp)

### SDK — embed in Node

`@oh-my-pi/pi-coding-agent`

Node and TypeScript hosts pull the engine in directly. The package exposes `ModelRegistry`, `SessionManager`, `createAgentSession`, and `discoverAuthStorage`; the session emits typed events you subscribe to.

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("list .ts files");
```

### RPC — drive over stdio

`omp --mode rpc`

For non-Node embedders, or when you want process isolation. NDJSON commands in, response and event frames out. `--mode rpc-ui` adds tool cards, selectors, and dialogs as `extension_ui_request` frames the host must answer.

```
$ omp --mode rpc --no-session
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP — speak to editors

`omp acp`

The [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) over JSON-RPC. When the editor advertises capabilities, tool I/O routes through it and writes are gated by `session/request_permission`.

| omp tool     | ACP route                           |
| ------------ | ----------------------------------- |
| `bash`       | `terminal/create + terminal/output` |
| `read`       | `fs/read_text_file`                 |
| `write`      | `fs/write_text_file`                |
| `edit, bash` | `session/request_permission`        |

Full reference: [omp.sh/docs/sdk](https://omp.sh/docs/sdk).

## A harness worth keeping is one you _don't_ outgrow.

Pick it up at **[omp.sh](https://omp.sh)**.

omp is a fork of [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), rewritten as a coding-first surface: sessions, subagents, slash commands, extensions — all TypeScript, all MIT, all on [GitHub](https://github.com/can1357/oh-my-pi). Shape it from config, hook it from outside, or read the source when you need to.

### Primitives

An extension is a TypeScript module. Same tool API, same slash-command registry, same hotkey table, same TUI primitives the built-ins use. Nothing is reserved.

### Discovery

On first run omp inherits whatever is already on disk: rules, skills, and MCP servers from `.claude`, `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, and `.vscode`. No migration script.

### Extensibility

Ask omp to write the piece you're missing, then `/reload-plugins`. Keep it local, ship it in a `marketplace`, or publish it to npm.

## Philosophy

omp is a fork of [pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), extended with a batteries-included coding workflow.

Key ideas:

- Keep interactive terminal-first UX for real coding work
- Include practical built-ins (tools, sessions, branching, subagents, extensibility)
- Make advanced behavior configurable rather than hidden

---

## Development

### Getting started from source

Fresh clones need both workspace dependencies and the local Rust/N-API addon before the source CLI can start.

```sh
bun setup
bun dev
```

`bun setup` installs Bun workspaces and builds `@oh-my-pi/pi-natives`. Re-run `bun run build:native` after changing Rust crates or `packages/natives`.

Nix users get the pinned Bun and Rust toolchains plus all native build dependencies:

```sh
nix develop
bun setup
bun dev
```

Build and smoke-test the distributable Nix package with `nix build .#omp`. Wayland screencast support is off by default (linking libpipewire adds ~750 MB of runtime closure); enable it with `omp.override { withWaylandScreencast = true; }`. `nix/bun.nix` is generated only when `bun.lock` changes; releases regenerate it automatically. For dependency changes, run:

```sh
bun run gen:nix
```

The command uses `bun2nix` from `nix develop` when available, otherwise enters the development shell through Nix, then falls back to the pinned `bunx bun2nix@2.1.2`. Do not edit `nix/bun.nix` manually.

For a non-interactive smoke check:

```sh
bun dev -- --version
```

### Debug Command

`/debug` opens tools for debugging, reporting, and profiling.

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

#### Plain local Windows application rebuild

A plain local rebuild is separate from signed publication, scheduling, installation,
PATH changes, and deployment. From the maintained OMP checkout, compile only the
Windows x64 application with the pinned Bun executable:

```powershell
& 'C:\tools\bun\bun.exe' --no-env-file scripts/ci-release-build-binaries.ts --targets win32-x64
```

The coordinator checkout provides a wrapper when a fresh external output
directory plus build provenance is wanted:

```powershell
& 'D:\Projects\omp-session-coordinator\Build-LocalOmp.ps1' `
  -OmpRoot 'D:\Projects\The-AutoBot-oh-my-pi' `
  -BunPath 'C:\tools\bun\bun.exe' `
  -OutputDirectory 'D:\builds\omp-local' `
  -NativeAddonProvenanceSha256 '<lowercase-64-hex-digest>'
```

The wrapper accepts only those four inputs. It does not install dependencies,
build Rust/Cargo code, or build the coordinator. It validates the configured
pin against `OmpRoot\packages\natives\native\native-build-provenance.json`,
recomputes the current conservative native-input fingerprint, and requires the
recorded `pi_natives.win32-x64-baseline.node` (plus its optional compatible
modern sibling) to retain its exact size, hash, and native compatibility
sentinel under canonical variants `win32-x64-baseline` and
`win32-x64-modern`. Its build target is the actual Cargo target
`x86_64-pc-windows-msvc`; the profile and toolchain fields remain producer
evidence and are not claimed as reproduced by this application-only build.
Missing, changed, or unpinned native inputs fail closed rather than
being guessed or repaired. The resulting reuse evidence records the independent
native compatibility version, input fingerprint, pinned record digest, build
identity, and artifact hashes; application package version equality is neither
required nor treated as native source proof.

The output directory must not already exist and is created only after every
check succeeds. It contains only `omp.exe` and schema-3
`build-provenance.json`; the provenance binds the executable SHA-256 fingerprint,
source provenance, and pinned native record evidence.
The standalone smoke checks the copied executable's exact `--version`,
`--help`, and `--smoke-test` in a fresh isolated profile with
`PI_NATIVE_VARIANT=baseline`. It does not claim or validate the managed
`--autobot-build-identity` used by signed releases, and it does not install or
activate the executable. Broad lint, type, and test suites remain normal CI
responsibilities rather than per-build prerequisites.

When Rust/native implementation, native ABI, or the runtime/SDK/broker protocol
contract actually changes, use a clean matching-source native rebuild and the
project's normal CI qualification. Reusing native inputs is only the
application-only path; it does not relax maintenance requirements for native or
protocol changes.

#### Install an application-only build into a plain legacy runtime

Installation is a separate, explicit legacy-only operation. The coordinator
installer accepts only the fresh two-file output above: `omp.exe` plus the
schema-3 `build-provenance.json` with kind
`local-omp-application-build`. It strictly validates the exact
application-build provenance shape, including the independent native
compatibility version, source-input fingerprint, pinned record digest, build
identity, and artifact hashes, then verifies the executable's declared
filename, application version, size, and SHA-256 against its actual bytes
before touching the destination.

```powershell
& 'D:\Projects\omp-session-coordinator\Install-LocalOmp.ps1' `
  -BuildDirectory 'D:\builds\omp-local' `
  -Destination 'C:\Users\you\AppData\Local\omp\omp.exe'
```

The destination must already be a plain, regular legacy `omp.exe`. The
installer refuses reparse paths and every destination beneath a managed
`.autobot` marker, stages on the destination volume, rechecks the destination
at the replacement boundary, and retains the original executable as a unique
same-directory backup. It installs only `omp.exe`; it does not alter `PATH`,
touch running processes, or install coordinator extension or SDK assets.
Fully exit and restart the legacy CLI separately.

This route is not a substitute for the signed managed installer below. Managed
runtimes, immutable bootstrap state, and matching coordinator extension/SDK
compatibility remain part of the signed release topology and must be installed
or migrated through that reviewed managed path.


### AutoBot managed operations

AutoBot is a separate, operator-managed distribution path for a signed `omp`
runtime. It is not the ordinary `omp.sh`, package-manager, or source
installation flow. Its stable bootstrap uses only a locally configured signed
channel and locally trusted Ed25519 public keys, stages verified runtimes in
immutable release slots, and publishes an installation-wide preferred release.

#### Operator setup and weekly local producer

The retired Actions producers have been replaced by one local, Windows x64
producer. It is operator-run under a single Windows account with that account's
existing OMP and `gh` authentication; it neither creates nor copies a PAT,
release credential, or login. It is not an installation, deployment, or
general release-automation setup.

Create a private, absolute-path JSON configuration that contains *exactly* the
fields in [`scripts/autobot-local-types.ts`](scripts/autobot-local-types.ts)'s
`LocalAutomationConfig` (`schemaVersion` must be `1`; unknown or omitted
fields are rejected):

- Source inputs: `repository` is `The-AutoBot/oh-my-pi`; set distinct
  `canonicalBranch` and `integrationBranch`, plus a credential-free
  `https://github.com/<owner>/<repository>.git` `upstreamRepository`.
  `upstreamRef` is either `latest-release` (resolved once per run to the latest
  published, non-draft, non-prerelease GitHub release) or an exact
  `refs/tags/<tag>` whose GitHub release is published and stable. Branch refs,
  including `refs/heads/main`, are rejected. The controller pins and
  revalidates that exact selected tag's peeled commit and coding-agent package
  version; a newer release appearing during the run does not move the pin.
  With `latest-release`, each scheduled invocation selects the then-current
  stable release once at the start of that run; activating the weekly task does
  not turn that selection into a permanently pinned release.
  If that official release is an ancestor of an authenticated retained upstream
  base, the controller preserves the retained commit and its actual package
  version as signed provenance. The official tag remains a separate tracking
  and network-stability pin. A future stable descendant advances the base
  automatically; divergent history fails closed. A stale state field alone
  cannot authorize adopting an otherwise unretained upstream commit.
  It keeps an owned persistent repository and worktree under the private,
  absolute `workRoot`; it must be separate from the trusted producer checkout.
  Prefer a short directory directly under your user profile: deeply nested
  paths can exceed the Windows runtime smoke test's local socket-path limit
  even when ordinary file paths are valid.
  The controller no longer owns or permits the retired `workRoot\cargo-target`
  cache. An existing work root that still contains it fails ownership
  validation until the operator removes or migrates that obsolete cache; there
  is no compatibility mode.
- Pinned executables: set existing absolute `runnerBun` and `compilerBun`
  paths and their exact `runnerBunVersion` and `compilerBunVersion`, plus the
  existing absolute `ompExecutable`. Both configured Bun executables are
  checked against their pins on each run.
- Native, coordinator, and signing inputs: set required
  `nativeAddonDirectory` to an existing absolute directory containing
  `native-build-provenance.json` and its operator-adopted Windows add-on files,
  and set `nativeAddonProvenanceSha256` to the lowercase SHA-256 of that exact
  record. The compatible `pi_natives.win32-x64-baseline.node` is required and
  its modern sibling is optional. Before any application build, the publisher
  validates the configured record pin, its strict schema, the candidate's
  conservative Cargo/N-API native-input fingerprint, each exact artifact hash
  and size, and the compatibility-version sentinel. The record must name actual
  Cargo target `x86_64-pc-windows-msvc`; its canonical artifact variants are
  `win32-x64-baseline` and, when present, `win32-x64-modern`. Profile and
  toolchain remain facts about the producing native build, not claims about the
  application-only publisher. It then stages the canonical regular,
  non-reparse artifacts with copied-byte integrity checks.
  Local reuse evidence records the independent native compatibility identity,
  source-input fingerprint, pinned record digest, build identity, and artifact
  hashes. An application-only version bump can therefore reuse a matching
  native generation without claiming that the application and native package
  versions are equal. Missing records, changed native inputs, pin mismatches,
  and incompatible artifacts fail closed with a bounded diagnostic code and
  are never offered to OMP as source repair. The publisher never guesses a
  source match or automatically runs Cargo: an existing binary needs a
  provenance record produced or explicitly adopted from its actual qualified
  native build before it can be configured.
  `coordinatorRoot` names a distinct clean, committed coordinator
  checkout with a credential-free HTTPS origin. `keyId`, `privateKeyPath`, and
  `publicKeyPath` identify existing signing material. Keep the private-key path
  and this configuration private; do not put key bytes in the file.
- Channel and bounds: set `channelRepository`, `channelBranch`, and relative
  `channelPath`; the channel branch cannot be the protected canonical or
  integration branch. `allowInitial` is `false` unless deliberately authorizing
  the first channel publication. Set `maxOmpAttempts` from `0` through `3`; it
  is one shared within-run budget across conflict resolution, compatibility
  review, and eligible build repair, rather than a fresh allowance per phase.
  Set `ompMaxTime` as a positive `s`, `m`, or `h` duration no longer than two
  hours.

From the committed trusted producer checkout, run the launcher once with
absolute existing-file paths. Use this same launcher for manual and scheduled
runs so both participate in its non-overlap guard:

```powershell
& .\scripts\Invoke-AutoBotLocalBuild.ps1 `
  -ConfigPath 'C:\secure\autobot-local.json'
```

The launcher resolves Bun from the private configuration's `runnerBun`, so a
configured toolchain update does not require a separate scheduled-action edit.
An optional explicit `-BunPath` is a checked assertion: a different resolved
path is rejected before execution, never silently substituted. The launcher
suppresses sensitive child output, propagates the controller exit code, and
rejects rooted-relative as well as ordinary relative config and Bun paths. A
same-user/configuration mutex makes an overlapping invocation a successful
no-op rather than a second producer run.

For opaque local command failures, the controller keeps the latest sixteen
structural outcomes in a fixed journal below the owner-private work root.
Records contain only fixed stage, command-kind, and outcome values; timeout
state; a numeric exit code when known; and a bounded duration. They never
contain command arguments, child streams, environment values, prompts,
credentials, URLs, or error text. Candidate build/check commands that
explicitly opt in may also retain only the newest eight redacted stdout/stderr
records in a separate private journal. Each stream preserves up to a 24 KiB
head and 8 KiB tail with an explicit omission marker, so final failure context
is not discarded; the serialized journal is capped at 1 MiB and evicts its
oldest records before writing. URLs, sensitive assignments, known credential
values, and common token/key formats are redacted before persistence; all
other publisher, Git, signing, GitHub, and OMP output remains suppressed.

An explicit rehearsal prepares the candidate only in the owned worktree and
runs the same application-only compilation, asset assembly, signing, and
focused local verification used by publication, but does not push integration,
create or update tags/releases, or advance the signed channel:

```powershell
& .\scripts\Invoke-AutoBotLocalBuild.ps1 `
  -ConfigPath 'C:\secure\autobot-local.json' `
  -VerifyOnly
```

To promote one explicitly selected preserved stage without rebuilding,
re-signing, or selecting the latest release again, pass its absolute directory.
The retained controller state, release plan, committed candidate HEAD, effective
upstream commit/version, separately pinned official release observation, and
signed stage must all describe the same candidate:

```powershell
& .\scripts\Invoke-AutoBotLocalBuild.ps1 `
  -ConfigPath 'C:\secure\autobot-local.json' `
  -PublishPrepared 'C:\secure\autobot-work\autobot-release-selected'
```

The two explicit modes are mutually exclusive. Omitting both retains the
normal guarded publish route.

To register, but not start, the dedicated weekly task:

```powershell
& .\scripts\Install-AutoBotLocalBuildTask.ps1 `
  -ConfigPath 'C:\secure\autobot-local.json'
```

The installer registers **AutoBot Local Build** for the current Windows user
at limited, interactive privilege. By default it runs every Friday at 21:17
local time; `-DayOfWeek`, `-Hour`, and `-Minute` can select a different weekly
schedule. Task Scheduler starts a missed run when the task next becomes
available, ignores a new instance while one is active, allows a run to continue
on battery power, and limits it to 72 hours. Re-running the
installer updates only the trigger of an owned task, preserving its action,
principal, settings, security descriptor, and enabled state. It refuses to
overwrite a task with a different action.

Each run pins the protected canonical branch and upstream input, then updates
only its owned persistent integration worktree. It retains the committed
producer, canonical, and upstream ancestry in a candidate merge. After source
integration and before candidate identity or compatibility review, it performs
the narrowly scoped native release-metadata synchronization and commits only
the exact changed Cargo workspace/lock and generated marker paths. This keeps
the native compatibility generation stable across application-only releases
without normalizing unrelated Rust or third-party metadata. The deterministic
controller retains the exact release plan, commands, step order, and admission
gates; OMP never chooses commands or gains permission to skip or resume pipeline
steps. Compatibility review is limited to the compatibility-relevant path
inventory and blob identities, while its coverage remains bound to the exact
canonical and effective-upstream pins and compatibility epoch; the candidate
must also retain the committed producer, canonical, and upstream ancestry.
OMP is invoked only to resolve an integration conflict, perform the mandatory
review of a sensitive compatibility change, or repair an eligible application
build or smoke failure.

Source synchronization keeps Git's whitespace gate strict for every authored
integration change. The only exception is a path whose candidate mode, type,
and blob exactly equal the same path in the immutable pinned upstream input;
the controller applies that proof independently to the staged and committed
snapshots, without caching it across mutations. Git-native conflict-marker
checks still apply, and unknown diagnostics, same-path authored changes, and
all other whitespace errors fail closed. During conflict resolution, an
unavailable focused check caused only by dependencies or native artifacts not
present in the isolated merge worktree is reported as not run rather than
withholding the mandatory nonce-bound structural repair declaration. The
controller's subsequent pinned dependency, build, test, native, signing, and
publication gates remain authoritative.

As a caller/controller integrity guard, the trusted producer checkout must keep
the same pinned `HEAD` and have no staged or unstaged tracked changes at startup
and immediately before and after every OMP hook. Untracked or ignored
dependency and native-helper paths are not classified as tracked drift. This
guard detects controller-side mutation; it is not an OS sandbox.

Build repair starts only after the controller reports a closed,
controller-derived `stepId` and its `permittedSourcePaths`. OMP may propose
source changes only inside that scope, and the controller independently
validates the declared paths, worktree, ancestry, refs, and remote snapshot
before committing an accepted repair. A successful OMP exit is never sufficient
on its own. Out-of-scope changes and control-plane, native, security,
provenance, signing, or other non-eligible failures stop the run; missing,
unpinned, or incompatible reused native inputs are never treated as a
source-repair loop. Because an accepted source repair invalidates prior
outputs, the controller calls the full builder entrypoint again from its first
admission step for fresh outputs and reapplies every build, assembly, signing,
download, and publication gate; it never replays only the failed command or
uses receipts to resume past it.

After an interrupted or separately completed publication, a stale integration
checkpoint can recover automatically only when the current signed channel,
exact immutable published release, tag, independently downloaded assets and
provenance, and integration branch all authenticate the same completed release.
That completed-channel resume is remote-write-free: it performs no release,
asset, tag, channel, or integration writes. Recovery requires forward
checkpoint ancestry and consistent owned local history, rechecks remote state
after downloading, and never republishes assets or rewrites Git history.
Pending-push markers still admit only their exact recorded outcomes; unrelated
branch movement remains an error. Published source identity is retained
separately from an in-progress next candidate so an interrupted preparation
cannot invalidate the previous published checkpoint.

The publisher validates the clean committed candidate, exact pinned tools,
pinned native provenance record, current native source-input fingerprint,
artifact bytes, and the signed predecessor before compiling the Windows x64
application only. It does not run Cargo or rebuild native add-ons. It also
builds the immutable bootstrap, relay/collab web bundle, and matching
coordinator SDK/client JavaScript required by the existing four-asset signed
topology. Coordinator SDK stage reuse validates the full source and staged
content bytes plus the exact first-party closure on every resolution; it does
not trust mtimes. File reads and copies run in bounded batches and each batch is
fully drained before an error is reported. This is not a dependency or
`node_modules` cache: the frozen candidate install and native-input admission
still run. Broad lint, type, and test suites belong to normal CI, not every
local publication build. The publisher retains focused application-version,
managed `--autobot-build-identity`, help, fresh-profile, loader, and
baseline-native smokes. The blob-broker smoke uses the supported in-process
`LocalBlobBackend` on Windows and verifies publication, fetch, status metrics,
and cleanup; non-Windows retains the worker-host IPC round trip. The publisher
then signs and verifies the local quartet and creates or confirms the exact
candidate tag without force before creating a draft. It independently
downloads and verifies uploaded bytes, publishes only that verified draft, and
advances the signed channel last. Authentication, admission, signature,
integrity, provenance, asset-topology, predecessor,
immutable-prepared-publication, independent download, safe-idle, and recovery
checks remain mandatory. Channel predecessor checks compare raw committed Git
blobs, not checkout bytes affected by line-ending conversion. Publication
does not install a runtime, change PATH, schedule a task, or deploy the
coordinator.

To recover a preserved signed stage, a reviewed operator can call
`publishPreparedLocalRelease(config, candidate, preservedStageRoot, recorder)`
from `scripts/autobot-local-release.ts`. The caller must select the exact stage;
the API never searches for the newest stage, rebuilds, or re-signs. It validates
the retained inputs and copies them into a private verification snapshot,
preserving the supplied stage. It creates a draft only when none exists. For
one exact matching next-sequence draft, every retained asset already present is
downloaded and hash-compared, foreign, duplicate, changed, or ambiguous state
fails closed, and only the exact missing retained signed assets are uploaded.
The complete remote release is then independently downloaded and subjected to
the full hash, signature, provenance, predecessor, and four-asset topology
validation before publication; the signed channel advances last. An exact
already-published next release follows the same independent verification and
can complete channel-only promotion without republication. A release already
named by the current signed channel takes the read-only completed-publication
resume path above. Conflicting tags, foreign or ambiguous drafts, altered
assets, and stale predecessor state fail closed.

Publisher subprocesses inherit the caller's current environment unless an
explicit environment is supplied. Operators can therefore isolate Git settings
with a process-local `GIT_CONFIG_GLOBAL`; the publisher does not itself create
that isolation file.

#### Install or migrate the managed bootstrap

Run the installer from a reviewed checkout with explicit values:

```sh
bun scripts/autobot-install.ts \
  --root /absolute/path/to/autobot-root \
  --channel-url https://example.invalid/channel/signed-envelope.json \
  --trusted-key release-key-id=/secure/path/release-public.spki \
  --portal-url https://portal.example.invalid/live \
  --artifact-origin https://github.com/ \
  --artifact-origin https://release-assets.githubusercontent.com/
```

`--root` must be new, empty, a recoverable/managed AutoBot root, or (only with
`--migrate-legacy`) a directory containing one plain legacy `omp` binary:

```sh
bun scripts/autobot-install.ts ... --migrate-legacy
```

The installer does not read the root, channel, key, portal, or artifact
allowlist from dotenv, bunfig, package metadata, or the current project.
For an already managed root it first recovers any authenticated publication
journal, then verifies and publishes the selected release. On Windows, stable
launcher replacement retains a mapped backup and is journaled for idempotent
recovery; processes already mapped to older bytes continue running. The
installation-wide preferred pointer advances monotonically, so an older live
session cannot roll back the release selected by later launches. Migration
refuses live legacy users/workers, records signed state first, and atomically
replaces the legacy launcher only as its final action. Supply every exact
HTTPS artifact origin needed by signed asset redirects—wildcards, paths,
credentials, queries, and host-only allowlists are rejected.

The installer never modifies `PATH`. To invoke the stable managed launcher as
plain `omp`, the operator must prepend the installation root to `PATH` and
keep that root in place; no alias, shim, or copied launcher is required.

#### Publication, polling, and per-session handoff

The hourly upstream-integration and signed-promotion producer schedules above
are unchanged. Managed runtimes have a separate consumer loop: after
authenticated startup they check immediately, then start the next check
30 seconds after the preceding cycle completes. A verified newer compatible
release is staged and published as the installation-wide preference without
waiting for every running session to become idle. Fresh launches refresh the
signed channel and select that preference independently of any per-session
handoff or journal owned by an older process.

Only channel transport unavailability permits a fresh launch to fall back to a
reverified installed release. Invalid signatures, malformed or conflicting
content, unsafe publication state, and other verification failures fail closed.
`omp update --status` is the exception to fresh-launch refresh: for a managed
installation it performs no network access or mutation and reports the latest
phase, outcome, release sequence, timestamp, and stable reason code. Deferral
codes identify actionable blockers such as active session work or resources,
collaboration readiness, MCP traffic, connection work, or coordinator
contention. A normal `omp update` launched through the managed bootstrap uses
the same signed managed route; the command's unmanaged behavior is unchanged.

Each running session remains pinned to its own launch release until its own
handoff succeeds. Busy sessions neither block publication nor prevent idle
sessions and new launches from using a newer release. A handoff requires only
that session to be persisted and locally ready: no active agent-owned browser
tab, computer/eval/Python/DAP resource, owned hub service, unsafe interactive
state, or incompatible collaboration guest. These checks, collaboration
preflight, and broker preflight are repeated at the mutation boundary; deferred
or contended work is retried by a later cycle.

An idle MCP connection does not by itself block replacement. Connecting or
reconnecting servers, outbound calls, inbound request handlers, and pending
response writes do defer it. Once idle, a reversible manager/transport fence
prevents new MCP work during the boundary; aborting the handoff releases the
fence. A successful replacement reconnects MCP servers in the successor, so
session-local MCP server state is reset rather than carried across the restart.

Connected browser guests are a separate local-readiness condition. Every
connected managed guest must negotiate the restart capability and confirm its
browser-local draft is recoverable; a post-acknowledgement edit or capability
change cancels the preparation. After replacement, guests discover the exact
new session and must fully reload before using changed capabilities. An older
or manually connected incompatible guest defers that session's handoff rather
than being forcibly replaced; browser-local drafts remain local.

The replacement resumes the exact persisted session file with its exact
session ID, profile, cwd, and session-selected current model. It reconstructs
only the approved durable config-file list and safe launch flags. It does not
replay original argv, a prompt, file arguments, model override, or credentials.
Text already typed in the composer is retained through the normal session
draft sidecar instead of being injected as a new prompt.

The coordinator is authoritative for the reservation. The current reservation
is **390 seconds**: a **270-second** worst-case execution floor plus a
**120-second** pre-commit margin; the candidate ready deadline is
**60 seconds**. The predecessor measures elapsed time before the irreversible
boundary, and an existing lease is never extended.

Handoffs are bound to authenticated launch ownership and exact owner/claim
compare-and-swap journals. The bootstrap owns its child for the whole launch
and peeks at normal exit only after a child exits `0`: a valid foreign-owned
pending journal is left alone, while malformed or unauthenticated authority
fails closed. A pre-activation candidate failure may restore only its recorded
predecessor, with broker/browser ownership restored before accepting work.
Once activation begins, a missing acknowledgement is indeterminate: no global
rollback or unrelated fallback is attempted. Already-running legacy binaries
do not acquire this publication, polling, or handoff policy until they restart
through, or update into, the corrected managed installation.

---

## Monorepo Packages

| Package                                                                       | Description                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **[@oh-my-pi/collab-web](packages/collab-web)**                               | Browser guest client, mock host, and local relay for collab live sessions   |
| **[@oh-my-pi/pi-ai](packages/ai)**                                            | Multi-provider LLM client with streaming and model/provider integration     |
| **[@oh-my-pi/pi-catalog](packages/catalog)**                                  | Model catalog: bundled model database, provider descriptors, and identity   |
| **[@oh-my-pi/pi-agent-core](packages/agent)**                                 | Agent runtime with tool calling and state management                        |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)**                        | Interactive coding agent CLI and SDK                                        |
| **[@oh-my-pi/pi-tui](packages/tui)**                                          | Terminal UI library with differential rendering                             |
| **[@oh-my-pi/pi-natives](packages/natives)**                                  | N-API bindings for grep, shell, image, text, syntax highlighting, and more  |
| **[@oh-my-pi/omp-stats](packages/stats)**                                     | Local observability dashboard for AI usage statistics                       |
| **[@oh-my-pi/omptype](packages/omptype)**                                     | ArkType-compatible schema validation with lazy JIT compilation              |
| **[@oh-my-pi/pi-utils](packages/utils)**                                      | Shared utilities (logging, streams, dirs/env/process helpers)               |
| **[@oh-my-pi/pi-wire](packages/wire)**                                        | Shared collab live-session protocol types and relay constants               |
| **[@oh-my-pi/pi-mnemopi](packages/mnemopi)**                                  | Local SQLite memory engine for Oh My Pi agents                              |
| **[@oh-my-pi/snapcompact](packages/snapcompact)**                             | Bitmap-frame context compression package and SQuAD eval suite               |
| **[@oh-my-pi/browser-relay](packages/browser-relay)**                         | Chrome extension that lets the Eval browser API drive your existing tabs    |
| **[@oh-my-pi/pi-metaharness](packages/metaharness)**                          | Unified benchmark runners, Harbor run storage, REST/SSE API, live dashboard |
| **[@oh-my-pi/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | Edit benchmark suite built on TypeScript source mutations                   |

### Rust Crates

| Crate                                              | Description                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**                | Core Rust native addon (N-API `cdylib`) used by `@oh-my-pi/pi-natives`; aggregates the crates below |
| **[pi-shell](crates/pi-shell)**                    | Embedded shell / PTY / process management split out of `pi-natives` (wraps `brush-*`)               |
| **[pi-ast](crates/pi-ast)**                        | tree-sitter-based code summarizer and AST utilities (50+ language grammars)                         |
| **[pi-iso](crates/pi-iso)**                        | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy          |
| **[pi-voice](crates/pi-voice)**                    | Audio capture/playback, Opus codecs, and live WebRTC streaming primitives                           |
| **[pi-walker](crates/pi-walker)**                  | Parallel ignore-aware filesystem walker with the scan cache shared by grep, glob, and workspace     |
| **[pi-edit](crates/pi-edit)**                      | Edit engine behind the `edit` tool: line-anchored patch/hashline modes, streaming previews, atomic apply |
| **[brush-core](crates/vendor/brush-core)**         | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution        |
| **[pi-builtins](crates/pi-builtins)**              | Bash builtins (cd, echo, test, printf, read, export, …) plus 67 in-process command-line utilities |

## Contributing

Issues and pull requests are open to everyone. Open PRs are currently a
**trial** — the previous vouch requirement is lifted while we evaluate how it
goes, and it may return. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for
guidelines on contributing.

---

## License

OMP is licensed under the [MIT License](LICENSE).

Third-party and vendored code, including `crates/vendor/brush-core` and the
third-party portions identified in `crates/pi-builtins/LICENSE`, remains under
its respective upstream license. See `THIRD-PARTY-NOTICES.txt` and
component-local notices for attribution and additional terms.

© 2025 Mario Zechner  
© 2025-2026 Can Bölük  
© 2026 Stencil Labs, Inc.

_made for terminals that stay open_

- [omp.sh](https://omp.sh)
- [GitHub](https://github.com/can1357/oh-my-pi)
- [Changelog](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
- [Discord](https://discord.gg/4NMW9cdXZa)
- [MIT](https://github.com/can1357/oh-my-pi/blob/main/LICENSE)
