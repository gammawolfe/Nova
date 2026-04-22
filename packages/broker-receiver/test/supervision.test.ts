import { describe, it, expect } from 'vitest';
import { generateLaunchdPlist } from '../src/supervision/launchd';
import { generateSystemdUnit } from '../src/supervision/systemd';

describe('generateLaunchdPlist', () => {
  it('includes the label, program args, env, and log paths', () => {
    const plist = generateLaunchdPlist({
      agentId: 'my-recv',
      nodePath: '/usr/local/bin/node',
      entryPath: '/opt/nova/broker-receiver/dist/cli.js',
      novaUrl: 'http://localhost:3001',
      homeDir: '/Users/dev',
    });
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.nova.broker-receiver.my-recv</string>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/opt/nova/broker-receiver/dist/cli.js</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('NOVA_AGENT_ID');
    expect(plist).toContain('<string>my-recv</string>');
    expect(plist).toContain('<string>/Users/dev/.nova/logs/broker-receiver.my-recv.out.log</string>');
    expect(plist).toContain('<string>/Users/dev/.nova/logs/broker-receiver.my-recv.err.log</string>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>10</integer>');
  });

  it('xml-escapes special characters in inputs', () => {
    const plist = generateLaunchdPlist({
      agentId: 'a',
      nodePath: '/bin/"node"',
      entryPath: '/<root>&/cli.js',
      novaUrl: 'http://localhost:3001',
      homeDir: '/home',
    });
    expect(plist).toContain('&quot;node&quot;');
    expect(plist).toContain('&lt;root&gt;&amp;');
  });

  it('merges extraEnv into EnvironmentVariables', () => {
    const plist = generateLaunchdPlist({
      agentId: 'a',
      nodePath: '/n',
      entryPath: '/c',
      novaUrl: 'http://x',
      homeDir: '/h',
      extraEnv: { ANTHROPIC_API_KEY: 'sk-foo' },
    });
    expect(plist).toContain('<key>ANTHROPIC_API_KEY</key>');
    expect(plist).toContain('<string>sk-foo</string>');
  });
});

describe('generateSystemdUnit', () => {
  it('produces a valid-looking systemd unit', () => {
    const unit = generateSystemdUnit({
      agentId: 'my-recv',
      nodePath: '/usr/bin/node',
      entryPath: '/opt/nova/cli.js',
      novaUrl: 'http://localhost:3001',
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/nova/cli.js run');
    expect(unit).toContain('Environment=NOVA_AGENT_ID=%i');
    expect(unit).toContain('Environment=NOVA_URL=http://localhost:3001');
    expect(unit).toContain('Restart=on-failure');
  });

  it('merges extraEnv', () => {
    const unit = generateSystemdUnit({
      agentId: 'a',
      nodePath: '/n',
      entryPath: '/c',
      novaUrl: 'http://x',
      extraEnv: { LOG_LEVEL: 'debug' },
    });
    expect(unit).toContain('Environment=LOG_LEVEL=debug');
  });
});
