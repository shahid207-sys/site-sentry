# Changelog

Changes that alter results users already see. Engine and rule internals are in the commit history.

## Phase 2 (crawler v2 branch)

### Legacy engine: main-content word count changed

The legacy (in-request) engine's `content/thin` check counts the words in `mainContentText`
(`src/lib/audit/rules/content.ts`). Crawler v2 snapshots and the Phase 2 rules use the same function,
and two Phase 2 changes to it alter the legacy count too. **An audit run before these changes and one
run after can report different word counts and a different `content/thin` result for the same,
unchanged page.**

1. **Block boundaries count as word breaks** (`cc93b90`). Text in adjacent block elements used to be
   joined with no space: `<h1>Garden</h1><p>Tools</p>` read as `GardenTools`, one word. It now reads
   `Garden Tools`, two words. Counts go **up** on pages whose blocks touch with no whitespace between them
   in the HTML, which is common in minified or builder-generated markup. A page that was just under the
   thin-content threshold can now pass.
2. **ARIA landmark furniture is excluded, and `role="main"` is honoured** (`03d85a1`). Besides `<nav>`,
   `<header>`, `<footer>`, `<aside>` and `<form>`, elements with `role="navigation"`, `"banner"`,
   `"contentinfo"`, `"complementary"` or `"search"` are now left out. An element with `role="main"` is
   used as the main region, just like `<main>`. Counts go **down** on pages built with `<div role=…>`
   landmarks instead of the semantic elements, because their menus and footers no longer count as
   content. Such a page can now be reported thin when it was not before.

Nothing else in the legacy engine changed. The thin-content threshold (Settings → rule config,
default unchanged) and the check's wording are unchanged.
