import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { SEED } from './seed-data';
import { expect, test } from './fixtures';

/** Runs axe (WCAG 2.1 A/AA) and fails on serious or critical violations, listing each one. */
async function expectNoSeriousViolations(page: Page, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const report = serious.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes
        .slice(0, 5)
        .map(
          (n) => `  - ${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1).join(' ')}`,
        )
        .join('\n')}`,
  );
  expect(report, `${name}\n${report.join('\n')}`).toEqual([]);
}

const PAGES: [string, string, (page: Page) => Promise<void>][] = [
  [
    'overview',
    '/',
    async (page) => {
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
      await expect(page.getByText(SEED.contractLabel).first()).toBeVisible();
    },
  ],
  [
    'add contract',
    '/contracts/new',
    async (page) => {
      await expect(page.getByRole('heading', { name: 'Add contract' })).toBeVisible();
    },
  ],
  [
    'events',
    '/events',
    async (page) => {
      await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
      await expect(page.getByTestId('event-row').first()).toBeVisible();
    },
  ],
  [
    'alert rules',
    '/alerts/rules',
    async (page) => {
      await expect(page.getByText(SEED.ruleName).first()).toBeVisible();
    },
  ],
  [
    'alert history',
    '/alerts/history',
    async (page) => {
      await expect(page.getByText(SEED.alertTitle).first()).toBeVisible();
    },
  ],
  [
    'settings',
    '/settings',
    async (page) => {
      await expect(page.getByRole('heading', { name: 'RPC providers' })).toBeVisible();
    },
  ],
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${scheme})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
    });

    for (const [name, path, ready] of PAGES) {
      test(`${name} has no serious violations`, async ({ page }) => {
        await page.goto(path);
        await ready(page);
        await expectNoSeriousViolations(page, `${name} (${scheme})`);
      });
    }

    test('contract details has no serious violations', async ({ page }) => {
      await page.goto('/');
      await page.getByText(SEED.contractLabel).first().click();
      await expect(page.getByText('Monitored storage entries')).toBeVisible();
      await expectNoSeriousViolations(page, `contract details (${scheme})`);
    });
  });
}

test('login page has no serious violations', async ({ browser }) => {
  // A fresh context, without the signed-in session from the fixture.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.locator('#token')).toBeVisible();
  await expectNoSeriousViolations(page, 'login');
  await context.close();
});

test('the mobile menu works with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  const events = page.locator('#mobile-nav').getByRole('link', { name: 'Events' });
  await expect(events).toBeVisible();
  // Tab through the menu until the Events link has focus, then follow it.
  for (let i = 0; i < 10 && !(await events.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(events).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/events/);
  await expectNoSeriousViolations(page, 'mobile events');
});
