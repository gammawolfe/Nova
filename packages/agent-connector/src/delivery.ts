import { logger } from '@nova/shared/src/logger';
import { QueuedTask, TaskResult } from '@nova/shared/src/types';
import { TaskResultSchema } from '@nova/shared/src/schemas';

export interface DeliveryResult {
  success: boolean;
  taskResult?: TaskResult;
  error?: string;
}

/**
 * POST the task payload to the operator endpoint and collect the result.
 * The operator is the actual agent/LLM backend that processes the task.
 */
export async function deliverToOperator(
  operatorUrl: string,
  task: QueuedTask
): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    logger.info({ taskId: task.taskId, operatorUrl }, 'Delivering task to operator');

    const response = await fetch(operatorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        success: false,
        error: `Operator returned HTTP ${response.status}: ${body}`,
      };
    }

    const body = await response.json();
    const parsed = TaskResultSchema.safeParse(body);

    if (!parsed.success) {
      logger.warn({ errors: parsed.error.issues, taskId: task.taskId },
        'Operator response did not match TaskResultSchema');
      return {
        success: false,
        error: `Invalid operator response: ${parsed.error.issues.map(i => i.message).join(', ')}`,
      };
    }

    return { success: true, taskResult: parsed.data };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { success: false, error: 'Operator delivery timed out (30s)' };
    }
    return { success: false, error: err.message || 'Unknown delivery error' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * POST the TaskResult to the caller's replyTo webhook.
 */
export async function deliverToReplyTo(
  replyToUrl: string,
  result: TaskResult
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    logger.info({ requestId: result.requestId, replyToUrl }, 'Delivering result to replyTo');

    const response = await fetch(replyToUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        statusCode: response.status,
        error: `replyTo returned HTTP ${response.status}`,
      };
    }

    return { success: true, statusCode: response.status };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { success: false, error: 'replyTo delivery timed out (10s)' };
    }
    return { success: false, error: err.message || 'Unknown replyTo delivery error' };
  } finally {
    clearTimeout(timeout);
  }
}
