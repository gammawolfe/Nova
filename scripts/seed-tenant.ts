import fs from 'fs';
import path from 'path';

function main() {
  const tenantId = 'tenant_seed_123';
  const agentId = 'agent_aria';

  // Construct Data Paths based off local conventions
  const dataRoot = path.join(process.cwd(), 'data');
  const agentRoot = path.join(dataRoot, 'tenants', tenantId, 'agents', agentId);
  const trustRegistryDir = path.join(agentRoot, 'trust-registry');

  console.log(`Seeding Dev Tenant context at: ${agentRoot}`);

  fs.mkdirSync(trustRegistryDir, { recursive: true });

  // Agent configuration with operator URL and full skill definitions
  const mockAgentConfig = {
    name: 'Aria Data Helper',
    description: 'Internal analytical agent for parsing data.',
    version: '1.0.0',
    operatorUrl: process.env.OPERATOR_URL || 'http://localhost:4000/process',
    skills: [
      {
        id: 'query_knowledge',
        name: 'Query Knowledge',
        description: 'Query the internal knowledge base for answers',
        tags: ['knowledge', 'search'],
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } } }
      },
      {
        id: 'request_summary',
        name: 'Request Summary',
        description: 'Generate a summary from provided data',
        tags: ['summary', 'analysis'],
        inputSchema: { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] },
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } } }
      }
    ]
  };

  fs.writeFileSync(
    path.join(agentRoot, 'agent-config.json'),
    JSON.stringify(mockAgentConfig, null, 2)
  );

  // Provide a trusted DID (in a real test we'll pass our own generated key against this logic constraint)
  // We'll trust our OWN root DID for dev local bounding
  const myDidPath = path.join(dataRoot, 'keys', 'nova.did');
  let allowedDid = 'did:example:stub';
  
  if (fs.existsSync(myDidPath)) {
    allowedDid = fs.readFileSync(myDidPath, 'utf8').trim();
  }

  const mockTrustRecord = {
    did: allowedDid,
    displayName: 'Local Dev Root Identity',
    tier: 2, // Tier 2 means read+write abilities 
    allowedSkills: ['query_knowledge', 'request_summary'],
    addedAt: new Date().toISOString(),
    addedBy: 'AdminSeed'
  };

  // Nomenclatures inside Trust Registry directory bind strictly to DID names natively
  fs.writeFileSync(
    path.join(trustRegistryDir, `${allowedDid.replace(/:/g, '_')}.json`),
    JSON.stringify(mockTrustRecord, null, 2)
  );

  console.log(`✅ Tenant Seeded Successfully.`);
  console.log(`Agent 'agent_aria' is operational and trusting ${allowedDid} at Tier 2.`);
}

main();
