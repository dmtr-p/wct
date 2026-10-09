import { type AgentGate, agentRules } from "./agent-rules";

export type AgentName = "claude" | "codex";
export type AgentState = "idle" | "working" | "blocked" | "unknown";
export type AgentFreshness = "fresh" | "stale" | "unavailable";
export interface AgentClassification {
  state: AgentState;
  rule: string;
  source: "screen" | "title" | "none";
  skip?: boolean;
  strong?: boolean;
}
export interface AgentObservation {
  agent: AgentName;
  generation: string;
  state: AgentState;
  freshness: AgentFreshness;
  reason: string;
  observedAt: number;
  lastValid?: { classification: AgentClassification; at: number };
  pendingIdle?: boolean;
}
export const AGENT_FRESHNESS_MS = 5000;

export function identifyAgent(command: string): AgentName | undefined {
  const name = command.split("/").at(-1)?.toLowerCase();
  if (name === "claude" || name === "claude-code") return "claude";
  if (name === "codex") return "codex";
  return undefined;
}

/** Only official package entrypoints, never arbitrary mentions in arguments. */
export function identifyAgentArgv(
  argv: readonly string[],
): AgentName | undefined {
  const direct = identifyAgent(argv[0] ?? "");
  if (direct) return direct;
  const runtime = argv[0]?.split("/").at(-1);
  if (runtime !== "node" && runtime !== "bun") return undefined;
  let index = 1;
  while (argv[index]?.startsWith("-")) {
    const flag = argv[index++];
    if (flag === "--") break;
    // Only unambiguous flags that do not consume an argument are supported.
    if (!flag || !["--no-warnings", "--enable-source-maps"].includes(flag))
      return undefined;
  }
  const script = argv[index] ?? "";
  if (/(?:^|\/)node_modules\/@anthropic-ai\/claude-code\/cli\.js$/.test(script))
    return "claude";
  if (/(?:^|\/)node_modules\/@openai\/codex\/bin\/codex\.js$/.test(script))
    return "codex";
  return undefined;
}

// Region extraction adapts Herdr's pinned manifest engine (Apache-2.0).
// Physical lines, including blank lines, are retained throughout.
const isRule = (line: string) => /^─{3,}/u.test(line.trim());
const isPrompt = (line: string) => line === "›" || line.startsWith("› ");
const isResponse = (line: string) => /^[•■✗✓]/u.test(line);
export function agentRegion(
  screen: string,
  region: string,
  title = "",
): string {
  if (region === "osc_title") return title;
  const lines = screen.replace(/\r\n/g, "\n").split("\n");
  const prompt = lines.findLastIndex(isPrompt);
  const current =
    prompt >= 0 && !lines.slice(prompt + 1).some(isResponse) ? prompt : -1;
  const borders = lines.flatMap((line, index) => (isRule(line) ? [index] : []));
  const top = borders.at(-2);
  switch (region) {
    case "whole_recent":
      return lines.join("\n");
    case "after_last_prompt_marker":
      return lines.slice(prompt + 1).join("\n");
    case "before_current_prompt_marker":
      return (current < 0 ? lines : lines.slice(0, current)).join("\n");
    case "whole_recent_without_current_prompt_marker":
      return current < 0 ? lines.join("\n") : "";
    case "prompt_box_body":
      return top === undefined
        ? ""
        : lines.slice(top + 1, borders.at(-1)).join("\n");
    case "last_non_empty_above_prompt_box":
      return (
        (top === undefined ? lines : lines.slice(0, top)).findLast((line) =>
          line.trim(),
        ) ?? ""
      );
    case "after_last_horizontal_rule":
      return lines.slice((borders.at(-1) ?? -1) + 1).join("\n");
  }
  const bounded = /^(top|bottom)_non_empty_lines\((\d+)\)$/.exec(region);
  if (bounded) {
    const nonempty = lines.flatMap((line, index) =>
      line.trim() ? [index] : [],
    );
    const count = Number(bounded[2]);
    return bounded[1] === "top"
      ? lines.slice(0, (nonempty[count - 1] ?? lines.length - 1) + 1).join("\n")
      : lines
          .slice(nonempty[Math.max(0, nonempty.length - count)] ?? lines.length)
          .join("\n");
  }
  return "";
}

const regexCache = new Map<string, RegExp>();
export function agentRegex(pattern: string): RegExp {
  const existing = regexCache.get(pattern);
  if (existing) return existing;
  let flags = "u";
  const source = pattern
    .replace(/\(\?([ims]+)\)/g, (_match, modes: string) => {
      for (const mode of modes) if (!flags.includes(mode)) flags += mode;
      return "";
    })
    .replace(/\\A/g, "^")
    .replace(/\\z/g, "(?![\\s\\S])")
    .replace(/\\x\{([0-9a-fA-F]+)\}/g, "\\u{$1}");
  const compiled = new RegExp(source, flags);
  regexCache.set(pattern, compiled);
  return compiled;
}

