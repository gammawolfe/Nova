import fs from 'fs';
import path from 'path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AgentCardSchema } from '@nova/shared/src/schemas';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@nova/shared/src/schemas';

interface AgentConfig {
  agentId: string;
  tenantId: string;
  name: string;
  description?: string;
  version?: string;
  capabilities?: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  authentication?: { schemes: string[]; ucapabilityPrefix: string };
  skills: Array<{
    id: string; name: string; description: string;
    tags?: string[]; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>;
  }>;
}

/**
 * Build a complete A2A agent card from an agent config.
 * Reusable by both this CLI script and the a2a-server runtime.
 */
export function buildAgentCard(config: AgentConfig, baseUrl: string) {
  return {
    name: config.name,
    description: config.description ?? '',
    url: `${baseUrl}/agents/${config.agentId}`,
    version: config.version ?? '1.0.0',
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    provider: {
      name: config.tenantId,
    },
    capabilities: config.capabilities ?? {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: config.authentication ?? {
      schemes: ['ucan'],
      ucapabilityPrefix: `nova:${config.tenantId}:${config.agentId}`,
    },
    skills: config.skills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags ?? [],
      inputSchema: skill.inputSchema ?? {},
      outputSchema: skill.outputSchema ?? {},
    })),
  };
}

async function main() {
  const dataRoot = process.env.DATA_ROOT || path.join(process.cwd(), 'data');
  const tenantsDir = path.join(dataRoot, 'tenants');

  if (!fs.existsSync(tenantsDir)) {
    console.error('No tenants directory found');
    process.exit(1);
  }

  const baseUrl = process.env.NOVA_BASE_URL || 'http://localhost:3001';
  let generated = 0;

  for (const tenantId of fs.readdirSync(tenantsDir)) {
    const agentsDir = path.join(tenantsDir, tenantId, 'agents');
    if (!fs.existsSync(agentsDir)) continue;

    for (const agentId of fs.readdirSync(agentsDir)) {
      const configPath = path.join(agentsDir, agentId, 'agent-config.json');
      if (!fs.existsSync(configPath)) continue;

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AgentConfig;
      const card = buildAgentCard(config, baseUrl);

      // Validate against schema
      const parsed = AgentCardSchema.safeParse(card);
      if (!parsed.success) {
        console.error(`  FAIL: ${tenantId}/${agentId} — ${parsed.error.issues.map(i => i.message).join(', ')}`);
        continue;
      }

      // Write the card
      const cardPath = path.join(agentsDir, agentId, 'agent-card.json');
      fs.writeFileSync(cardPath, JSON.stringify(card, null, 2), 'utf8');
      console.log(`  OK: ${tenantId}/${agentId}`);
      generated++;
    }
  }

  console.log(`Generated ${generated} agent card(s)`);
}

main().catch(err => {
  console.error('Agent card generation failed:', err);
  process.exit(1);
});
