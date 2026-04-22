// packages/broker-receiver/src/supervision/launchd.ts
//
// Emit a launchd plist that runs `broker-receiver run` under user-scope
// supervision. Operator redirects stdout from `broker-receiver install`
// into ~/Library/LaunchAgents/com.nova.broker-receiver.<id>.plist and
// loads with `launchctl load`.
//
// Design notes (operational):
//   • KeepAlive.SuccessfulExit=false: launchd restarts on non-zero
//     exits but leaves a deliberate exit(0) alone. Lets `broker-receiver
//     uninstall` stop the service cleanly without a restart loop.
//   • KeepAlive.Crashed=true: restart on SIGSEGV / uncaught exception.
//   • ThrottleInterval=10: cap restart rate so a tight crash loop
//     doesn't hammer CPU.
//   • Logs under ~/.nova/logs/ (0700 parent). Log rotation is an
//     operator concern; JSON per line keeps them parseable regardless.

export interface LaunchdOptions {
  agentId: string;
  nodePath: string;
  entryPath: string;
  novaUrl: string;
  homeDir: string;
  extraEnv?: Record<string, string>;
}

export function generateLaunchdPlist(opts: LaunchdOptions): string {
  const label = `com.nova.broker-receiver.${opts.agentId}`;
  const outLog = `${opts.homeDir}/.nova/logs/broker-receiver.${opts.agentId}.out.log`;
  const errLog = `${opts.homeDir}/.nova/logs/broker-receiver.${opts.agentId}.err.log`;

  const envDict = {
    NOVA_AGENT_ID: opts.agentId,
    NOVA_URL: opts.novaUrl,
    ...(opts.extraEnv ?? {}),
  };
  const envEntries = Object.entries(envDict)
    .map(([k, v]) => `        <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(opts.nodePath)}</string>
        <string>${escapeXml(opts.entryPath)}</string>
        <string>run</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
        <key>Crashed</key><true/>
    </dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(outLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(errLog)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
