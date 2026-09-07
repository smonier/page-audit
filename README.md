# Page Quality Audit

Jahia jContent UI extension (OSGi/Maven, React 18, Webpack + Module Federation) that adds a **Page audit** action on pages in jContent and Page Builder. The action opens a right-side drawer that loads the page in a same-origin preview iframe and audits it across six tabs. Every tab leads with **actionable recommendations** (severity chip + what is wrong + how to fix it), and every tab badge means the same thing: the number of issues to review.

| Tab | What it does |
|---|---|
| **Accessibility** | axe-core against the full WCAG A / AA / AAA + best-practice rule set. Per-level scorecards, violations grouped by severity with element highlighting, engine version and rules-run transparency, the "needs human review" cases axe cannot decide, and a manual checklist for the WCAG criteria no tool can automate. |
| **SEO** | Title and meta-description length bands, `noindex`/`nofollow` detection, canonical URL, Open Graph / Twitter card completeness with a rendered **social sharing preview card**, JSON-LD presence and validity, `<html lang>` vs audited language, image alt coverage, generic anchor texts. When AI is configured, an **AI suggestions** section proposes ready-to-paste `<title>` tags, meta descriptions (with live character counts), a focus keyword + supporting terms, and heading rewrites (current → suggested, with a reason) - each with a **Copy** button and highlight-in-preview for headings. Suggestions are grounded in the page text and written in the **page's language** (they are published content); only the reasons follow the editor's UI language. Nothing is written back: the editor pastes into the SEO properties or the heading content. |
| **Web Vitals** | Lab measurement via buffered `PerformanceObserver` and navigation timing: TTFB, DOM ready, full load, CLS, LCP (estimated - Chrome emits no LCP/paint entries in iframes; INP requires interaction), plus diagnostics: page weight, request count, DOM size, image issues, largest resources. |
| **Readability** | Language-aware scoring: Flesch Reading Ease + Flesch-Kincaid grade (EN), Kandel-Moles adaptation (FR). Sentence/paragraph stats, heading structure checks. |
| **Ecodesign** | Page-level checks against the French **RGESN 2024** eco-design referential (Frontend / Contents / UX / Architecture families): page weight, HTTP requests, DOM size, lazy-loading of below-the-fold images, web-font count/format, autoplay media, legacy vs modern image formats, oversized images, third-party origins - plus a manual checklist for the whole-service criteria (hosting, backend, governance) no page tool can judge. Explicitly not an RGESN conformity score. |
| **Links** | Verifies every internal link with the editor's session (HEAD, batched) and lists broken ones with highlight-in-preview. Flags hardcoded absolute URLs to the current host, mixed content, and `target="_blank"` without `rel="noopener"`. Never fetches login/logout/`.do` URLs (side effects); external links are counted but honestly marked unverifiable from the browser. |
| **Jahia** | The checks no generic web tool can do, via jcontent's shared Apollo GraphQL client: unpublished content blocks on the page (visitors see an older version), content missing translations in active site languages, raw i18n keys visible in the DOM (`namespace:key.path`), and placeholder text (lorem ipsum / TODO). |
| **AI review** (optional) | Sends the page text plus a digest of all audit findings to a configured LLM (Anthropic, OpenAI or DeepSeek) and returns an overall assessment plus up to 15 prioritized, editor-friendly recommendations across 12 categories - including dimensions no automated check covers: proofreading, factuality, consistency, conversion, localization quality, legal risk and eco-design. Recommendations are written in the **editor's jContent UI language** (quoted page wording stays verbatim); exact-wording quotes are highlightable in the preview; the footer reports token consumption (in/out) and estimated cost; truncated model answers are salvaged rather than failed. Disabled until an administrator configures a provider - see below. |

**Editor comfort**: results (including the AI review) are cached per page and language in the browser's localStorage - reopening the drawer restores the last audit instantly, with a "Last audit: date" indicator in the header. A cheap repository probe detects when the page was modified after the audit and shows a non-blocking notice ("re-run when you are done editing") while keeping the old report visible as a fix-it checklist. The page preview is collapsible to give the results the full drawer height. Results can be re-run and exported as JSON. All UI ships in English and French.

## Build and deploy

Requires Java 17 and Maven 3.6+.

