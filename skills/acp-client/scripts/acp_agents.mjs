export const AGENT_PRESETS = {
  opencode: {
    command: "opencode", args: ["acp"], authHint: "opencode auth login",
    platform: "opencode", label: "OpenCode · ACP nativo",
  },
  codex: {
    command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"],
    authHint: "codex login (ou CODEX_PATH=/path/to/codex para usar seu binário)",
    platform: "codex", label: "Codex · adaptador oficial",
  },
  claude: {
    command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    authHint: "npx -y @agentclientprotocol/claude-agent-acp --cli auth login",
    platform: "claude", label: "Claude Code · adaptador ACP",
  },
};

export function depsExcludedFor(agent) {
  return [
    ...(agent === "opencode" ? [] : ["opencode"]),
    ...(agent === "claude" ? [] : ["claude-agent-acp"]),
  ];
}

export function authRequired(error) {
  return [-32000, -32003].includes(error.acpError?.code)
    || /\bauth(?:entication|_required)?\b|not logged in|please (?:run \/login|log in)/i.test(error.message);
}
