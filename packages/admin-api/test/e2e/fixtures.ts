import { test as base, expect } from '@playwright/test';

export const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? 'e2e-token-fixed';
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3015';

export const test = base;
export { expect };