export function agentGateMatches(gate: AgentGate, text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (gate.contains ?? []).every((value) =>
      lower.includes(value.toLowerCase()),
    ) &&
    (gate.regex ?? []).every((pattern) => agentRegex(pattern).test(text)) &&
    (gate.line_regex ?? []).every((pattern) =>
      text.split("\n").some((line) => agentRegex(pattern).test(line)),
    ) &&
    (gate.all ?? []).every((child) => agentGateMatches(child, text)) &&
    (!gate.any?.length ||
      gate.any.some((child) => agentGateMatches(child, text))) &&
    (gate.not ?? []).every((child) => !agentGateMatches(child, text))
  );
}

function codexStatusLine(line: string): boolean {
  const fields = line.trim().split(/\s+·\s+/u);
  return (
    fields.some((field) => /^(?:gpt-\S+|o[134](?:-\S+)?)$/i.test(field)) &&
    fields.some((field) =>
      /^(?:(?:weekly|5h) \d{1,3}% left|\d{1,3}% context left)$/i.test(field),
    )
  );
}

/** Footer evidence bounds the entire editable draft, including blank paragraphs. */
function codexComposer(screen: string) {
  const lines = screen.replace(/\r\n/g, "\n").split("\n");
  const prompt = lines.findLastIndex(isPrompt);
  if (prompt < 0 || lines.slice(prompt + 1).some(isResponse)) return undefined;
  const footerIndex = lines.findLastIndex(
    (line, index) =>
      index > prompt &&
      (/(?:\? for shortcuts|enter to send|to queue(?: message)?\b)/i.test(
        line,
      ) ||
        /^\s*\d{1,3}% context left\s*$/i.test(line) ||
        (index > prompt + 1 &&
          !lines[index - 1]?.trim() &&
          codexStatusLine(line))),
  );
  if (footerIndex < 0) return undefined;
  const footer = lines.slice(footerIndex).join("\n");
  // A configured status line with a draft is passive only without a running
  // task (Codex 0.162.0). Usage alone and queue hints are not readiness evidence.
  const hasDraft = lines
    .slice(prompt, footerIndex)
    .some((line, index) => !!(index === 0 ? line.slice(1) : line).trim());
  const passiveStatusLine =
    hasDraft && codexStatusLine(lines[footerIndex] ?? "");
  const controlLines = lines.map((line, index) =>
    index >= prompt && index < footerIndex
      ? index === prompt
        ? "›"
        : ""
      : line,
  );
  return {
    footer,
    passiveStatusLine,
    screen: controlLines.join("\n"),
    blockerScreen: controlLines
      .map((line, index) => (index < prompt ? "" : line))
      .join("\n"),
  };
}

/** Keep Claude's prompt-box readiness markers without interpreting its draft. */
function claudeComposer(screen: string) {
  const lines = screen.replace(/\r\n/g, "\n").split("\n");
  const borders = lines.flatMap((line, index) => (isRule(line) ? [index] : []));
  const top = borders.at(-2);
  const bottom = borders.at(-1);
  if (top === undefined || bottom === undefined) return undefined;
  const prompt = lines.findIndex(
    (line, index) => index > top && index < bottom && !!line.trim(),
  );
  if (prompt < 0 || !/^\s*❯(?:\s|$)/u.test(lines[prompt] ?? ""))
    return undefined;
  const footer = lines.slice(bottom + 1).join("\n");
  // Selection dialogs can also use ❯ and borders. Their live controls belong
  // outside the editable box, and must remain available to blocker rules.
  if (
    /(?:esc to cancel|enter to (?:select|confirm)|arrows? to navigate)/i.test(
      footer,
    ) ||
    (/^\s*❯\s*\d+[.)]\s/u.test(lines[prompt] ?? "") &&
      !/\? for shortcuts/i.test(footer))
  )
    return undefined;
  const controlLines = lines.map((line, index) =>
    index > top && index < bottom ? (index === prompt ? "❯" : "") : line,
  );
  return {
    screen: controlLines.join("\n"),
    blockerScreen: controlLines
      .map((line, index) => (index < top ? "" : line))
      .join("\n"),
  };
}

