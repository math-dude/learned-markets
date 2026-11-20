import { expect, test } from '@playwright/test'

test('launch, buy, sell and reconcile a browser account', async ({ page, browser }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible()
  await page.getByRole('navigation').getByRole('link', { name: 'Portfolio' }).click()
  await page.getByRole('button', { name: /Open paper account/ }).click()
  await expect(page.getByText('Available paper balance')).toBeVisible()
  await page.getByRole('link', { name: 'Launch a meme', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('Browser Bird')
  await page.getByLabel('Ticker', { exact: true }).fill('BIRD')
  await page.getByRole('button', { name: 'Launch into the Line' }).click()
  await expect(page.getByRole('status')).toContainText('queued for batch')
  await page.getByRole('link', { name: 'See it on the Board' }).click()
  await page.getByRole('link', { name: /Browser Bird/ }).click()
  await expect(page).toHaveURL(/\/coin\/BIRD$/)
  await page.getByLabel('Whole tokens').fill('500000')
  await page.getByLabel(/Maximum price/).fill('100')
  await page.getByRole('button', { name: 'Submit buy order' }).click()
  await expect(page.getByText(/500,000 tokens filled/)).toBeVisible()
  const portfolio = page.getByRole('navigation').getByRole('link', { name: 'Portfolio' })
  await portfolio.click()
  await expect(page.getByRole('link', { name: /Browser Bird.*500,000 tokens/ })).toBeVisible()

  await page.reload()
  const search = page.getByRole('combobox')
  await search.fill('BIRD')
  await search.press('Enter')
  await page.getByRole('button', { name: 'Sell', exact: true }).click()
  await page.getByLabel('Whole tokens').fill('100000')
  await page.getByLabel(/Minimum price/).fill('1')
  await page.getByRole('button', { name: 'Submit sell order' }).click()
  await expect(page.getByText(/100,000 tokens filled/)).toBeVisible()
  await portfolio.click()
  await expect(page.getByRole('link', { name: /Browser Bird.*400,000 tokens/ })).toBeVisible()
  const snapshot = await (await page.request.get('/api/market')).json()
  const coin = snapshot.coins.find((c: { ticker: string }) => c.ticker === 'BIRD')
  expect(snapshot.account.positions[coin.coin_id]).toBe(400000)
  const fills = snapshot.trades.filter((t: { ticker: string }) => t.ticker === 'BIRD')
  let cash = 2_000_000_000 - snapshot.launch_fee
  for (const fill of fills) {
    const value = fill.price * fill.quantity / 1e6
    cash += fill.side === 'buy' ? -Math.ceil(value) - fill.fee : Math.floor(value) - fill.fee
  }
  expect(snapshot.account.cash).toBe(cash)
  const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } })
  try {
    const mobile = await visitor.newPage()
    await mobile.goto('http://127.0.0.1:5189/coin/BIRD')
    await expect(mobile.getByRole('heading', { name: 'Browser Bird' })).toBeVisible()
    await expect(mobile.getByRole('link', { name: 'Open a paper account to trade' })).toBeVisible()
    expect(await mobile.locator('body').evaluate(el => el.scrollWidth <= innerWidth)).toBe(true)
  } finally { await visitor.close() }
  expect(errors).toEqual([])
})
