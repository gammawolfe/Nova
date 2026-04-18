import { test, expect, ADMIN_TOKEN, BASE_URL } from './fixtures';

const TENANT = {
  id: 'tenant_test',
  slug: 'test-galaxy',
  name: 'Test Galaxy',
  status: 'active',
  plan: 'developer',
  did: 'did:key:z6MkTestGalaxy',
  quotas: { messagesPerDay: 1000, agentsMax: 5, trustedSendersMax: 50 },
  createdAt: '2026-04-01T00:00:00.000Z',
};

const AGENT_ALPHA = {
  agentId: 'alpha',
  tenantId: 'tenant_test',
  name: 'Alpha',
  description: 'First test agent',
  status: 'active',
  skills: [{ id: 'search', name: 'Search', description: 'Search things', tags: [] }],
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  did: 'did:key:z6MkTestAlpha',
};

const AGENT_BETA = {
  agentId: 'beta',
  tenantId: 'tenant_test',
  name: 'Beta',
  description: 'Second test agent',
  status: 'active',
  skills: [{ id: 'summarize', name: 'Summarize', description: 'Summarize text', tags: [] }],
  capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: false },
  did: 'did:key:z6MkTestBeta',
};

async function mockAdminEndpoints(page: any) {
  await page.route('**/admin/tenants', async (route: any) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([TENANT]) });
    } else {
      await route.continue();
    }
  });
  await page.route('**/admin/agents', async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: [AGENT_ALPHA, AGENT_BETA], total: 2 }),
    });
  });
}

async function login(page: any) {
  await mockAdminEndpoints(page);
  await page.goto(BASE_URL + '/');
  await page.fill('#admintok', ADMIN_TOKEN);
  await page.click('button.nova-cta');
  await expect(page.locator('.nova-sidebar')).toBeVisible();
}

test('shell: sidebar nav routes through all tabs with active highlight', async ({ page }) => {
  await login(page);

  // Start on Galaxies
  await expect(page.locator('.nova-nav-item.is-active')).toHaveText('Galaxies');

  // Click Agents
  await page.click('.nova-nav-item:has-text("Agents")');
  await expect(page).toHaveURL(/#\/agents$/);
  await expect(page.locator('.nova-nav-item.is-active')).toHaveText('Agents');

  // Click Live
  await page.click('.nova-nav-item:has-text("Live")');
  await expect(page).toHaveURL(/#\/live$/);
  await expect(page.locator('.nova-nav-item.is-active')).toHaveText('Live');

  // Click Audit
  await page.click('.nova-nav-item:has-text("Audit")');
  await expect(page).toHaveURL(/#\/audit$/);
  await expect(page.locator('.nova-nav-item.is-active')).toHaveText('Audit');
});

test('shell: sidebar collapse persists across reload', async ({ page }) => {
  await login(page);

  // Sidebar open initially
  await expect(page.locator('.nova-app')).not.toHaveClass(/is-sidebar-collapsed/);

  // Toggle collapses
  await page.click('.nova-sidebar-toggle');
  await expect(page.locator('.nova-app')).toHaveClass(/is-sidebar-collapsed/);

  // Reload — sessionStorage keeps the auth token, so the login form doesn't
  // re-appear. The collapsed state is stored in localStorage under
  // nova-admin-sidebar-collapsed and must survive the reload.
  await mockAdminEndpoints(page);
  await page.reload();
  await expect(page.locator('.nova-app')).toHaveClass(/is-sidebar-collapsed/);
});

test('Agents tab renders cards with DID and skill chips', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Agents")');

  await expect(page.locator('.nova-agent-card')).toHaveCount(2);
  await expect(page.locator('.nova-agent-card').first()).toContainText('Alpha');
  await expect(page.locator('.nova-agent-card').first()).toContainText('alpha');
  await expect(page.locator('.nova-agent-card').first()).toContainText('did:key:z6MkTestAlpha');
  await expect(page.locator('.nova-agent-card').first().locator('.nova-skill-chip')).toContainText('Search');
});

test('Live tab renders SVG planets — regression guard for template x-for bug', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await login(page);
  await page.click('.nova-nav-item:has-text("Live")');

  // The SVG itself must be present
  await expect(page.locator('svg.nova-live-svg')).toBeVisible();

  // Two planets must render as circles with the .nova-live-planet class.
  // If Alpine template-x-for inside SVG fails, this count is 0 (the Live-1 bug).
  await expect(page.locator('svg.nova-live-svg circle.nova-live-planet')).toHaveCount(2);

  // Per-agent gradients in defs (sun + 2 agents = 3 total)
  await expect(page.locator('svg.nova-live-svg defs radialGradient')).toHaveCount(3);

  // Labels render the agent names
  await expect(page.locator('svg.nova-live-svg text.nova-live-label')).toHaveCount(2);

  // No console errors from the SVG rendering path
  expect(consoleErrors.filter((e) => e.includes('importNode') || e.includes('Alpine Expression Error'))).toEqual([]);
});

test('Live tab: Simulate conversation adds a line', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Live")');
  await expect(page.locator('svg.nova-live-svg circle.nova-live-planet')).toHaveCount(2);

  await page.click('button:has-text("Simulate conversation")');
  await expect(page.locator('svg.nova-live-svg path.nova-live-line.is-queued')).toHaveCount(1);
});

test('Live tab: task SSE event renders a colored line per action', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Live")');
  await expect(page.locator('svg.nova-live-svg circle.nova-live-planet')).toHaveCount(2);

  // Directly invoke handleSseTask with a synthetic event — the SSE upstream is
  // already covered; this test targets the event-handler → DOM path.
  await page.evaluate(() => {
    const d = (window as any).Alpine.$data(document.querySelector('[x-data]')!);
    d.handleSseTask({
      data: JSON.stringify({
        action: 'completed',
        taskId: 't1',
        toTenantId: 'tenant_test',
        toAgentId: 'beta',
        fromTenantId: 'tenant_test',
        fromAgentId: 'alpha',
      }),
    });
  });

  await expect(page.locator('svg.nova-live-svg path.nova-live-line.is-completed')).toHaveCount(1);
});

test('Audit tab renders placeholder', async ({ page }) => {
  await login(page);
  await page.click('.nova-nav-item:has-text("Audit")');
  await expect(page.locator('.nova-placeholder')).toContainText('AUDIT');
  await expect(page.locator('.nova-placeholder')).toContainText('Coming soon');
});

test('no console errors during full tab tour', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  await login(page);
  for (const tab of ['Agents', 'Live', 'Audit', 'Galaxies']) {
    await page.click(`.nova-nav-item:has-text("${tab}")`);
    await page.waitForTimeout(500);
  }

  expect(errors).toEqual([]);
});
