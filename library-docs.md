# Unfamiliar libraries

Before writing code against a library you have not already used in this session:

1. Load a matching skill if one exists. Playwright Python: `playwright-python`.
2. Otherwise webfetch the official docs. Playwright: https://playwright.dev/python/docs/api/class-page
3. Or inspect the installed package, e.g. `uv run python -c "from playwright.async_api import Page; print([m for m in dir(Page) if not m.startswith('_')])"`

Do not translate JavaScript APIs into Python by guessing. Playwright Python is snake_case (`wait_for_timeout`, `get_by_role`, `expect_response`). `waitForTimeout` / `waitForResponse` / `isVisible` are JavaScript.

If pytest reports `AttributeError: 'Page' object has no attribute 'waitFor...'` or `Did you mean: 'wait_for_...'`, stop editing. Load `playwright-python` or webfetch the Page docs. Do not try another camelCase method, and do not rerun pytest until the names are snake_case.
