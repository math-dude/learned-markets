import { expect, test } from '@playwright/test'

test('provides the browser Buffer used by Privy to encode a Solana challenge', async ({ page }) => {
  await page.goto('/portfolio')
  await expect(page.getByRole('heading', { name: 'Portfolio', exact: true })).toBeVisible()
  const encoded = await page.evaluate(() => Buffer.from(new TextEncoder().encode('Sign ✓')).toString('base64'))
  expect(encoded).toBe('U2lnbiDinJM=')
})