```bash
mvn clean install
# then deploy target/page-audit-<version>.jar via the Jahia module manager, or:
curl -s --user root:root --form bundle=@target/page-audit-1.0.0-SNAPSHOT.jar --form start=true http://localhost:8080/modules/api/bundles
```

The module must be **enabled on the target site** (Administration > Modules) for the action to appear - the action guards with `requireModuleInstalledOnSite`. It shows on `jnt:page` and `jmix:mainResource` content.

## AI review configuration (optional)

The AI tab stays disabled until configured. Edit `digital-factory-data/karaf/etc/org.jahia.se.modules.pageaudit.cfg` at runtime (picked up immediately, no restart):

```properties
AI_PROVIDER=anthropic             # anthropic | openai | deepseek
AI_MODEL=claude-sonnet-5
AI_API_KEY=sk-ant-...             # never commit; never sent to the browser
AI_MAX_TOKENS=4096                # a full review needs 3000-4000 output tokens
AI_PROMPT_APPENDIX=               # optional brand/editorial instructions
AI_COST_INPUT_PER_MTOKENS=3.00    # USD per 1M tokens - update when changing model
AI_COST_OUTPUT_PER_MTOKENS=15.00  # used for the estimated cost shown to editors
```

The prompt is built **server-side** from a constrained payload (page text + audit digest), so the endpoint cannot be reused as a general-purpose LLM proxy. The model must answer with a strict JSON schema (severity, category, title, detail, exact wording) that is validated and whitelisted server-side before reaching the browser - inspired by [ai-content-sentinel](https://github.com/Jahia/ai-content-sentinel) and the [jahia-mcp-chat](https://github.com/smonier/jahia-mcp-chat) proxy pattern.

The same endpoint serves two server-defined tasks - the holistic review and the SEO assist (`{"task": "seo"}`), each with its own prompt and whitelisting parser; the client can only pick a task, never a prompt. For DeepSeek, reasoning mode is disabled on the request (`thinking: disabled`): V4 models otherwise spend the whole `AI_MAX_TOKENS` budget on hidden reasoning and answer in prose instead of the required JSON.

The endpoint is hardened against abuse of the operator's LLM key: it requires an authenticated (non-guest) user, is bound to a page the caller can actually read (`jcr:read`), rejects cross-origin and non-JSON requests (CSRF), enforces a per-user rate limit (30 reviews / 10 minutes), and returns generic error messages without leaking upstream detail. The status `GET` also requires authentication so the provider/model are not disclosed anonymously.

## CI and dependency updates

- GitHub Actions builds every push and PR (Java 17 + Maven; the bundle jar is uploaded as an artifact).
- Dependabot keeps dependencies current - notably **axe-core**, so new WCAG rules land automatically (the audit runs by WCAG tag, not a hardcoded rule list). Guardrails: React stays on 18 (jcontent's Module Federation singleton), the Jahia parent POM is never bumped, and majors known to break the runtime or require Node 20+ are ignored with explanations in `.github/dependabot.yml`.
- CI proves the bundle compiles; it cannot prove the drawer works in jcontent. Validate runtime-affecting bumps locally (build, deploy, open the drawer) before merging - css-loader 7 was CI-green and runtime-broken.

## Architecture notes

- The audit runs entirely in the editor's browser against `/cms/render/default/{lang}{path}.html` (default workspace - you audit what you are editing, including unpublished changes). Internal links legitimately look like `/cms/render/default/...` in this context.
- axe-core ships as a module static resource (`javascript/apps/axe.min.js`) and is injected into the iframe via `<script src>` (`axe.source` was removed in axe-core 4.x).
- Editor/preview tooling (e.g. jExperience's persona preview panel) is stripped from the iframe before analysis so it never pollutes results (`analyzers/tooling.js`).
- The drawer refuses to audit a preview that returned HTTP 4xx/5xx (e.g. a page missing in the audited language) instead of silently scoring an error page.
- GraphQL goes through jcontent's shared Apollo client (`@apollo/client` consumed via Module Federation, never bundled).
- No Java code in this phase. A future PageSpeed Insights proxy (field data for published pages) would follow the OSGi whiteboard servlet + `.cfg` config-service pattern.
- Automated WCAG checks cover a subset of criteria; the UI states this explicitly and never claims full compliance - the manual checklist covers the rest.

See [CHANGELOG.md](CHANGELOG.md) for the release history, and [.agents/README.md](.agents/README.md) for the agent harness and the full list of implementation traps.
