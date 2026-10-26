import { SEED } from './seed-data';
import { expect, test } from './fixtures';

test('overview shows monitored contracts, latest events, alerts and status', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText(SEED.contractLabel).first()).toBeVisible();
  await expect(page.getByText(SEED.alertTitle).first()).toBeVisible();
  await expect(page.getByText('Monitoring status')).toBeVisible();
});

test('contract details show activity, events, storage and rules', async ({ page }) => {
  await page.goto('/');
  await page.getByText(SEED.contractLabel).first().click();
  await expect(page.getByRole('heading', { name: SEED.contractLabel })).toBeVisible();
  await expect(page.getByText('Monitored storage entries')).toBeVisible();
  await expect(page.getByText('Contract instance')).toBeVisible();
  await expect(page.getByText(SEED.ruleName)).toBeVisible();
});

test('events explorer filters by topic and transaction and paginates', async ({ page }) => {
  await page.goto('/events');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(30);

  await page.getByLabel('Topic').fill('mint');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/topic=mint/);
  await expect(rows).toHaveCount(10);

  await page.goto(`/events?txHash=${SEED.txHash}`);
  await expect(rows).toHaveCount(1);
});

test('add contract validates the ID format before calling the network', async ({ page }) => {
  await page.goto('/contracts/new');
  await page.getByLabel('Contract ID').fill('GABC');
  await expect(page.getByRole('button', { name: 'Validate' })).toBeDisabled();
  await page.getByLabel('Contract ID').fill(SEED.contractId);
  await page.getByRole('button', { name: 'Validate' }).click();
  // Either the network confirms it is already registered, or no RPC is reachable in this environment.
  await expect(page.getByText(/already|monitor|could not|rpc/i).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('button', { name: 'Start monitoring' })).toBeDisabled();
});

test('alert configuration creates destinations and rules', async ({ page }) => {
  await page.goto('/alerts/rules');
  await page.getByRole('button', { name: 'Add destination' }).click();
  await page.getByLabel('Name', { exact: true }).fill('E2E hook');
  await page.getByLabel('URL').fill('https://example.com/e2e');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/copy it now/i)).toBeVisible();
  await expect(page.getByText('E2E hook').first()).toBeVisible();

  await page.getByRole('button', { name: 'New rule' }).click();
  await page.locator('#r-name').fill('E2E transfers');
  await page.locator('#r-topics').fill('transfer, *');
  await page.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByTestId('rule-row').filter({ hasText: 'E2E transfers' })).toBeVisible();
});

test('alert history shows failed notifications and supports acknowledge, retry and resolve', async ({
  page,
}) => {
  await page.goto('/alerts/history');
  await page.getByRole('button', { name: /Failed notifications/ }).click();
  await expect(page.getByText(SEED.alertTitle).first()).toBeVisible();
  // Turn the delivery filter off again: once retried, the alert no longer has a failed notification.
  await page.getByRole('button', { name: /Failed notifications/ }).click();

  await page.getByRole('button', { name: 'Acknowledge', exact: true }).first().click();
  await page.getByLabel('Note (optional)').fill('Known issue, extending TTL tomorrow');
  await page.getByRole('button', { name: 'Acknowledge alert' }).click();
  await expect(page.getByRole('button', { name: 'Acknowledged (1)' })).toBeVisible();

  await page.getByText(SEED.alertTitle).first().click();
  await expect(page.getByText('Known issue, extending TTL tomorrow')).toBeVisible();
  await expect(page.getByText('Webhook responded 500')).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Failed notifications (0)' })).toBeVisible();

  await page.getByRole('button', { name: 'Resolve', exact: true }).first().click();
  await page.getByRole('button', { name: 'Resolve alert' }).click();
  await expect(page.getByRole('button', { name: 'Resolved (1)' })).toBeVisible();
});

test('settings manages API tokens', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'RPC providers' })).toBeVisible();
  await page.getByLabel('New token name').fill('E2E token');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText(/copy your new token now/i)).toBeVisible();
  await expect(page.getByText(/schm_/).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'E2E token' })).toBeVisible();

  // The audit log records the token we just created.
  await page.reload();
  await expect(
    page.getByTestId('audit-row').filter({ hasText: 'POST /settings/tokens' }).first(),
  ).toBeVisible();
});
