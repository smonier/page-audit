# Page Quality Audit - Agent Harness

This module is a **Track 2 OSGi UI extension** (see AIStartupKit CLAUDE.md): Maven bundle, React 18, Webpack + Module Federation, `@jahia/ui-extender`. It was cloned from the `jahia-mcp-chat` skeleton.

## Invariants

- React **18** only (shared MF singleton with jcontent). Never import React 19 APIs.
- Build with `mvn clean install` (Java 17). Never run `yarn webpack --watch` from an agent.
- Webpack output goes to `src/main/resources/javascript/apps/` and is cleaned by `maven-clean-plugin`.
- Bundle symbolic name is `page-audit`; the action's `requireModuleInstalledOnSite: ['page-audit']` depends on it - do not rename one without the other.
- Translations are bundled JSON (`src/main/resources/javascript/locales/{en,fr}.json`) registered synchronously via `i18next.addResourceBundle` in `init.js`. Every new UI string needs both EN and FR.
- Chrome emits **no paint-timing (FCP) or LCP entries for iframe documents** - do not try to observe them. LCP is approximated from the largest image in the initial viewport (`lcpApprox` flag) and displayed with an "estimated" hint. CLS and navigation timing DO work in iframes.
- `axe.source` was **removed in axe-core 4.x**. axe is shipped as a module static resource (`axe.min.js`, copied by webpack) and injected into the iframe via `<script src>`, then run as `contentWindow.axe.run(...)` - never `axe.run` from the parent realm.
- Run `runWebVitals` **before** `runAccessibility` and keep the `SELF_INJECTED` filter: the injected axe script otherwise shows up in the page's own resource statistics.
- Resource sizes use `transferSize || encodedBodySize`; memory-cache hits can still report 0, so page weight is indicative only.
- The link checker must **never fetch login/logout/`.do` URLs** (`SIDE_EFFECT` regex): requesting the logout link kills the editor's jContent session. Skipped links are reported in the summary, never silently dropped.
- The preview renders the **default workspace**, so internal links legitimately look like `/cms/render/default/...` - that URL shape is NOT a defect and must not be flagged.
- GraphQL goes through **jcontent's shared Apollo client**: `@apollo/client` is declared in webpack `shared` with `import: false` (consumed from the host, never bundled), and `useApolloClient()` works in the drawer because `createPortal` preserves React context from the action component.
- Page-scoped JCR traversal: `descendants(typesFilter: {types: ["jnt:content"]}, recursionTypesFilter: {multi: NONE, types: ["jnt:page"]})` - `multi: NONE` means "recurse into everything EXCEPT these types", which stops at sub-page boundaries. Without it you get the whole subtree of every child page.
- Untranslated detection flags only nodes whose `translationLanguages` is non-empty but missing an `activeInEdit` site language - nodes with no translation nodes at all simply have no i18n properties (not a defect).
- **Editor/preview tooling is stripped from the iframe before any analyzer runs** (`analyzers/tooling.js`). jExperience's persona preview is an anchor with CLASS `tst-openPersonaPanel` (not an id) plus `iframe#personas_panel`, injected client-side by wem.js in authoring context. Any new preview widget that pollutes audit results gets its selector added there - one place cleans all six tabs.
- The drawer refuses to audit a preview that returned HTTP >= 400 (`PerformanceNavigationTiming.responseStatus`) - e.g. a page not available in the audited language renders Jahia's 404 page, and scoring that would be meaningless.
- **AI review (Java)**: `PageAuditConfigService` (configurationPid `org.jahia.se.modules.pageaudit`, `@Activate`+`@Modified` for live cfg reload) + `AiReviewServlet` (whiteboard alias `/page-audit/ai-review`, reachable at `/modules/page-audit/ai-review`). The prompt is built server-side (structured JSON-only output à la ai-content-sentinel); the answer is parsed defensively and re-serialized with whitelisted fields only. Guest requests are rejected. The pom declares NO dependencies - the `jahia-modules` parent provides the whole compile classpath (jahia-impl, servlet API, org.json, OSGi annotations, slf4j).
- AI review state (`aiReview`/`aiPhase`) lives in the drawer, not the tab - tabs unmount on switch and would lose it. Never auto-trigger the LLM call; it runs only on explicit button click (cost control).
- Audit results (incl. the AI review) are **cached in localStorage** per page+language (`page-audit:<lang>:<path>`), LRU-capped at 10 entries with quota-exceeded eviction. Reopening restores instantly and shows "Dernier audit : <date>" in the header; `Relancer` (runId > 0) always bypasses the cache; `cacheHitRef` makes the frame load skip re-analysis on restore.
- **The cache carries a `schema` version (`CACHE_SCHEMA`) - bump it whenever the `results` shape changes** (e.g. adding an analyzer key like `ecodesign`). `loadCachedAudit` discards entries whose schema differs, so an old cache can't be restored into UI expecting a new key. Skipping this bump caused a white-screen crash when the ecodesign tab shipped. Tab badges and the tab dispatch are also null-guarded per analyzer as defense-in-depth.
- The **Ecodesign (RGESN) tab** reuses the Web Vitals `diagnostics` (weight/requests/DOM/images) plus its own DOM/resource probes (lazy-loading, fonts, autoplay, modern image formats, third-party origins). It runs right after `runWebVitals` in the flow and takes the vitals result as its second arg. It is explicit in-UI that it is NOT an RGESN conformity score (per-page subset only) - the whole-service criteria are a manual checklist.
- **Text extraction must join text nodes with spaces** (TreeWalker, not `textContent`) - `textContent` merges adjacent block elements into single words, which skews readability counts and makes the LLM report fake "missing spaces" issues. And `doc.title` in the default-workspace render carries Jahia's preview prefix ("Aperçu - ") - strip it before any title check.
- AI review categories are a server-side whitelist (`AiReviewServlet.parseReview`) + prompt enum + `ai.categories.*` locale keys - all three must stay in sync when adding one. Taxonomy inspired by Jahia/ai-content-sentinel (proofreading, factuality, consistency, conversion, localization, legal).
- **SEO assist** shares the AI endpoint via `{"task": "seo"}` (server picks `SEO_ASSIST_PROMPT` + `parseSeoAssist`; the client never sends a prompt). Language rule differs from the review: suggested titles/descriptions/keywords/headings are PUBLISHED content → **page language**; only `reason` is editor prose → UI language. Both language names are `String.format`-ed into the system prompt - "the language stated in the input" was NOT followed reliably by a non-reasoning model.
- **DeepSeek V4 models reason by default**: `reasoning_content` eats the `max_tokens` budget (empty `content`, 29 s, "model did not return JSON") and even a completed answer ignores the JSON-only instruction. The servlet sends `thinking: {type: disabled}` for the deepseek provider - structured extraction never needs chain-of-thought. Do not add that param for OpenAI (unknown params are rejected with 400).
- On an unparseable model answer the servlet logs the first 500 chars server-side (`Unparseable model answer`) - read that before touching the prompt. `docker logs` is empty for the local container; the log is `/var/log/jahia/jahia.log` inside it.
- `aiStatus` ({enabled, provider, model}) is fetched once in the drawer per opening and passed to both `AiTab` and `SeoAssist`; `SeoAssist` renders nothing when AI is not configured. `seoAssist` rides in the same cache entry as `aiReview` (both saves must carry both keys or one wipes the other).
- All analyzers receive the iframe element and must throw (not silently return) when `contentDocument` is unavailable.

## Layout

```
src/javascript/
├── index.js                  # jahiaApp-init:50 callback
├── init.js                   # translations + action registration (contentActions + headerPrimaryActions)
└── PageAudit/
    ├── PageAuditAction.jsx   # useNodeChecks (jnt:page + module-on-site) → portal drawer
    ├── PageAuditDrawer.jsx   # iframe lifecycle, tabs, highlight, export
    ├── analyzers/            # accessibility (axe), webVitals (PerformanceObserver), readability
    └── tabs/                 # presentation components
```

## Relevant AIStartupKit skills

- `/jahia-osgi-ui-extension` - canonical patterns for this module type
- `/jahia-dev-debug` - build/deploy/runtime debugging
