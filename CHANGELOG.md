# Changelog

All notable changes to Page Quality Audit are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/); this project follows
semantic-ish versioning aligned with the Jahia module version.

## [Unreleased]

### Added
- **AI suggestions in the SEO tab** (when a provider is configured): ready-to-paste
  `<title>` alternatives, meta descriptions with live character counts, a focus
  keyword plus supporting terms, and heading rewrites (current → suggested with a
  one-line reason, highlightable in the preview) - each with a Copy button.
  Suggestions are grounded in the page text and written in the **page's
  language** since they are published content; only the reasons follow the
  editor's UI language. Display-only: nothing is written to the repository.
  Served by the existing hardened endpoint as a second server-defined task
  (`task: seo`) with its own prompt and whitelisting parser; cached with the
  audit like the AI review. Also proposes `og:title` / `og:description` for
  the social sharing card.
- **AI alt text in the Accessibility tab** (when a provider is configured and
  the page has images without `alt`): per image, a thumbnail, a suggested alt
  (≤125 chars, page language, Copy, highlight) and a one-line reason; purely
  decorative images are flagged for an empty alt. Vision-capable providers
  (Anthropic, OpenAI) receive a downscaled copy of each picture; DeepSeek is
  text-only, so suggestions there are inferred from file names and context
  and the UI says so. Third server-defined task (`task: alt`), 8 images per
  call.
- **Suggested fixes in the AI review**: recommendations about specific wording
  now carry a ready-to-copy correction in the page language (typo fixed,
  stronger CTA label, consistent term…).

### Fixed
- The AI review prompt gave the page language as a bare ISO code while the
  report language was spelled out, so a French-UI editor auditing an English
  page could be told to translate the page into French. Both languages are
  now named explicitly, with the rule that content in the page language is
  correct by definition.
- DeepSeek V4 models reason by default, which consumed the whole `AI_MAX_TOKENS`
  budget (empty answer, `502`) and made the visible answer ignore the JSON-only
  instruction. Reasoning is now disabled on DeepSeek requests, and an empty
  reasoning-only answer produces an explicit server-side diagnostic instead of
  "model did not return JSON".

## [1.4.0] - 2026-07-09

### Added
- **Ecodesign (RGESN) tab**: page-level checks against the French RGESN 2024
  eco-design referential (Frontend / Contents / UX / Architecture families) -
  page weight, HTTP requests, DOM size, lazy-loading, web fonts, autoplay media,
  legacy image formats, oversized images, missing dimensions, third-party
  origins - each with an actionable recommendation, plus a manual checklist for
  the whole-service criteria (hosting, backend, governance) that a single page
  cannot assess. It is explicit in-UI that this is **not** an RGESN conformity
  score. Reuses the Web Vitals resource data.
- AI review gains an **`ecodesign` category** so the LLM can flag
  digital-sustainability issues in prose.

### Fixed
- The localStorage results cache now carries a schema version; entries written
  by an older module version are discarded instead of restored, preventing a
  crash when the cached shape lacks a newly added analyzer key. Tab badges and
  dispatch are null-guarded as defense-in-depth.

## [1.3.0] - 2026-07-09

### Security
- Hardened the AI review endpoint against abuse of the operator's LLM key
  (fixes [#16](https://github.com/Jahia/page-audit/issues/16), PR
  [#17](https://github.com/Jahia/page-audit/pull/17)):
  - **Authorization** - the review is bound to a page the caller can read
    (`jcr:read`); unreadable or missing paths are rejected with `403`.
  - **Rate limiting** - per-user sliding window of 30 reviews / 10 minutes
    (`429` beyond that), protecting the shared provider quota and cost.
  - **Unauthenticated disclosure** - the status `GET` now requires a non-guest
    user, so provider/model/enabled state is no longer readable anonymously.
  - **CSRF** - the `POST` requires `Content-Type: application/json` (`415`
    otherwise) and rejects cross-origin browser requests via an Origin/Referer
    host check.
  - **Error disclosure** - provider/exception detail is logged server-side only;
    the client receives a generic message.
  - **Link checker** - only same-origin links on a read-only content-serving
    allowlist (`/cms/render`, `/cms/file`, `/files`) are verified with the
    editor's session; every other same-origin link is counted but never
    fetched, so a planted link cannot trigger a credentialed side-effect
    request from whoever audits the page.

## [1.2.0] - 2026-07-09

### Fixed
- AI review recommendations are now written in the **editor's jContent UI
  language** rather than the audited page's language (quoted page wording stays
  verbatim). The prompt states an explicit language name instead of an ISO code
  for reliable results.

### Changed
- More comfortable reading: base line-height raised to 1.55 across the drawer,
  with extra spacing in stat lists and recommendation details.

## [1.1.0] - 2026-07-08

### Added
- **AI review tab** (optional): sends the page text plus a digest of all audit
  findings to a configured LLM (Anthropic, OpenAI or DeepSeek) and returns an
  overall assessment plus up to 15 prioritized recommendations across 11
  categories - including dimensions no automated check covers (proofreading,
  factuality, consistency, conversion, localization quality, legal risk). Exact
  wording is highlightable in the preview; the footer shows token consumption
  and estimated cost. Configured via `org.jahia.se.modules.pageaudit.cfg`.
- **Result caching** per page and language in localStorage, with a "last audit"
  timestamp in the header; reopening the drawer restores instantly.
- **Staleness detection**: a cheap repository probe flags when the page changed
  after the audit, keeping the old report visible as a fix-it checklist.
- **Collapsible page preview** for full-height results.

### Changed
- Tab order: Accessibility, SEO, Web Vitals, Readability, Links, Jahia, AI review.
- Text extraction joins text nodes with spaces (accurate readability counts, no
  spurious "missing spaces" findings); Jahia's preview title prefix is stripped
  from SEO title checks.

### Fixed
- Editor/preview tooling (e.g. jExperience persona panel) is excluded from all
  analyzers; HTTP 4xx/5xx preview renders are refused instead of scored.

## [1.0.0] - 2026-07-08

### Added
- Initial release. jContent UI extension adding a "Page audit" action that opens
  a side-drawer auditing the current page across six tabs: Accessibility
  (axe-core WCAG A/AA/AAA + manual checklist), SEO (with social preview), Web
  Vitals (lab), Readability (EN/FR), Links (internal verification), and Jahia
  content health (publication + translation coverage via GraphQL).
- Every tab leads with severity-ranked, editor-friendly recommendations; results
  re-runnable and exportable as JSON. Full English + French UI.
- MIT licensed; GitHub Actions CI and Dependabot with platform guardrails.

[1.4.0]: https://github.com/Jahia/page-audit/releases/tag/v1.4.0
[1.3.0]: https://github.com/Jahia/page-audit/releases/tag/v1.3.0
[1.2.0]: https://github.com/Jahia/page-audit/releases/tag/v1.2.0
[1.1.0]: https://github.com/Jahia/page-audit/releases/tag/v1.1.0
[1.0.0]: https://github.com/Jahia/page-audit/releases/tag/v1.0.0
