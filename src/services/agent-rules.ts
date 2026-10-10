// Adapted from Herdr, Apache-2.0, commit 2563803dca97c040beaf3dc3acdcb5a3221b4238.
// Claude rules 2026.09.11.1; Codex rules 2026.10.01.1.
// Adaptations: conservative idle/weak-blocker exclusions, JS regex translation
// in agent-model.ts, composer exclusion, corroborated activity, live-screen-only
// regions. See THIRD_PARTY_NOTICES.md.
export interface AgentGate {
  contains?: readonly string[];
  regex?: readonly string[];
  line_regex?: readonly string[];
  all?: readonly AgentGate[];
  any?: readonly AgentGate[];
  not?: readonly AgentGate[];
}
export interface AgentRule extends AgentGate {
  id: string;
  state: "idle" | "working" | "blocked" | "unknown";
  priority: number;
  region: string;
  skip_state_update?: boolean;
  visible_idle?: boolean;
  visible_blocker?: boolean;
  visible_working?: boolean;
}
export const agentRules: Record<"claude" | "codex", readonly AgentRule[]> = {
  claude: [
    {
      id: "osc_title_working",
      state: "working",
      priority: 1100,
      region: "osc_title",
      visible_working: true,
      regex: ["^[\\x{2800}-\\x{28FF}\\x{25D0}-\\x{25D3}] "],
    },
    {
      id: "live_turn_working",
      state: "working",
      priority: 970,
      region: "bottom_non_empty_lines(12)",
      visible_working: true,
      any: [
        {
          line_regex: ["^\\s*[⏸⏵].*esc to interrupt(?:\\s|·|$)"],
        },
        {
          line_regex: [
            "^\\s*[\\x{002A}\\x{00B7}\\x{2722}\\x{2733}\\x{2736}\\x{273B}\\x{273D}]\\s+\\S.*…(?:\\s+\\(\\d+[smh](?:\\s|·)|\\s*$)",
          ],
        },
      ],
    },
    {
      id: "background_agents_working",
      state: "working",
      priority: 965,
      region: "last_non_empty_above_prompt_box",
      visible_working: true,
      line_regex: [
        "^\\s*[\\x{002A}\\x{00B7}\\x{2722}\\x{2736}\\x{273B}\\x{273D}]\\s+Waiting for [1-9]\\d* background agents? to finish\\s*$",
      ],
    },
    {
      id: "background_mcp_task_working",
      state: "working",
      priority: 965,
      region: "bottom_non_empty_lines(12)",
      visible_working: true,
      regex: [
        "(?m)^[\\x{002A}\\x{00B7}\\x{2722}\\x{2736}\\x{273B}\\x{273D}][ \\t]+\\S[^\\n]*?(?:\\n[ \\t]+[^\\n]*?){0,3}·(?:[ \\t]+|\\n[ \\t]*)[1-9]\\d*(?:[ \\t]+|\\n[ \\t]*)MCP(?:[ \\t]+|\\n[ \\t]*)tasks?(?:[ \\t]+|\\n[ \\t]*)still(?:[ \\t]+|\\n[ \\t]*)running[ \\t]*$",
      ],
      not: [
        {
          contains: ["do you want to proceed?"],
        },
        {
          contains: ["esc to cancel"],
        },
        {
          contains: ["waiting for permission"],
        },
        {
          contains: ["do you want to allow this connection?"],
        },
        {
          contains: ["tab to amend"],
        },
        {
          contains: ["ctrl+e to explain"],
        },
      ],
    },
    {
      id: "btw_overlay_working",
      state: "working",
      priority: 975,
      region: "bottom_non_empty_lines(5)",
      visible_working: true,
      line_regex: ["^\\s*/btw(?:\\s|$)", "(?i)esc to close\\s*$"],
    },
    {
      id: "transcript_viewer",
      state: "unknown",
      priority: 1000,
      region: "bottom_non_empty_lines(3)",
      skip_state_update: true,
      contains: ["showing detailed transcript"],
      any: [
        {
          contains: ["ctrl+o", "to toggle"],
        },
        {
          contains: ["ctrl+e", "show all"],
        },
        {
          contains: ["ctrl+e", "collapse"],
        },
        {
          contains: ["↑↓ scroll"],
        },
        {
          contains: ["? for shortcuts"],
        },
      ],
    },
    {
      id: "live_blocked_form",
      state: "blocked",
      priority: 980,
      region: "after_last_horizontal_rule",
      visible_blocker: true,
      contains: ["esc to cancel"],
      any: [
        {
          contains: ["enter to confirm"],
        },
        {
          contains: ["enter to select"],
          any: [
            {
              contains: ["tab/arrow keys to navigate"],
            },
            {
              contains: ["arrow keys to navigate"],
            },
            {
              contains: ["arrows to navigate"],
            },
            {
              contains: ["↑/↓ to navigate"],
            },
            {
              contains: ["↑↓ to navigate"],
            },
          ],
        },
      ],
    },
    {
      id: "dynamic_workflow_prompt",
      state: "blocked",
      priority: 980,
      region: "whole_recent",
      visible_blocker: true,
      contains: ["run a dynamic workflow?", "esc to cancel"],
    },
    {
      id: "mcp_elicitation_prompt",
      state: "blocked",
      priority: 980,
      region: "whole_recent",
      visible_blocker: true,
      contains: ["esc to cancel"],
      line_regex: [
        '(?i)^\\s*MCP server ["\\x{201C}].+["\\x{201D}] requests your input\\s*$',
      ],
      all: [
        {
          any: [
            {
              line_regex: ["^\\s*\\x{276F}?\\s*Accept\\b"],
            },
            {
              line_regex: ["^\\s*\\x{276F}?\\s*Decline\\b"],
            },
          ],
        },
      ],
    },
    {
      id: "live_prompt_box",
      state: "idle",
      priority: 950,
      region: "prompt_box_body",
      visible_idle: true,
      line_regex: ["^\\s*❯"],
      not: [
        {
          contains: ["enter to select"],
        },
        {
          contains: ["esc to cancel"],
        },
        {
          contains: ["tab/arrow keys"],
        },
        {
          contains: ["arrow keys to navigate"],
        },
        {
          contains: ["↑/↓ to navigate"],
        },
      ],
    },
    {
      id: "model_picker_menu",
      state: "unknown",
      priority: 900,
      region: "whole_recent",
      skip_state_update: true,
      contains: ["select model", "enter to set as default", "esc to cancel"],
      not: [
        {
          contains: ["do you want to proceed?"],
        },
        {
          contains: ["enter to select"],
        },
      ],
    },
    {
      id: "bash_permission_prompt",
      state: "blocked",
      priority: 850,
      region: "whole_recent",
      visible_blocker: true,
      contains: ["do you want to proceed?"],
      any: [
        {
          contains: ["bash command"],
        },
        {
          contains: ["bash("],
        },
        {
          contains: ["contains expansion"],
        },
        {
          contains: ["tab to amend"],
        },
        {
          contains: ["ctrl+e to explain"],
        },
      ],
      all: [
        {
          any: [
            {
              line_regex: ["(?i)^\\s*❯?\\s*yes\\b"],
            },
            {
              line_regex: ["(?i)^\\s*❯?\\s*1\\.\\s*yes\\b"],
            },
            {
              line_regex: ["(?i)^\\s*❯?\\s*2\\.\\s*yes\\b"],
            },
            {
              line_regex: ["(?i)^\\s*❯?\\s*2\\.\\s*no\\b"],
            },
            {
              line_regex: ["(?i)^\\s*❯?\\s*3\\.\\s*no\\b"],
            },
          ],
        },
      ],
    },
    {
      id: "generic_permission_prompt",
      state: "blocked",
      priority: 840,
      region: "after_last_horizontal_rule",
      visible_blocker: true,
      contains: ["do you want to proceed?", "esc to cancel"],
      all: [
        {
          any: [
            {
              line_regex: ["(?i)^\\s*❯?\\s*1\\.\\s*yes\\b"],
            },
            {
              line_regex: ["(?i)^\\s*2\\.\\s*yes\\b"],
            },
            {
              line_regex: ["(?i)^\\s*2\\.\\s*no\\b"],
            },
            {
              line_regex: ["(?i)^\\s*3\\.\\s*no\\b"],
            },
          ],
        },
      ],
    },
  ],
  codex: [
    {
      id: "osc_title_blocked",
      state: "blocked",
      priority: 1100,
      region: "osc_title",
      visible_blocker: true,
      contains: ["Action Required"],
    },
    {
      id: "osc_title_working",
      state: "working",
      priority: 1050,
      region: "osc_title",
      visible_working: true,
      regex: ["(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)"],
    },
    {
      id: "transcript_viewer",
      state: "unknown",
      priority: 1000,
      region: "after_last_prompt_marker",
      skip_state_update: true,
      contains: [
        "↑/↓ to scroll",
        "pgup/pgdn to",
        "home/end to jump",
        "q to quit",
      ],
      any: [
        {
          contains: ["esc to edit prev"],
        },
        {
          contains: ["esc/← to edit prev"],
        },
      ],
    },
    {
      id: "trust_directory",
      state: "blocked",
      priority: 950,
      region: "top_non_empty_lines(20)",
      visible_blocker: true,
      all: [
        {
          any: [
            {
              regex: ["\\A> You are in [^\\r\\n]+(?:\\r?\\n|$)"],
            },
            {
              contains: ["Folder access"],
            },
          ],
        },
        {
          any: [
            {
              regex: [
                "(?s)Do\\s+you\\s+trust\\s+the\\s+contents\\s+of\\s+this\\s+directory\\?",
              ],
            },
            {
              all: [
                {
                  contains: [
                    "Trust this folder?",
                    "Codex can read, edit, and run files here",
                  ],
                },
                {
                  any: [
                    {
                      contains: ["Trust and continue"],
                    },
                    {
                      contains: ["enter continue"],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "startup_update",
      state: "blocked",
      priority: 950,
      region: "bottom_non_empty_lines(20)",
      visible_blocker: true,
      contains: ["Update available!", "Update now"],
      regex: [
        "Skip\\s+until\\s+next\\s+version",
        "Press enter to continue\\s*\\z",
      ],
    },
    {
      id: "live_strong_blocker",
      state: "blocked",
      priority: 900,
      region: "after_last_prompt_marker",
      visible_blocker: true,
      any: [
        {
          contains: ["press enter to confirm or esc to cancel"],
        },
        {
          contains: ["enter to submit answer"],
        },
        {
          contains: ["enter to submit all"],
        },
        {
          contains: ["allow command?", "esc to cancel"],
        },
        {
          contains: ["All Results", "Filesystem Only", "Plugins"],
        },
      ],
    },
    {
      id: "screen_working_fallback",
      state: "working",
      priority: 500,
      region: "before_current_prompt_marker",
      visible_working: true,
      contains: [" to interrupt)"],
      regex: [
        "(?m)^(?:[•◦][ \\t]+)?[^\\s›•◦■✗✓─][^\\r\\n]* \\((?:[0-9]+[hm] )*[0-9]+s • [^\\r\\n]+? to interrupt\\)(?: · [^\\r\\n]*)?(?:\\r?\\n(?:[^•◦›■✗✓─\\r\\n][^\\r\\n]*|•[ \\t]+(?:Queued\\s+follow-up\\s+inputs|Messages\\s+to\\s+be\\s+submitted\\s+after\\s+next\\s+tool\\s+call(?:\\s+\\(press\\s+[^\\r\\n]+?\\s+to\\s+interrupt\\s+and\\s+send\\s+immediately\\))?|Messages\\s+to\\s+be\\s+submitted\\s+at\\s+end\\s+of\\s+turn)|›[⠁⠂⠄⠈⠐⠠⡀⢀][^\\r\\n]*)?)*\\s*\\z",
      ],
      not: [
        {
          line_regex: [
            "^(?:[•◦][ \\t]+)?Reconnect failed — check the endpoint, then relaunch \\([0-9hms ]+\\)$",
          ],
        },
      ],
    },
  ],
};
