import { describe, expect, test } from "vitest";
import {
  agentGateMatches,
  agentPaneLabel,
  agentRegex,
  agentRegion,
  agentSummary,
  classifyAgent,
  identifyAgent,
  identifyAgentArgv,
  reconcileAgent,
  sameAgentPresentation,
} from "../../src/services/agent-model";
import { agentRules } from "../../src/services/agent-rules";

describe("agent identity", () => {
  test("recognizes exact executables and aliases, not arbitrary mentions", () => {
    expect(identifyAgent("/opt/bin/claude-code")).toBe("claude");
    expect(identifyAgent("codex")).toBe("codex");
    for (const command of ["fish", "vim", "claude-helper", "ssh", "node"])
      expect(identifyAgent(command)).toBeUndefined();
    expect(
      identifyAgentArgv([
        "node",
        "/pkg/node_modules/@openai/codex/bin/codex.js",
      ]),
    ).toBe("codex");
    expect(
      identifyAgentArgv([
        "bun",
        "/pkg/node_modules/@anthropic-ai/claude-code/cli.js",
      ]),
    ).toBe("claude");
    for (const argv of [
      ["node", "-e", "codex"],
      ["node", "/project/codex.js"],
      ["node", "server.js", "claude"],
      ["ssh", "host", "codex"],
    ])
      expect(identifyAgentArgv(argv)).toBeUndefined();
  });
});

