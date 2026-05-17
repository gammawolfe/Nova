// packages/broker-receiver/src/handlers/codex-smoke.ts
//
// Deterministic Codex-shaped handler for local Nova smoke tests. It proves
// unattended claim -> dispatch -> respond for the same skill IDs Codex
// advertises, without pretending to run the interactive Codex model.

import type { Handler, HandlerFactory, HandlerResult } from './types.js';
import type { QueuedTask } from '@nova/shared/src/types';

export const codexSmokeHandlerFactory: HandlerFactory = () => {
  const handler: Handler = {
    name: 'codex-smoke',
    async handle(task: QueuedTask): Promise<HandlerResult> {
      switch (task.intent) {
        case 'answer_code_question':
          return answerCodeQuestion(task);
        case 'review_code':
          return reviewCode(task);
        default:
          return {
            status: 'error',
            error: {
              code: 'UNSUPPORTED_INTENT',
              message: `codex-smoke does not handle intent '${task.intent}'`,
              retryable: false,
            },
          };
      }
    },
  };
  return handler;
};

function answerCodeQuestion(task: QueuedTask): HandlerResult {
  const question = typeof task.params?.question === 'string' ? task.params.question : '';
  if (!question.trim()) {
    return {
      status: 'error',
      error: {
        code: 'INVALID_PARAMS',
        message: 'answer_code_question requires params.question',
        retryable: false,
      },
    };
  }

  const answer = /(?:^|\D)2\s*\+\s*2(?:\D|$)/.test(question)
    ? 'Received by codex-smoke via Nova broker inbox. 2+2 equals 4.'
    : [
        'Received by codex-smoke via Nova broker inbox.',
        'This handler is deterministic and intended for unattended receive/reply smoke tests; it does not run an interactive Codex model.',
      ].join(' ');

  return {
    status: 'ok',
    result: {
      answer,
    },
  };
}

function reviewCode(task: QueuedTask): HandlerResult {
  const filePath = typeof task.params?.filePath === 'string' ? task.params.filePath : '';
  if (!filePath.trim()) {
    return {
      status: 'error',
      error: {
        code: 'INVALID_PARAMS',
        message: 'review_code requires params.filePath',
        retryable: false,
      },
    };
  }

  return {
    status: 'ok',
    result: {
      findings: [],
      summary: [
        `codex-smoke received review_code for ${filePath}.`,
        'No findings are produced by the smoke handler; use a real AI-backed handler for substantive review.',
      ].join(' '),
    },
  };
}
