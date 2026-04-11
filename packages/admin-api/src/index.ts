import express from 'express';
import { logger } from '@nova/shared/src/logger';
import { adminAuth } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import { tenantsRouter } from './routes/tenants';
import { agentsRouter } from './routes/agents';
import { trustRouter } from './routes/trust';
import { ucanRouter } from './routes/ucan';
import { quarantineRouter } from './routes/quarantine';
import { deadLetterRouter } from './routes/dead-letter';
import { confirmationRouter } from './routes/confirmation';
import { auditRouter } from './routes/audit';
import { systemRouter } from './routes/system';

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json());

// Auth on all /admin routes
app.use('/admin', adminAuth);

// Mount routes per spec Section 5.5
app.use('/admin/tenants', tenantsRouter);
app.use('/admin/tenants/:tenantId/agents', agentsRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/trust', trustRouter);
app.use('/admin/tenants/:tenantId/ucans', ucanRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/quarantine', quarantineRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/dead-letter', deadLetterRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/confirm-queue', confirmationRouter);
app.use('/admin/tenants/:tenantId/audit', auditRouter);
app.use('/admin', systemRouter);

// Error handler must be last
app.use(errorHandler);

const server = app.listen(Number(PORT), '127.0.0.1', () => {
  logger.info(`Admin API running on http://127.0.0.1:${PORT}`);
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Admin API shutting down');
  server.close(async () => {
    const { closeRedis } = await import('./services/agent-service');
    await closeRedis();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
