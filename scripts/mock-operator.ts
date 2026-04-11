import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

app.post('/process', (req, res) => {
  const task = req.body;
  console.log(`[MOCK OPERATOR] Received task: ${task.taskId}, intent: ${task.intent}`);

  // Simulate processing delay (500ms)
  setTimeout(() => {
    const result = {
      type: 'TaskResult' as const,
      requestId: task.taskId,
      status: 'ok' as const,
      result: {
        answer: `Mock response for intent "${task.intent}"`,
        processedAt: new Date().toISOString(),
      },
      auditToken: crypto.randomUUID(),
      completedAt: new Date().toISOString(),
      schemaVersion: '1.0' as const,
    };

    console.log(`[MOCK OPERATOR] Returning result for task: ${task.taskId}`);
    res.json(result);
  }, 500);
});

const PORT = process.env.OPERATOR_PORT || 4000;
app.listen(PORT, () => {
  console.log(`[MOCK OPERATOR] Listening on http://localhost:${PORT}`);
});
