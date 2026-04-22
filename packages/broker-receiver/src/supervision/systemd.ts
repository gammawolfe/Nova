// packages/broker-receiver/src/supervision/systemd.ts
//
// Emit a systemd user-scope service unit. Operator redirects stdout
// into ~/.config/systemd/user/broker-receiver@.service, runs
// `systemctl --user daemon-reload`, then enables + starts with
// `systemctl --user enable --now broker-receiver@<agentId>.service`.
//
// Templated on the agentId (`%i`) so multiple receivers on the same
// host share a single unit file.

export interface SystemdOptions {
  agentId: string;
  nodePath: string;
  entryPath: string;
  novaUrl: string;
  extraEnv?: Record<string, string>;
}

export function generateSystemdUnit(opts: SystemdOptions): string {
  const envLines = [
    `Environment=NOVA_AGENT_ID=%i`,
    `Environment=NOVA_URL=${opts.novaUrl}`,
    ...Object.entries(opts.extraEnv ?? {}).map(([k, v]) => `Environment=${k}=${v}`),
  ].join('\n');

  return `[Unit]
Description=Nova broker-receiver daemon (%i)
Documentation=https://github.com/gammawolfe/Nova
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${opts.nodePath} ${opts.entryPath} run
Restart=on-failure
RestartSec=10s
${envLines}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}