describe("agent classifier", () => {
  test("every adapted regex compiles with explicit JavaScript flags", () => {
    const visit = (
      gate: import("../../src/services/agent-rules").AgentGate,
    ) => {
      for (const pattern of [...(gate.regex ?? []), ...(gate.line_regex ?? [])])
        expect(agentRegex(pattern)).toBeInstanceOf(RegExp);
      for (const child of [
        ...(gate.all ?? []),
        ...(gate.any ?? []),
        ...(gate.not ?? []),
      ])
        visit(child);
    };
    for (const rules of Object.values(agentRules))
      for (const rule of rules) visit(rule);
  });
  test("gates preserve nested AND, OR, NOT and line boundaries", () => {
    const gate = {
      contains: ["cancel"],
      any: [
        { contains: ["confirm"] },
        {
          all: [
            { regex: ["(?i)^accept"] },
            { not: [{ contains: ["quoted"] }] },
          ],
        },
      ],
    };
    expect(agentGateMatches(gate, "Accept and cancel")).toBe(true);
    expect(agentGateMatches(gate, "Accept quoted and cancel")).toBe(false);
    expect(
      agentGateMatches(
        { line_regex: ["^control$"] },
        "quoted control\ncontrol\n",
      ),
    ).toBe(true);
    expect(agentRegex("\\Ahello\\z").test("hello\n")).toBe(false);
  });
  test("bounded regions exclude stale transcript controls and preserve blank rows", () => {
    const screen = "old allow command?\n\n› current\nready\n";
    expect(agentRegion(screen, "after_last_prompt_marker")).toBe("ready\n");
    expect(
      agentRegion(screen, "whole_recent_without_current_prompt_marker"),
    ).toBe("");
    expect(agentRegion("one\n\ntwo\nthree", "top_non_empty_lines(2)")).toBe(
      "one\n\ntwo",
    );
    expect(agentRegion("one\n\ntwo\nthree", "bottom_non_empty_lines(2)")).toBe(
      "two\nthree",
    );
  });
  test("Codex composer alone and arbitrary titles do not prove readiness", () => {
    expect(classifyAgent("codex", "› prompt", "project title").state).toBe(
      "unknown",
    );
    expect(classifyAgent("codex", "› prompt\n? for shortcuts").state).toBe(
      "idle",
    );
    expect(classifyAgent("codex", "starting up", "Action Required").state).toBe(
      "unknown",
    );
  });
  test("Codex populated composer stays idle with its passive model/usage footer", () => {
    const footer =
      "  GPT-6.1-Sol · 202-agent-detect · weekly 80% left · 5h 71% left";
    const screen = `• Choose an option or type a reply.\n\n› with text in composer, status is unknown\n\n${footer}\n`;
    expect(classifyAgent("codex", screen)).toMatchObject({
      state: "idle",
      rule: "live_ready_statusline",
    });
    expect(
      classifyAgent("codex", `› draft\n  continued draft\n\n${footer}`).state,
    ).toBe("idle");
    expect(
      classifyAgent("codex", `› draft\n\n  82% context left · gpt-5.4`).state,
    ).toBe("idle");
    for (const unsupported of [
      `› draft\n${footer}`, // No physical separation from the draft.
      `› draft\n\n  weekly 80% left`, // Usage alone also appears during work.
      `› draft\n\n  GPT-6.1-Sol · project`, // Arbitrary metadata is insufficient.
      `${footer}\n› draft`, // Historical footer above the composer.
      `›\n\n${footer}`, // An empty composer can show passive context during work.
      `› draft\n\n${footer}\n  tab to queue message`,
    ])
      expect(classifyAgent("codex", unsupported).state).toBe("unknown");
    expect(classifyAgent("codex", screen, "⠋ busy").state).toBe("working");
    expect(
      classifyAgent(
        "codex",
        `• Working (2s • esc to interrupt)\n\n› draft\n\n${footer}`,
      ).state,
    ).toBe("working");
    expect(
      classifyAgent(
        "codex",
        "Allow command?\nPress enter to confirm or esc to cancel",
      ).state,
    ).toBe("blocked");
  });
  test("completed Codex response timers do not establish live activity", () => {
    for (const response of [
      "• Build completed (2s)",
      "• Working (2s)",
      "• Build completed (1h 2m 3s)",
      "• Working (2s • esc to interrupt)\n• Build completed (2s)",
    ]) {
      expect(
        classifyAgent("codex", `${response}\n\n› prompt\n? for shortcuts`)
          .state,
      ).toBe("idle");
      expect(classifyAgent("codex", response).state).toBe("unknown");
    }
    for (const control of ["esc", "ctrl+c", "F2"]) {
      expect(
        classifyAgent(
          "codex",
          `• Investigating (2s • ${control} to interrupt)\n\n› prompt\n? for shortcuts`,
        ).state,
      ).toBe("working");
    }
    const working = reconcileAgent(
      undefined,
      "codex",
      "job",
      classifyAgent("codex", "", "⠋ busy"),
      0,
    );
    const completed = classifyAgent(
      "codex",
      "• Build completed (2s)\n\n› prompt\n? for shortcuts",
    );
    const pending = reconcileAgent(working, "codex", "job", completed, 1000);
    expect(pending.state).toBe("working");
    expect(reconcileAgent(pending, "codex", "job", completed, 2000).state).toBe(
      "idle",
    );
  });
  test("Codex draft paragraphs are excluded from live controls, including title corroboration", () => {
    const footer = "  GPT-6.1-Sol · weekly 80% left · 5h 71% left";
    for (const phrase of [
      "allow command?",
      "allow command?\n  esc to cancel",
      "Press enter to confirm or esc to cancel",
      "enter to submit answer",
      "enter to submit all",
      "All Results · Filesystem Only · Plugins",
      "Update available!\n  Update now\n  Skip until next version\n  Press enter to continue",
    ]) {
      const screen = `› Explain this message:\n  ${phrase}\n\n  And explain its meaning.\n\n${footer}`;
      expect(classifyAgent("codex", screen).state).toBe("idle");
      expect(classifyAgent("codex", screen, "Action Required").state).toBe(
        "idle",
      );
      expect(classifyAgent("codex", screen, "⠋ busy").state).toBe("working");
    }
    const longDraft = `›\n  Explain this message:\n\n  allow command?\n${"  continued draft\n".repeat(12)}\n${footer}`;
    expect(classifyAgent("codex", longDraft).state).toBe("idle");
    expect(
      classifyAgent("codex", "› Explain this message:\n  allow command?").state,
    ).toBe("unknown");
    const queuedDraft =
      "• Working (2s • esc to interrupt)\n\n› Explain this message:\n  enter to submit all\n\n  tab to queue message · 82% context left";
    expect(classifyAgent("codex", queuedDraft).state).toBe("working");
    expect(classifyAgent("codex", "Allow command?\nEsc to cancel").state).toBe(
      "blocked",
    );
    expect(
      classifyAgent("codex", "Question\nenter to submit answer").state,
    ).toBe("blocked");
  });
  test("Codex keeps live activity ahead of the composer and rejects old activity", () => {
    expect(
      classifyAgent(
        "codex",
        "• Working (2s • esc to interrupt)\n\n› prompt\n? for shortcuts",
      ).state,
    ).toBe("working");
    expect(
      classifyAgent(
        "codex",
        "• Working (2s • esc to interrupt)\n• Finished\n\n› prompt\n? for shortcuts",
      ).state,
    ).toBe("idle");
    expect(
      classifyAgent(
        "codex",
        "› prompt\nPress enter to confirm or esc to cancel",
        "⠋ busy",
      ).state,
    ).toBe("working");
    expect(
      classifyAgent(
        "codex",
        "› prompt\nPress enter to confirm or esc to cancel",
        "Action Required",
      ).state,
    ).toBe("blocked");
    expect(
      classifyAgent("codex", "old allow command?\n› prompt\n? for shortcuts")
        .state,
    ).toBe("idle");
  });
  test("Claude working and approval controls outrank readiness", () => {
    const composer = "──────\n❯\n──────\n? for shortcuts";
    expect(classifyAgent("claude", composer).state).toBe("idle");
    expect(
      classifyAgent("claude", `✻ Thinking… (2s · ↓ 10 tokens)\n${composer}`)
        .state,
    ).toBe("working");
    expect(
      classifyAgent(
        "claude",
        "Bash command\necho hello\nDo you want to proceed?\n❯ 1. Yes\n2. No\nEsc to cancel",
      ).state,
    ).toBe("blocked");
    expect(
      classifyAgent(
        "claude",
        "──────\nQuestion\nEnter to select · arrows to navigate · esc to cancel",
      ).state,
    ).toBe("blocked");
    expect(classifyAgent("claude", "Initializing...").state).toBe("unknown");
  });
  test.each([
    ["● Flummoxing…", "50s"],
    ["● Flummoxing…", "1m 2s"],
    ["● Flummoxing…", "1h 2m 3s"],
    ["⏺ Flummoxing…", "50s"],
    ["• Flummoxing...", "50s"],
  ])(
    "Claude recognizes %s with %s of live token progress",
    (spinner, elapsed) => {
      const screen = [
        "Should I start the fix PR?",
        "* Cooked for 1h 57m 48s · done 12:52 PM",
        "❯ yes",
        "● Creating worktree for Jira live fixes",
        "  └ /private/tmp/claude/scratchpad/jlive/spec.md",
        "",
        `${spinner} (${elapsed} · ↓ 3.7k tokens)`,
        "",
        "────────────────────────────────────────",
        "❯",
        "────────────────────────────────────────",
        "Opus 5.5 | 196.7k | Session: 10.0% | project",
        "⏵⏵ auto mode on (shift+tab to cycle)",
      ].join("\n");
      expect(classifyAgent("claude", screen)).toMatchObject({
        state: "working",
        rule: "live_turn_dot_working",
        strong: true,
      });
    },
  );
  test("Claude response bullets and completed timers do not establish live dot activity", () => {
    const composer = "──────\n❯\n──────\n? for shortcuts";
    for (const response of [
      "● Creating worktree for Jira live fixes",
      "● Flummoxing…",
      "● Flummoxing… (50s)",
      "● Flummoxing (50s · ↓ 3.7k tokens)",
      "* Cooked for 1h 57m 48s · done 12:52 PM",
      "● Flummoxing… (50s · ↓ 3.7k tokens)\n● Finished creating the worktree.",
    ])
      expect(classifyAgent("claude", `${response}\n\n${composer}`).state).toBe(
        "idle",
      );
  });
  test.each([1, 2, 3])(
    "Claude plan approval is blocked with option %s selected",
    (selected) => {
      const header =
        "Claude has written up a plan and is ready to execute. Would you like to proceed?";
      const options = [
        "1. Yes, and use auto mode",
        "2. Yes, manually approve edits",
        "3. Tell Claude what to change",
      ]
        .map(
          (option, index) => `${selected === index + 1 ? "❯" : " "} ${option}`,
        )
        .join("\n");
      const dialog = `${header}\n\n${options}\n  shift+tab to approve with this feedback\n\nctrl+g to edit in VS Code · ~/.claude/plans/example.md`;
      for (const screen of [
        dialog,
        `Plan contents\n──────\n${dialog}`,
        `Plan contents\n──────\n${dialog.replace("execute. Would", "execute.\nWould")}`,
      ]) {
        const classified = classifyAgent("claude", screen);
        expect(classified).toMatchObject({
          state: "blocked",
          rule: "plan_approval_prompt",
          source: "screen",
          strong: true,
        });
        expect(
          agentSummary([
            reconcileAgent(undefined, "claude", "job", classified, 0),
          ]),
        ).toBe("1 blocked");
      }
      for (const screen of [header, options])
        expect(classifyAgent("claude", screen).state).toBe("unknown");
      const composer = "──────\n❯\n──────\n? for shortcuts";
      expect(classifyAgent("claude", `${dialog}\n${composer}`).state).toBe(
        "idle",
      );
      expect(
        classifyAgent(
          "claude",
          `──────\n❯ Explain this dialog:\n${dialog}\n──────\n? for shortcuts`,
        ).state,
      ).toBe("idle");
    },
  );
  test("Claude bordered approval menus cannot establish prompt-box readiness", () => {
    const menu = "──────\n❯ 1. Yes\n2. No\n──────";
    for (const footer of [
      "Esc to cancel · Tab to amend",
      "Esc to cancel · Ctrl+E to explain",
    ]) {
      const screen = `Bash command\necho hello\nDo you want to proceed?\n${menu}\n${footer}`;
      const classified = classifyAgent("claude", screen);
      expect(classified).toMatchObject({
        state: "blocked",
        rule: "bash_permission_prompt",
        strong: true,
      });
      const observation = reconcileAgent(
        undefined,
        "claude",
        "job",
        classified,
        0,
      );
      expect(observation.freshness).toBe("fresh");
      expect(agentSummary([observation])).toBe("1 blocked");
    }
    expect(classifyAgent("claude", `${menu}\nEsc to cancel`).state).toBe(
      "unknown",
    );
    expect(classifyAgent("claude", `${menu}\n? for shortcuts`)).toMatchObject({
      state: "idle",
      rule: "live_prompt_box",
    });
  });
  test.each([
    ["1 dynamic workflow", ""],
    ["2 dynamic workflows", ""],
    ["1 dynamic workflow", "     new task? /clear to save 170.2k tokens"],
    ["1 dynamic workflow", "     Image in clipboard · ctrl+v to paste"],
    ["2 dynamic workflows", "     Image in clipboard · ctrl+v to paste"],
  ])(
    "Claude remains working while waiting for %s with composer hint '%s'",
    (workflows, hint) => {
      const screen = [
        "● Both issues are now being worked on in the background.",
        "When each one finishes, I'll open the PR, wait for CI and merge it.",
        "",
        `* Waiting for ${workflows} to finish`,
        "",
        hint,
        "────────────────────────────────────────",
        "❯",
        "────────────────────────────────────────",
        "Opus 5.5 | 93.8k | Session: 3.0% | project",
        "Enter to view · x to stop",
        "",
        "❯ ○ impl-loop ▱▱▱▱▱▱▱▱ 0/1 · 4m42s · ↓ 49.3k tokens",
        "  ○ impl-loop ▱▱▱▱▱▱▱▱ 0/1 · 4m42s · ↓ 103.7k tokens",
      ].join("\n");
      const classified = classifyAgent("claude", screen);
      expect(classified).toMatchObject({
        state: "working",
        rule: "dynamic_workflows_working",
        source: "screen",
        strong: true,
      });
      const observation = reconcileAgent(
        undefined,
        "claude",
        "job",
        classified,
        0,
      );
      expect(observation.freshness).toBe("fresh");
      expect(agentSummary([observation])).toBe("1 working");
    },
  );
  test.each([
    "1 background agent and 1 dynamic workflow",
    "2 background agents and 1 dynamic workflow",
    "1 background agent and 2 dynamic workflows",
    "2 background agents and 3 dynamic workflows",
  ])("Claude recognizes a combined wait for %s", (tasks) => {
    const screen = [
      "⏺ I've sent an Opus agent to find out where pnpm verify's time goes.",
      "#136's loop is running at the same time.",
      "",
      `✻ Waiting for ${tasks} to finish`,
      "",
      "────────────────────────────────────────",
      "❯\u00a0after 136 let's do 135",
      "────────────────────────────────────────",
      "  Opus\u00a05.5\u00a0|\u00a0263.7k\u00a0|\u00a0Session:\u00a01.0%",
      "  ↑/↓ to select",
      "",
      "❯ ⏺ main",
      "  ◯ general-purpose  Reading bundleWorkflow in bundle.ts  10m 58s · ↓ 59.1k tokens",
      "  ◯ impl-loop        ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  0/1 · 30m22s · ↓ 133.9k tokens",
    ].join("\n");
    expect(classifyAgent("claude", screen)).toMatchObject({
      state: "working",
      rule: "background_agents_working",
      strong: true,
    });
  });
  test.each([
    "○ impl-loop ▰▰▰▰▰▱ 5/6 · 1h42m · ↓ 1.0m tokens",
    "❯ ○ impl-loop ▱▱▱▱▱▱ 0/1 · 4m42s · ↓ 49.3k tokens",
    "  ◯ impl-loop        ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  0/1 · 30m22s · ↓ 133.9k tokens",
    "❯ ◯ impl-loop ▰▰▰▰▰▱ 5/6 · 1h42m · ↓ 1.0m tokens",
    "○ wave2-deliver-bloat ▰▰▰▰▰▰▰▰▰▱ 18/20 · 1h06m · ↓ 2.7m tokens · ⚠ Large workflow · /workflows to stop",
    "◯ wave2-deliver-bloat ▰▰▰▰▰▰▰▰▰▱ 18/20 · 1h06m · ↓ 2.7m tokens · ⚠️ Large workflow · /workflows to stop",
  ])("Claude keeps a compacted session working with footer row %s", (row) => {
    const screen = [
      "  └ Skills restored (gh-stack, workflow-authoring)",
      "",
      "● Compacted while idle, before the prompt cache expired",
      "",
      "────────────────────────────────────────",
      "❯",
      "────────────────────────────────────────",
      "Opus 5.5 | 0 | Session: 23.0% | project | Reset: 43m",
      "⏵⏵ auto mode on · 1 shell, 1 monitor",
      "",
      row,
    ].join("\n");
    const classified = classifyAgent("claude", screen);
    expect(classified).toMatchObject({
      state: "working",
      rule: "live_workflow_footer",
      strong: true,
    });
    const observation = reconcileAgent(
      undefined,
      "claude",
      "job",
      classified,
      0,
    );
    const refreshed = reconcileAgent(
      observation,
      "claude",
      "job",
      classifyAgent("claude", screen),
      6000,
    );
    expect(refreshed.freshness).toBe("fresh");
    expect(agentSummary([refreshed])).toBe("1 working");
  });
  test.each([
    "○ general-purpose  Finding callers and tests  4m 40s · ↓ 216.4k tokens",
    "  ◯ general-purpose  Reading sources  10m 58s · ↓ 59.1k tokens",
    "❯ ○ custom-agent  Reviewing changes  1h2m3s · ↑ 1.0m tokens",
  ])("Claude recognizes running background agent footer %s", (row) => {
    const screen = [
      "* Waiting for 1 background agent to finish",
      "",
      '● Background command "Watch main CI" completed (exit code 0)',
      "Read 1 file",
      "● Main's CI passed. The agent is still running.",
      "",
      "────────────────────────────────────────",
      "❯",
      "────────────────────────────────────────",
      "Opus 5.5 | 157.2k | Session: 7.0% | main | Reset: 3hr 57m",
      "⏵⏵ auto mode on (shift+tab to cycle)",
      "",
      "● main",
      row,
    ].join("\n");
    const classified = classifyAgent("claude", screen);
    expect(classified).toMatchObject({
      state: "working",
      rule: "live_background_agent_footer",
      source: "screen",
      strong: true,
    });
    expect(
      agentSummary([reconcileAgent(undefined, "claude", "job", classified, 0)]),
    ).toBe("1 working");
  });
  test("Claude background agent footers require live progress outside the draft", () => {
    const composer = "──────\n❯\n──────\n? for shortcuts";
    const row = "○ general-purpose  Finding callers  4m 40s · ↓ 216.4k tokens";
    for (const footer of [
      row.replace("○", "✓"),
      row.replace("○", "✗"),
      row.replace("○", "⏸"),
      row.replace("4m 40s · ", ""),
      row.replace(" · ↓ 216.4k tokens", ""),
      "○ general-purpose  Finding callers",
      "● main",
    ])
      expect(classifyAgent("claude", `${composer}\n${footer}`).state).toBe(
        "idle",
      );
    expect(classifyAgent("claude", `${row}\n${composer}`).state).toBe("idle");
    expect(classifyAgent("claude", row).state).toBe("unknown");
    expect(
      classifyAgent(
        "claude",
        `${composer}\nEnter to confirm · esc to cancel\n${row}`,
      ).state,
    ).toBe("blocked");
    expect(
      classifyAgent(
        "claude",
        `${composer}\nshowing detailed transcript\nctrl+o to toggle\n${row}`,
      ).skip,
    ).toBe(true);
  });
  test("Claude workflow footers require live, incomplete progress", () => {
    const composer = "──────\n❯\n──────\n? for shortcuts";
    const row = "○ impl-loop ▰▰▰▰▰▱ 5/6 · 1h42m · ↓ 1.0m tokens";
    for (const footer of [
      row.replace("5/6", "6/6"),
      `${row.replace("5/6", "6/6")} · ⚠ Large workflow · /workflows to stop`,
      row.replace("○", "◯").replace("5/6", "6/6"),
      row.replace("5/6", "7/6"),
      row.replace("5/6", "0/0"),
      row.replace("○", "✓"),
      row.replace("○", "✗"),
      row.replace("○", "⏸"),
      `${row.replace("○", "⏸")} · ⚠ Large workflow · /workflows to stop`,
      row.replace(" · ↓ 1.0m tokens", ""),
      "⏵⏵ auto mode on · 1 shell, 1 monitor",
    ])
      expect(classifyAgent("claude", `${composer}\n${footer}`).state).toBe(
        "idle",
      );
    expect(classifyAgent("claude", `${row}\n${composer}`).state).toBe("idle");
    expect(classifyAgent("claude", row).state).toBe("unknown");
    expect(
      classifyAgent(
        "claude",
        `${composer}\n${row.replace("5/6", "6/6")}\n${row}`,
      ).state,
    ).toBe("working");
    expect(
      classifyAgent(
        "claude",
        `──────\nQuestion\nEnter to select · arrows to navigate · esc to cancel\n${row}`,
      ).state,
    ).toBe("blocked");
  });
  test("Claude ignores completed or historical workflow waits and keeps live approvals blocked", () => {
    const composer = "──────\n❯\n──────\n? for shortcuts";
    const waiting = "* Waiting for 2 dynamic workflows to finish";
    for (const response of [
      "* Waiting for 0 dynamic workflows to finish",
      "✻ Waiting for 0 background agents and 0 dynamic workflows to finish",
      "✻ Waiting for 1 background agent and 1 dynamic workflow to finish\n⏺ Both tasks finished.",
      `${waiting}\n● Both workflows finished.`,
      `${waiting}\n● Both workflows finished.\nnew task? /clear to save 170.2k tokens`,
      `${waiting}\n● new task? /clear to save 170.2k tokens`,
      `${waiting}\n● Both workflows finished.\nImage in clipboard · ctrl+v to paste`,
      `${waiting}\n● Image in clipboard · ctrl+v to paste`,
      "Image in clipboard · ctrl+v to paste",
      `● The status says: ${waiting}`,
    ])
      expect(classifyAgent("claude", `${response}\n\n${composer}`).state).toBe(
        "idle",
      );
    expect(
      classifyAgent(
        "claude",
        `${waiting}\nRun a dynamic workflow?\nEsc to cancel`,
      ).state,
    ).toBe("blocked");
    expect(
      classifyAgent(
        "claude",
        `${waiting}\nRun a dynamic workflow?\nEsc to cancel\nImage in clipboard · ctrl+v to paste`,
      ).state,
    ).toBe("blocked");
  });
  test("Claude editable draft cannot become activity, blockers, or a menu view", () => {
    for (const draft of [
      "✻ Thinking… (2s · tokens)",
      "● Flummoxing… (50s · ↓ 3.7k tokens)",
      "⏸ esc to interrupt",
      "✻ Waiting for 2 background agents to finish",
      "* Waiting for 2 dynamic workflows to finish",
      "✻ Waiting for 1 background agent and 1 dynamic workflow to finish",
      "○ impl-loop ▰▰▰▰▰▱ 5/6 · 1h42m · ↓ 1.0m tokens",
      "◯ impl-loop ▰▰▰▰▰▱ 5/6 · 1h42m · ↓ 1.0m tokens",
      "○ general-purpose  Finding callers  4m 40s · ↓ 216.4k tokens",
      "✻ Reading · 2 MCP tasks still running",
      "run a dynamic workflow?\n  esc to cancel",
      'MCP server "example" requests your input\n  Accept\n  esc to cancel',
      "Select model\n  Enter to set as default\n  Esc to cancel",
      "showing detailed transcript\n  ctrl+o to toggle",
    ]) {
      const screen = `──────\n❯ Explain these messages:\n  ${draft}\n\n  This is another draft paragraph.\n──────\n? for shortcuts`;
      expect(classifyAgent("claude", screen)).toMatchObject({
        state: "idle",
        rule: "live_prompt_box",
        strong: true,
      });
      expect(classifyAgent("claude", screen, "⠋ busy").state).toBe("working");
      expect(
        classifyAgent("claude", `✻ Thinking… (2s · tokens)\n${screen}`).state,
      ).toBe("working");
    }
    expect(
      classifyAgent(
        "claude",
        "──────\n❯ Explain:\n  ✻ Thinking… (2s · tokens)\n──────",
      ).state,
    ).toBe("idle");
    expect(
      classifyAgent(
        "claude",
        "Bash command\nDo you want to proceed?\n──────\n❯ 1. Yes\n2. No\nEsc to cancel\n──────",
      ).state,
    ).toBe("blocked");
    expect(
      classifyAgent(
        "claude",
        "──────\n❯ 1. Yes\n2. No\n──────\nEnter to confirm · esc to cancel",
      ).state,
    ).toBe("blocked");
  });
  test("Claude completed responses cannot establish a blocker above its ready composer", () => {
    const composer = "──────\n❯\n──────\n? for shortcuts";
    for (const response of [
      "● The dialog says:\nRun a dynamic workflow?\nEsc to cancel",
      '● MCP server "example" requests your input\nAccept\nEsc to cancel',
      "● Bash command\nDo you want to proceed?\n❯ 1. Yes\n2. No\nEsc to cancel",
    ]) {
      const screen = `${response}\n\n${composer}`;
      const classified = classifyAgent("claude", screen);
      expect(classified).toMatchObject({
        state: "idle",
        rule: "live_prompt_box",
      });
      const observation = reconcileAgent(
        undefined,
        "claude",
        "job",
        classified,
        0,
      );
      expect(observation.freshness).toBe("fresh");
      expect(agentSummary([observation])).toBe("1 idle");
      expect(
        classifyAgent("claude", `✻ Thinking… (2s · tokens)\n${screen}`).state,
      ).toBe("working");
    }
    expect(
      classifyAgent("claude", "Run a dynamic workflow?\nEsc to cancel"),
    ).toMatchObject({
      state: "blocked",
      rule: "dynamic_workflow_prompt",
    });
    expect(
      classifyAgent(
        "claude",
        `${composer}\nRun a dynamic workflow?\nEsc to cancel`,
      ).state,
    ).toBe("blocked");
    expect(
      classifyAgent(
        "claude",
        'MCP server "example" requests your input\nAccept\nEsc to cancel',
      ).state,
    ).toBe("blocked");
  });
  test("Codex quoted trust dialogs cannot establish a blocker above its ready composer", () => {
    const dialogs = [
      "> You are in /tmp/project\nDo you trust the contents of this directory?",
      "Folder access\nTrust this folder?\nCodex can read, edit, and run files here\nTrust and continue",
      "Folder access\nTrust this folder?\nCodex can read, edit, and run files here\nenter continue",
    ];
    for (const dialog of dialogs) {
      for (const composer of [
        "› prompt\n? for shortcuts",
        "› drafted request\n\n  GPT-6.1-Sol · weekly 80% left",
      ]) {
        const screen = `${dialog}\n\n${composer}`;
        const classified = classifyAgent("codex", screen);
        expect(classified.state).toBe("idle");
        expect(classifyAgent("codex", screen, "Action Required").state).toBe(
          "idle",
        );
        const observation = reconcileAgent(
          undefined,
          "codex",
          "job",
          classified,
          0,
        );
        expect(observation.freshness).toBe("fresh");
        expect(agentSummary([observation])).toBe("1 idle");
      }
      expect(classifyAgent("codex", dialog)).toMatchObject({
        state: "blocked",
        rule: "trust_directory",
      });
    }
    expect(
      classifyAgent("codex", `› previous request\n${dialogs[1]}`).state,
    ).toBe("blocked");
  });
  test("transcript and menu views explicitly skip updates", () => {
    expect(
      classifyAgent("claude", "showing detailed transcript\nctrl+o to toggle")
        .skip,
    ).toBe(true);
    expect(
      classifyAgent(
        "codex",
        "› prompt\n↑/↓ to scroll · pgup/pgdn to scroll · home/end to jump · q to quit · esc to edit prev",
      ).skip,
    ).toBe(true);
    expect(
      classifyAgent(
        "claude",
        "Select model\nEnter to set as default\nEsc to cancel",
      ).skip,
    ).toBe(true);
  });
});

