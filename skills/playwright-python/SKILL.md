---
name: playwright-python
description: Python Playwright API for tests and scripts (snake_case, async_api, pytest-playwright, locators, expect). Load before writing or debugging Playwright Python, e2e browser tests, or pytest files that import playwright. Use when Page/Locator AttributeError, waitForTimeout, waitForResponse, expect_response, or JS vs Python Playwright APIs appear.
license: MIT
compatibility: opencode
---

# Playwright Python

Load this **before** writing Playwright tests. Do not guess from JavaScript docs or Node examples.

Python is **snake_case**. JavaScript is **camelCase**. `waitForTimeout` is JS; `wait_for_timeout` is Python.

## Read the docs first

1. This skill (already loaded).
2. Official Page API: webfetch `https://playwright.dev/python/docs/api/class-page`
3. Locators: `https://playwright.dev/python/docs/locators`
4. Assertions: `https://playwright.dev/python/docs/test-assertions`
5. Installed methods (offline):

```bash
uv run python -c "from playwright.async_api import Page; print([m for m in dir(Page) if not m.startswith('_')])"
```

If pytest says `AttributeError: 'Page' object has no attribute 'waitFor...'` or `Did you mean: 'wait_for_...'`, you used the JS API. Stop guessing. Fix the name from this skill or the docs above. Do not try another camelCase method.

## Async API (pytest-asyncio / custom fixtures)

```python
from playwright.async_api import Page, expect

await page.goto(url)
await page.get_by_role("button", name="Add").click()
await page.locator('input[name="title"]').fill("Buy milk")
await expect(page.get_by_text("Buy milk")).to_be_visible()
await expect(page).to_have_url("**/todos")
```

`locator.is_visible()` returns a bool immediately and does **not** wait. Prefer `expect(locator).to_be_visible()`.

## JS → Python

| JavaScript | Python |
|---|---|
| `page.waitForTimeout(500)` | `await page.wait_for_timeout(500)` (prefer locator/expect waits) |
| `page.waitForLoadState("networkidle")` | `await page.wait_for_load_state("networkidle")` |
| `page.waitForURL("**/todos")` | `await page.wait_for_url("**/todos")` |
| `page.waitForSelector("h1")` | `await page.locator("h1").wait_for()` |
| `page.waitForResponse(url)` | `async with page.expect_response(url) as ri:` then `await ri.value` |
| `page.waitForNavigation()` | `async with page.expect_navigation():` or `wait_for_url` |
| `page.getByRole(...)` | `page.get_by_role(...)` |
| `page.getByText(...)` | `page.get_by_text(...)` |
| `page.getByLabel(...)` | `page.get_by_label(...)` |
| `locator.innerText()` | `await locator.inner_text()` |
| `locator.isVisible()` | `await locator.is_visible()` |
| `locator.getAttribute("href")` | `await locator.get_attribute("href")` |
| `locator.selectOption("a")` | `await locator.select_option("a")` |
| `locator.setInputFiles(path)` | `await locator.set_input_files(path)` |

## `expect_response` is async

```python
async with page.expect_response("**/todos/**") as ri:
    await page.get_by_role("button", name="Save").click()
response = await ri.value
```

Wrong (causes `AsyncEventContextManager` TypeError):

```python
with page.expect_response("**/todos/**"):
    ...
await page.waitForResponse("**/todos/**")
```

Same pattern: `expect_navigation`, `expect_request`, `expect_download`, `expect_popup`.

## Do not

- Copy Playwright **Node/JS** snippets into `.py` files.
- Drive the UI with `page.evaluate("document.querySelector(...).submit()")` until locators have failed.
- Rerun pytest after an AttributeError without changing camelCase to snake_case.
