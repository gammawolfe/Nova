import { test, expect, ADMIN_TOKEN, BASE_URL } from './fixtures';

test('login → create galaxy → issue invite → reveal', async ({ page }) => {
  await page.goto(BASE_URL + '/');
  await page.fill('#admintok', ADMIN_TOKEN);
  await page.click('button.nova-cta');
  await expect(page.getByRole('heading', { name: 'Galaxies' })).toBeVisible();

  await page.click('button:has-text("+ New galaxy")');
  const slug = 'acme-e2e-' + Math.random().toString(36).slice(2, 8);
  await page.fill('#g-slug', slug);
  await page.fill('#g-name', 'ACME E2E');
  await page.click('button:has-text("Forge galaxy")');
  await expect(page).toHaveURL(new RegExp(`#/galaxy/${slug}`));
  await expect(page.getByText('ACME E2E')).toBeVisible();

  await page.click('button:has-text("+ Issue invite")');
  // agentIdHint is required — button is disabled until it's filled.
  const issue = page.locator('.nova-modal button:has-text("Issue invite")');
  await expect(issue).toBeDisabled();
  await page.fill('#i-hint', 'agent_e2e_' + Math.random().toString(36).slice(2, 8));
  await expect(issue).toBeEnabled();
  await issue.click();
  await expect(page.getByText('ONE-TIME TOKEN')).toBeVisible();

  const jwt = await page.locator('.nova-modal .nova-glass.nova-mono').first().innerText();
  expect(jwt.split('.').length).toBe(3);
});

test('invalid token shows inline error', async ({ page }) => {
  await page.goto(BASE_URL + '/');
  await page.fill('#admintok', 'definitely-not-the-token-' + Math.random());
  await page.click('button.nova-cta');
  await expect(page.getByText('Invalid token.')).toBeVisible();
  await expect(page.locator('#admintok')).toHaveClass(/is-error/);
});

test('SSE stream is established after login', async ({ page }) => {
  const sseRequest = page.waitForRequest((r) => r.url().endsWith('/admin/events'), { timeout: 10_000 });
  await page.goto(BASE_URL + '/');
  await page.fill('#admintok', ADMIN_TOKEN);
  await page.click('button.nova-cta');
  const req = await sseRequest;
  expect(req.method()).toBe('GET');
});

test('reduced-motion disables surface animation', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(BASE_URL + '/');
  const anim = await page.locator('body.nova-surface').evaluate((el) => getComputedStyle(el, '::before').animationName);
  expect(anim).toBe('none');
  await ctx.close();
});