describe("observation freshness", () => {
  const working = classifyAgent("codex", "", "⠋ busy");
  const idle = classifyAgent("codex", "› prompt\n? for shortcuts");
  test("confirms working-to-idle twice and publishes strong blockers immediately", () => {
    const prior = reconcileAgent(undefined, "codex", "g1", working, 0);
    const pending = reconcileAgent(prior, "codex", "g1", idle, 1000);
    expect(pending.state).toBe("working");
    expect(pending.pendingIdle).toBe(true);
    expect(reconcileAgent(pending, "codex", "g1", idle, 2000).state).toBe(
      "idle",
    );
    expect(
      reconcileAgent(
        prior,
        "codex",
        "g1",
        { state: "blocked", rule: "approval", source: "screen", strong: true },
        1000,
      ).state,
    ).toBe("blocked");
  });
  test("skip/error retention expires without renewing the last valid time", () => {
    const prior = reconcileAgent(undefined, "codex", "g1", working, 0);
    const stale = reconcileAgent(prior, "codex", "g1", undefined, 1000);
    expect(stale.freshness).toBe("stale");
    expect(stale.lastValid?.at).toBe(0);
    const expired = reconcileAgent(stale, "codex", "g1", undefined, 5000);
    expect(expired.state).toBe("unknown");
    expect(expired.freshness).toBe("unavailable");
    expect(expired.lastValid?.classification.state).toBe("working");
    expect(agentPaneLabel(expired)).toContain("unknown (unavailable)");
  });
  test("a new process generation never inherits state", () => {
    const prior = reconcileAgent(undefined, "codex", "old", working, 0);
    expect(
      reconcileAgent(prior, "codex", "new", undefined, 1000).lastValid,
    ).toBeUndefined();
    expect(sameAgentPresentation(prior, { ...prior, observedAt: 50 })).toBe(
      true,
    );
  });
  test("summaries keep simultaneous states and mark stale counts", () => {
    const a = reconcileAgent(undefined, "codex", "a", working, 0);
    const b = reconcileAgent(
      undefined,
      "claude",
      "b",
      { state: "blocked", rule: "approval", source: "screen" },
      0,
    );
    expect(agentSummary([a, b])).toBe("1 blocked · 1 working");
    expect(
      agentSummary([reconcileAgent(a, "codex", "a", undefined, 1000)]),
    ).toBe("1 working (stale)");
  });
});