export function classifyAgent(
  agent: AgentName,
  screen: string,
  title = "",
): AgentClassification {
  const composer = agent === "codex" ? codexComposer(screen) : undefined;
  const promptBox = agent === "claude" ? claudeComposer(screen) : undefined;
  const controlScreen = promptBox?.screen ?? composer?.screen ?? screen;
  // A live composer separates completed responses from current dialog UI.
  // Activity rows above it remain available to working rules, but completed
  // response text cannot establish a blocker or corroborate a blocked title.
  const blockerScreen =
    promptBox?.blockerScreen ?? composer?.blockerScreen ?? controlScreen;
  const candidates = agentRules[agent].filter((rule) =>
    agentGateMatches(
      rule,
      agentRegion(
        rule.state === "blocked" ? blockerScreen : controlScreen,
        rule.region,
        title,
      ),
    ),
  );
  const matched = candidates
    .filter(
      (rule) =>
        rule.id !== "osc_title_blocked" ||
        candidates.some(
          (candidate) =>
            candidate.state === "blocked" && candidate.region !== "osc_title",
        ),
    )
    .sort((a, b) => b.priority - a.priority)[0];
  if (matched)
    return {
      state: matched.state,
      rule: matched.id,
      source: matched.region === "osc_title" ? "title" : "screen",
      skip: matched.skip_state_update,
      strong: !!(
        matched.visible_blocker ||
        matched.visible_working ||
        matched.visible_idle
      ),
    };
  // Unlike Herdr's arbitrary title fallback, require the live composer AND
  // its readiness footer. A composer alone can coexist with an active turn.
  if (composer) {
    const { footer, passiveStatusLine } = composer;
    if (
      (/(?:\? for shortcuts|enter to send)/i.test(footer) ||
        passiveStatusLine) &&
      !/(?:interrupt|allow command|submit answer|confirm|esc to cancel|to queue)/i.test(
        footer,
      )
    ) {
      return {
        state: "idle",
        rule: passiveStatusLine
          ? "live_ready_statusline"
          : "live_ready_composer",
        source: "screen",
        strong: false,
      };
    }
  }
  return { state: "unknown", rule: "no_match", source: "none" };
}

/** Last valid state never has its age renewed by a skip or error. */
export function reconcileAgent(
  previous: AgentObservation | undefined,
  agent: AgentName,
  generation: string,
  next: AgentClassification | undefined,
  now: number,
  error = "observation_failed",
): AgentObservation {
  const prior =
    previous?.generation === generation && previous.agent === agent
      ? previous
      : undefined;
  if (!next || next.skip) {
    const valid = prior?.lastValid;
    const retained =
      valid &&
      prior?.state !== "unknown" &&
      now - valid.at < AGENT_FRESHNESS_MS;
    return {
      agent,
      generation,
      state: retained ? valid.classification.state : "unknown",
      freshness: retained ? "stale" : "unavailable",
      reason: next?.rule ?? error,
      observedAt: now,
      lastValid: valid,
    };
  }
  const confirmIdle =
    next.state === "idle" &&
    !next.strong &&
    prior?.state === "working" &&
    !prior.pendingIdle;
  if (confirmIdle)
    return {
      ...prior,
      freshness: "stale",
      reason: "confirming_idle",
      observedAt: now,
      pendingIdle: true,
    };
  return {
    agent,
    generation,
    state: next.state,
    freshness: "fresh",
    reason: next.rule,
    observedAt: now,
    lastValid:
      next.state === "unknown"
        ? prior?.lastValid
        : { classification: next, at: now },
  };
}

export function agentPaneLabel(observation: AgentObservation): string {
  return `${observation.agent} · ${observation.state}${observation.freshness === "fresh" ? "" : ` (${observation.freshness})`}`;
}

export function agentSummary(
  observations: readonly AgentObservation[],
): string {
  const counts: Record<AgentState, number> = {
    blocked: 0,
    working: 0,
    idle: 0,
    unknown: 0,
  };
  const stale = new Set<AgentState>();
  for (const observation of observations)
    counts[
      observation.freshness === "unavailable" ? "unknown" : observation.state
    ]++;
  for (const observation of observations)
    if (observation.freshness === "stale") stale.add(observation.state);
  return (Object.keys(counts) as AgentState[])
    .filter((state) => counts[state])
    .map(
      (state) =>
        `${counts[state]} ${state}${stale.has(state) ? " (stale)" : ""}`,
    )
    .join(" · ");
}

/** Presentation equality intentionally ignores timestamps and raw evidence. */
export function sameAgentPresentation(
  a: AgentObservation | undefined,
  b: AgentObservation | undefined,
): boolean {
  return (
    a?.agent === b?.agent &&
    a?.generation === b?.generation &&
    a?.state === b?.state &&
    a?.freshness === b?.freshness
  );
}

/** Also expire presentation while an observation cycle is still in flight. */
export function expireAgentObservation(
  observation: AgentObservation,
  now: number,
): AgentObservation {
  const at =
    observation.freshness === "stale"
      ? (observation.lastValid?.at ?? observation.observedAt)
      : observation.observedAt;
  if (observation.freshness === "unavailable" || now - at < AGENT_FRESHNESS_MS)
    return observation;
  return {
    ...observation,
    state: "unknown",
    freshness: "unavailable",
    reason: "observation_expired",
  };
}
