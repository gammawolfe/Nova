// packages/broker-receiver/src/handlers/codex-cli.ts
//
// Live Codex receiver handler. It invokes `codex exec` for each broker task
// and returns the final model message through Nova. This is intentionally
// separate from codex-smoke, which is only a deterministic transport test.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Handler, HandlerFactory, HandlerResult } from './types.js';
import type { QueuedTask } from '@nova/shared/src/types';

const CodexCliConfigSchema = z.object({
  command: z.string().min(1).default('codex'),
  model: z.string().optional(),
  profile: z.string().optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('read-only'),
  mode: z.enum(['approval-required', 'receiver-policy', 'trusted-local']).default('approval-required'),
  allowedSenderAgents: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().min(10_000).max(20 * 60_000).default(5 * 60_000),
  maxOutputBytes: z.number().int().min(1024).max(2_000_000).default(200_000),
});

export const codexCliHandlerFactory: HandlerFactory = async (raw) => {
  const cfg = CodexCliConfigSchema.parse(raw);

  const handler: Handler = {
    name: 'codex-cli',
    async handle(task: QueuedTask, ctx): Promise<HandlerResult> {
      const policyResult = evaluatePolicy(cfg, task);
      if (policyResult) return policyResult;

      const promptResult = buildPrompt(task);
      if (promptResult.status === 'error') return promptResult;

      const cwd = resolveWorkingDirectory(task);
      try {
        const answer = await runCodexExec({
          cfg,
          cwd,
          prompt: promptResult.prompt,
          signal: ctx.signal,
        });

        if (task.intent === 'review_code') {
          return reviewResult(answer);
        }
        return {
          status: 'ok',
          result: { answer },
        };
      } catch (err: any) {
        ctx.logger.warn({ err: err.message, taskId: task.taskId }, 'codex-cli handler failed');
        return {
          status: 'error',
          error: {
            code: 'CODEX_CLI_ERROR',
            message: err.message ?? 'codex exec failed',
            retryable: false,
          },
        };
      }
    },
  };
  return handler;
};

function evaluatePolicy(
  cfg: z.infer<typeof CodexCliConfigSchema>,
  task: QueuedTask,
): HandlerResult | null {
  if (cfg.mode === 'approval-required') {
    return {
      status: 'error',
      error: {
        code: 'LLM_REQUIRES_APPROVAL',
        message: 'codex-cli is approval-required by default. Set handlerConfig.mode="receiver-policy" with a deny-by-default receiver policy, or "trusted-local" only for controlled local testing.',
        retryable: false,
      },
    };
  }

  if (cfg.allowedSenderAgents?.length) {
    const sender = task.senderAgentId ?? '';
    if (!cfg.allowedSenderAgents.includes(sender)) {
      return {
        status: 'error',
        error: {
          code: 'LLM_SENDER_DENIED',
          message: `Sender '${sender || 'unknown'}' is not allowed to invoke codex-cli.`,
          retryable: false,
        },
      };
    }
  }

  return null;
}

type PromptResult =
  | { status: 'ok'; prompt: string }
  | { status: 'error'; error: { code: string; message: string; retryable: false } };

function buildPrompt(task: QueuedTask): PromptResult {
  if (task.intent === 'answer_code_question') {
    const question = typeof task.params?.question === 'string' ? task.params.question.trim() : '';
    if (!question) {
      return invalidParams('answer_code_question requires params.question');
    }
    const repoPath = typeof task.params?.repoPath === 'string' ? task.params.repoPath : undefined;
    return {
      status: 'ok',
      prompt: [
        'You are Codex receiving a Nova broker task from another agent.',
        'Answer the question directly and concisely. Do not edit files.',
        repoPath ? `Repository path for context: ${repoPath}` : undefined,
        '',
        `Question: ${question}`,
      ].filter(Boolean).join('\n'),
    };
  }

  if (task.intent === 'review_code') {
    const filePath = typeof task.params?.filePath === 'string' ? task.params.filePath.trim() : '';
    if (!filePath) {
      return invalidParams('review_code requires params.filePath');
    }
    const concern = typeof task.params?.concern === 'string' ? task.params.concern.trim() : '';
    return {
      status: 'ok',
      prompt: [
        'You are Codex receiving a Nova broker code-review task from another agent.',
        'Review the requested file. Do not edit files.',
        'Return concise findings first, then a short summary.',
        '',
        `File: ${filePath}`,
        concern ? `Focus: ${concern}` : undefined,
      ].filter(Boolean).join('\n'),
    };
  }

  return {
    status: 'error',
    error: {
      code: 'UNSUPPORTED_INTENT',
      message: `codex-cli does not handle intent '${task.intent}'`,
      retryable: false,
    },
  };
}

function invalidParams(message: string): PromptResult {
  return {
    status: 'error',
    error: {
      code: 'INVALID_PARAMS',
      message,
      retryable: false,
    },
  };
}

function resolveWorkingDirectory(task: QueuedTask): string {
  if (typeof task.params?.repoPath === 'string' && path.isAbsolute(task.params.repoPath)) {
    return task.params.repoPath;
  }
  if (typeof task.params?.filePath === 'string' && path.isAbsolute(task.params.filePath)) {
    return path.dirname(task.params.filePath);
  }
  return process.cwd();
}

function reviewResult(text: string): HandlerResult {
  return {
    status: 'ok',
    result: {
      findings: [],
      summary: text,
    },
  };
}

async function runCodexExec(opts: {
  cfg: z.infer<typeof CodexCliConfigSchema>;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-codex-cli-'));
  const outputPath = path.join(tmpDir, 'last-message.txt');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.cfg.timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const args = [
      'exec',
      '--sandbox',
      opts.cfg.sandbox,
      '--cd',
      opts.cwd,
      '--output-last-message',
      outputPath,
      '--color',
      'never',
    ];
    if (opts.cfg.model) args.push('--model', opts.cfg.model);
    if (opts.cfg.profile) args.push('--profile', opts.cfg.profile);
    args.push('-');

    const { stderr } = await spawnCodex(opts.cfg.command, args, opts.prompt, {
      cwd: opts.cwd,
      signal: controller.signal,
      maxOutputBytes: opts.cfg.maxOutputBytes,
    });

    let final = '';
    try {
      final = (await fsp.readFile(outputPath, 'utf8')).trim();
    } catch {
      // Some older Codex builds may fail before writing the last-message file.
    }
    if (!final) {
      throw new Error(stderr.trim() || 'codex exec produced no final message');
    }
    return final;
  } finally {
    clearTimeout(timeout);
    opts.signal.removeEventListener('abort', onAbort);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

function spawnCodex(
  command: string,
  args: string[],
  input: string,
  opts: { cwd: string; signal: AbortSignal; maxOutputBytes: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') <= opts.maxOutputBytes) return next;
      return next.slice(-opts.maxOutputBytes);
    };

    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk);
    });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`codex exec exited with code ${code ?? 'null'} signal ${signal ?? 'null'}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    child.stdin.end(input);
  });
}
