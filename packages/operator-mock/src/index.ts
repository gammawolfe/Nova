/**
 * Mock Operator Agent — responds to task delivery from agent-connector.
 *
 * Simulates a simple agent that processes tasks and returns results.
 * In production this would be the real agent brain (LLM, knowledge base, etc.)
 *
 * Receives: POST /process with a QueuedTask body
 * Returns:  TaskResult matching TaskResultSchema
 */

import express from 'express';
import crypto from 'crypto';
import { logger } from '@nova/shared/src/logger';

const app = express();
const PORT = parseInt(process.env.OPERATOR_PORT || '4000', 10);

app.use(express.json());

app.post('/process', async (req, res) => {
  const task = req.body;
  logger.info({ taskId: task.taskId, intent: task.intent }, 'Processing task');

  // Generate a simple result based on intent
  const result = buildMockResult(task.taskId, task.intent, task.params);

  // Simulate some latency
  await sleep(200 + Math.random() * 300);

  res.json(result);
});

function buildMockResult(taskId: string, intent: string, params: any) {
  const now = new Date().toISOString();

  let response: string;
  switch (intent) {
    case 'query_knowledge':
      response = `Answer: ${JSON.stringify(params || {}, null, 2)}`;
      break;
    case 'request_summary':
      response = `Summary: Task ${taskId} processed successfully`;
      break;
    default:
      response = `Processed intent '${intent}' with params: ${JSON.stringify(params || {}, null, 100)}`;
  }

  return {
    type: 'TaskResult' as const,
    requestId: taskId,
    status: 'ok' as const,
    result: { text: response },
    auditToken: crypto.randomUUID(),
    completedAt: now,
    schemaVersion: '1.0' as const,
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Mock Operator listening on http://0.0.0.0:${PORT}/process`);
});
