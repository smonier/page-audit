package org.jahia.se.modules.pageaudit.servlet;

import org.jahia.se.modules.pageaudit.config.PageAuditConfigService;
import org.jahia.services.content.JCRSessionFactory;
import org.jahia.services.content.JCRSessionWrapper;
import org.jahia.services.usermanager.JahiaUser;
import org.json.JSONArray;
import org.json.JSONObject;
import org.osgi.service.component.annotations.Component;
import org.osgi.service.component.annotations.Reference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.servlet.Servlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Server-side AI review endpoint for the Page Quality Audit drawer.
 *
 * GET  /modules/page-audit/ai-review  -> {enabled, provider, model} (never the key)
 * POST /modules/page-audit/ai-review  -> runs the AI review and returns
 *      {provider, model, summary, recommendations: [{severity, category, title, detail, wording}]}
 * POST with {"task": "seo"}            -> SEO assist: ready-to-use suggestions in the PAGE language
 *      {provider, model, titles[], metaDescriptions[], keywords: {focus, secondary[]},
 *       headings: [{level, current, suggested, reason}]}
 *
 * The prompt is built server-side from a constrained payload (page text +
 * audit digest), so this endpoint cannot be abused as a general-purpose LLM
 * proxy. The API key is read from the OSGi configuration and never sent to
 * the browser. Inspired by Jahia/ai-content-sentinel (structured JSON-only
 * output) and jahia-mcp-chat (provider proxying).
 */
@Component(
        service = {HttpServlet.class, Servlet.class},
        property = {"alias=/page-audit/ai-review", "allow-api-token=true"},
        immediate = true)
public class AiReviewServlet extends HttpServlet {

    private static final Logger logger = LoggerFactory.getLogger(AiReviewServlet.class);

    private static final String ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
    private static final String OPENAI_URL = "https://api.openai.com/v1/chat/completions";
    private static final String DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

    private static final int MAX_TEXT_CHARS = 15000;
    private static final int MAX_DIGEST_LINES = 60;
    private static final int MAX_RECOMMENDATIONS = 20;
    private static final int MAX_HEADINGS_IN = 20;
    private static final int MAX_SUGGESTIONS = 3;
    private static final int MAX_KEYWORDS = 8;
    private static final int MAX_HEADING_SUGGESTIONS = 8;
    private static final int MAX_SUGGESTION_CHARS = 300;
    // Alt text task: images per request and per-image inline data cap (base64 chars, ~300 kB)
    private static final int MAX_ALT_IMAGES = 8;
    private static final int MAX_IMAGE_BASE64_CHARS = 400_000;
    private static final int MAX_CONTEXT_CHARS = 600;
    private static final int MAX_CTAS = 10;
    private static final int MAX_SENTENCES = 8;

    // Per-user sliding-window rate limit: protects the shared provider quota / cost
    // from a single caller (e.g. 30 reviews per 10 minutes per user).
    private static final int RATE_MAX_CALLS = 30;
    private static final long RATE_WINDOW_MS = 600_000L;
    private final Map<String, Deque<Long>> callWindows = new ConcurrentHashMap<>();

    private static final String SYSTEM_PROMPT =
            "You are a senior web quality consultant reviewing a CMS page before publication. "
            + "You receive the page text, its metadata, and a digest of automated audit findings "
            + "(accessibility, SEO, links, performance, readability, publication state). "
            + "Give recommendations a content editor can act on, preferring fixes that need no development work. "
            + "Do not repeat raw audit findings verbatim: prioritize them, connect them, and add what automated "
            + "tools cannot see. Actively check these dimensions the automated audit cannot cover:\n"
            + "- proofreading: typos, grammar, punctuation, capitalization mistakes (quote the exact wording)\n"
            + "- factuality: outdated or contradictory content - past dates presented as upcoming, stale years, "
            + "claims that contradict other parts of the page\n"
            + "- consistency: terminology drift (same product/name spelled differently), inconsistent date/number "
            + "formats, inconsistent heading capitalization\n"
            + "- conversion: missing or weak calls to action, vague button labels, no clear next step for the visitor\n"
            + "- localization: fragments in the wrong language for the page, machine-translation artifacts, "
            + "untranslated visible strings\n"
            + "- legal: unsubstantiated superlative claims, missing legal mentions, risky wording\n"
            + "- ecodesign: digital-sustainability issues per the French RGESN referential - heavy pages, "
            + "too many requests or third-party origins, unoptimized or legacy-format images, autoplay media, "
            + "excessive web fonts\n"
            + "Do not invent issues.\n\n"
            + "Reply ONLY with a valid JSON object. No markdown, no code fences, no comments, no trailing commas.\n"
            + "JSON structure:\n"
            + "{\n"
            + "  \"summary\": \"2-3 sentence overall assessment\",\n"
            + "  \"recommendations\": [\n"
            + "    {\n"
            + "      \"severity\": \"critical\" | \"serious\" | \"moderate\" | \"minor\",\n"
            + "      \"category\": \"content\" | \"seo\" | \"accessibility\" | \"performance\" | \"ux\" | "
            + "\"proofreading\" | \"factuality\" | \"consistency\" | \"conversion\" | \"localization\" | \"legal\" | "
            + "\"ecodesign\",\n"
            + "      \"title\": \"short actionable title\",\n"
            + "      \"detail\": \"1-3 sentences: why it matters and how to fix it\",\n"
            + "      \"wording\": \"exact text quoted from the page when the issue concerns specific wording, else empty string\",\n"
            + "      \"fix\": \"the corrected or improved text ready to paste in place of \\\"wording\\\" (typo fixed, "
            + "clearer CTA label, consistent term, translated fragment…), else empty string\"\n"
            + "    }\n"
            + "  ]\n"
            + "}\n"
            + "Maximum 15 recommendations, most important first. "
            + "LANGUAGE RULES: the input states a PAGE LANGUAGE and a REPORT LANGUAGE, which may differ. Content written "
            + "in the PAGE LANGUAGE is correct by definition - never recommend translating the page into the REPORT "
            + "LANGUAGE; only fragments in some OTHER language are localization issues. "
            + "You MUST write summary, title and detail in the REPORT LANGUAGE (they are read by the editor). "
            + "\"wording\" quotes the page verbatim. \"fix\" MUST be written in the PAGE LANGUAGE, because it is "
            + "content that will be published in place of \"wording\".";

    /**
     * SEO assist task: unlike the review (prose FOR the editor, in the UI language),
     * the suggested title, meta descriptions, keywords and headings are content
     * that will be PUBLISHED to visitors - they must be in the page's language.
     * Only the per-heading "reason" is editor-facing and follows the UI language.
     */
    private static final String SEO_ASSIST_PROMPT =
            "You are an SEO copywriter helping a CMS content editor optimize one page. "
            + "You receive the page text, its current title, meta description and headings, and the automated SEO findings. "
            + "Produce ready-to-paste suggestions grounded ONLY in what the page actually says - never invent facts, "
            + "offers, numbers or names that are not in the text. Write naturally for humans, no keyword stuffing.\n\n"
            + "Reply ONLY with a valid JSON object. No markdown, no code fences, no comments, no trailing commas.\n"
            + "JSON structure:\n"
            + "{\n"
            + "  \"titles\": [\"2 alternative <title> tags, 30-60 characters, primary keyword near the start\"],\n"
            + "  \"metaDescriptions\": [\"3 alternative meta descriptions, 120-155 characters each, one clear benefit + implicit call to click\"],\n"
            + "  \"social\": {\n"
            + "    \"title\": \"og:title for social sharing cards, max 60 characters, catchier than the <title>, no brand suffix needed\",\n"
            + "    \"description\": \"og:description, 80-150 characters, written to make people stop scrolling and click\"\n"
            + "  },\n"
            + "  \"keywords\": {\n"
            + "    \"focus\": \"the single primary keyword or phrase this page should rank for\",\n"
            + "    \"secondary\": [\"3-6 related terms or long-tail phrases already supported by the page text\"]\n"
            + "  },\n"
            + "  \"headings\": [\n"
            + "    {\n"
            + "      \"level\": \"h1\" | \"h2\" | \"h3\",\n"
            + "      \"current\": \"exact current heading text, or empty string when proposing a missing h1\",\n"
            + "      \"suggested\": \"improved heading text\",\n"
            + "      \"reason\": \"one sentence IN %2$s: why this is better (descriptive, keyword-aligned, consistent…)\"\n"
            + "    }\n"
            + "  ],\n"
            + "  \"ctas\": [\n"
            + "    {\n"
            + "      \"current\": \"the exact generic label given under WEAK CALLS TO ACTION\",\n"
            + "      \"suggestions\": [\"2-3 specific labels (2-5 words, verb + what the visitor gets, fits a button) based on the CTA's context\"],\n"
            + "      \"reason\": \"one sentence IN %2$s\"\n"
            + "    }\n"
            + "  ]\n"
            + "}\n"
            + "Only include headings that genuinely benefit from a rewrite (maximum 6); keep good headings out. "
            + "Answer \"ctas\" for every weak call to action listed (empty array when none is listed). "
            + "LANGUAGE RULES: titles, metaDescriptions, social, keywords, every \"suggested\" heading and every CTA suggestion "
            + "MUST be written in %1$s, because they will be published to the page's visitors. "
            + "Every \"reason\" MUST be written in %2$s, because it is read by the editor.";

    /**
     * Plain-language task: rewrite the page's hardest sentences (the ones the
     * readability score penalizes) without changing their meaning.
     */
    private static final String SIMPLIFY_PROMPT =
            "You are a plain-language editor. You receive the longest, hardest sentences of a CMS page. "
            + "Rewrite each one for a general audience: shorter sentences (split into two when useful), common words "
            + "instead of jargon, active voice, one idea per sentence. Preserve every fact, name, number and nuance - "
            + "never add or drop information, never change the tone from informative to promotional.\n\n"
            + "Reply ONLY with a valid JSON object. No markdown, no code fences, no comments, no trailing commas.\n"
            + "JSON structure:\n"
            + "{\n"
            + "  \"sentences\": [\n"
            + "    {\n"
            + "      \"id\": <the sentence number>,\n"
            + "      \"rewrite\": \"the plain-language version (may be two sentences)\",\n"
            + "      \"reason\": \"one sentence: what made the original hard and what changed\"\n"
            + "    }\n"
            + "  ]\n"
            + "}\n"
            + "Answer for every sentence id you received, in the same order.\n"
            + "LANGUAGE RULES: every \"rewrite\" MUST be written in %1$s (it replaces published text); "
            + "every \"reason\" MUST be written in %2$s (it is read by the editor).";

    /**
     * Alt text task: one call for every image of the page that lacks an alt
     * attribute. Each image comes with its DOM context (caption, nearest
     * heading, surrounding text, link target) and, when the browser could read
     * its pixels (same-origin, not tainted), a downscaled copy for vision models.
     */
    private static final String ALT_TEXT_PROMPT =
            "You write alternative text for images on a CMS page, for screen reader users and search engines. "
            + "For each IMAGE #n you receive its file name, rendered size, whether it is a link, nearby text "
            + "(caption, nearest heading, surrounding paragraph) and, when available, the picture itself.\n\n"
            + "Reply ONLY with a valid JSON object. No markdown, no code fences, no comments, no trailing commas.\n"
            + "JSON structure:\n"
            + "{\n"
            + "  \"images\": [\n"
            + "    {\n"
            + "      \"id\": <the image number n>,\n"
            + "      \"decorative\": true | false,\n"
            + "      \"alt\": \"the alternative text, or empty string when decorative\",\n"
            + "      \"reason\": \"one sentence explaining the choice\"\n"
            + "    }\n"
            + "  ]\n"
            + "}\n"
            + "Rules: alt is at most 125 characters; it conveys the image's content or, for a linked image, its "
            + "purpose/destination; never starts with 'image of' / 'picture of' / 'photo of'; no keyword stuffing; "
            + "does not repeat an adjacent caption or heading verbatim. Mark decorative=true (with alt \"\") when the "
            + "image is purely aesthetic (background, divider, flourish) or fully redundant with adjacent text. "
            + "When the picture itself is not provided, infer from the context and say so in the reason (lower confidence). "
            + "Answer for every image id you received, in the same order.\n"
            + "LANGUAGE RULES: every \"alt\" MUST be written in %1$s (it is published to the page's visitors); "
            + "every \"reason\" MUST be written in %2$s (it is read by the editor).";

    @Reference
    private PageAuditConfigService configService;

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse res) throws IOException {
        if (isGuest()) {
            res.sendError(HttpServletResponse.SC_FORBIDDEN, "Authentication required");
            return;
        }

        JSONObject status = new JSONObject();
        status.put("enabled", configService.isAiEnabled());
        status.put("provider", configService.getProvider());
        status.put("model", configService.getModel());
        status.put("vision", supportsVision(configService.getProvider()));
        writeJson(res, HttpServletResponse.SC_OK, status);
    }

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse res) throws IOException {
        JahiaUser user = JCRSessionFactory.getInstance().getCurrentUser();
        if (user == null || "guest".equals(user.getUsername())) {
            res.sendError(HttpServletResponse.SC_FORBIDDEN, "Authentication required");
            return;
        }

        // CSRF hardening: require JSON (which forces a CORS preflight this endpoint
        // never answers) and reject cross-origin browser requests.
        String contentType = req.getContentType();
        if (contentType == null || !contentType.toLowerCase().startsWith("application/json")) {
            writeError(res, HttpServletResponse.SC_UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json");
            return;
        }

        if (!isSameOrigin(req)) {
            res.sendError(HttpServletResponse.SC_FORBIDDEN, "Cross-origin request rejected");
            return;
        }

        JSONObject payload;
        try {
            payload = new JSONObject(req.getReader().lines().collect(Collectors.joining("\n")));
        } catch (Exception e) {
            writeError(res, HttpServletResponse.SC_BAD_REQUEST, "Invalid JSON payload");
            return;
        }

        // Authorization: only run a review for a page the caller may actually read,
        // so the endpoint cannot be abused as an open LLM proxy by any authenticated principal.
        if (!canRead(payload.optString("path", ""))) {
            res.sendError(HttpServletResponse.SC_FORBIDDEN, "You must have read access to the audited page");
            return;
        }

        if (isRateLimited(user.getUsername())) {
            writeError(res, 429, "Too many AI review requests; please retry later");
            return;
        }

        if (!configService.isAiEnabled()) {
            writeError(res, HttpServletResponse.SC_SERVICE_UNAVAILABLE, "AI review is not configured");
            return;
        }

        // Server-defined tasks share the endpoint and its guards; the client
        // only picks which one, never the prompt.
        String task = payload.optString("task", "review").toLowerCase();
        String systemPrompt;
        String userContent;
        JSONArray images = new JSONArray();
        switch (task) {
            case "seo":
                systemPrompt = languagePrompt(SEO_ASSIST_PROMPT, payload);
                userContent = buildSeoAssistContent(payload);
                break;
            case "alt":
                systemPrompt = languagePrompt(ALT_TEXT_PROMPT, payload);
                userContent = buildAltContent(payload, images, supportsVision(configService.getProvider()));
                break;
            case "simplify":
                systemPrompt = languagePrompt(SIMPLIFY_PROMPT, payload);
                userContent = buildSimplifyContent(payload);
                break;
            default:
                task = "review";
                systemPrompt = SYSTEM_PROMPT;
                userContent = buildUserContent(payload);
        }

        String provider = configService.getProvider();
        String model = configService.getModel();

        String rawAnswer = null;
        try {
            JSONObject providerResult = callProvider(provider, model, systemPrompt, userContent, images);
            rawAnswer = providerResult.getString("text");
            JSONObject review;
            if ("seo".equals(task)) {
                review = parseSeoAssist(rawAnswer);
            } else if ("alt".equals(task)) {
                review = parseAltText(rawAnswer);
                review.put("vision", images.length() > 0);
            } else if ("simplify".equals(task)) {
                review = parseSimplify(rawAnswer);
            } else {
                review = parseReview(rawAnswer);
            }

            review.put("provider", provider);
            review.put("model", model);
            if (providerResult.optBoolean("truncated", false)) {
                review.put("truncated", true);
                logger.warn("AI {} answer truncated by AI_MAX_TOKENS ({}); complete items were salvaged",
                        task, configService.getMaxTokens());
            }

            long inputTokens = providerResult.optLong("inputTokens", -1);
            long outputTokens = providerResult.optLong("outputTokens", -1);
            if (inputTokens >= 0 && outputTokens >= 0) {
                JSONObject usage = new JSONObject();
                usage.put("inputTokens", inputTokens);
                usage.put("outputTokens", outputTokens);
                // Rates are configured per million tokens (AI_COST_*_PER_MTOKENS)
                double cost = (inputTokens / 1_000_000.0) * configService.getCostInputPerMTokens()
                        + (outputTokens / 1_000_000.0) * configService.getCostOutputPerMTokens();
                usage.put("cost", Math.round(cost * 10_000.0) / 10_000.0);
                usage.put("currency", "USD");
                review.put("usage", usage);
            }

            writeJson(res, HttpServletResponse.SC_OK, review);
        } catch (Exception e) {
            logger.error("AI {} failed", task, e);
            if (rawAnswer != null) {
                // Server-side only: the start of the unparseable answer is the one
                // clue to a prompt/model mismatch (prose preamble, refusal, empty content)
                logger.warn("Unparseable model answer ({} chars) starts with: {}", rawAnswer.length(),
                        rawAnswer.substring(0, Math.min(rawAnswer.length(), 500)).replaceAll("\\s+", " "));
            }

            writeError(res, HttpServletResponse.SC_BAD_GATEWAY, "AI review temporarily unavailable");
        }
    }

    private String buildUserContent(JSONObject payload) {
        StringBuilder sb = new StringBuilder();
        String pageLanguage = payload.optString("language", "en");
        String uiLanguage = payload.optString("uiLanguage", pageLanguage);
        sb.append("REPORT LANGUAGE: ").append(languageName(uiLanguage)).append('\n');
        sb.append("PAGE LANGUAGE: ").append(languageName(pageLanguage))
                .append(" (the page is meant to be in this language)\n");
        sb.append("PAGE PATH: ").append(payload.optString("path", "")).append('\n');
        sb.append("TITLE: ").append(payload.optString("title", "")).append('\n');
        sb.append("META DESCRIPTION: ").append(payload.optString("description", "")).append("\n\n");

        JSONArray findings = payload.optJSONArray("findings");
        if (findings != null && findings.length() > 0) {
            sb.append("AUTOMATED AUDIT DIGEST:\n");
            int lines = Math.min(findings.length(), MAX_DIGEST_LINES);
            for (int i = 0; i < lines; i++) {
                sb.append("- ").append(findings.optString(i, "")).append('\n');
            }

            sb.append('\n');
        }

        String text = payload.optString("text", "");
        if (text.length() > MAX_TEXT_CHARS) {
            text = text.substring(0, MAX_TEXT_CHARS) + "\n[... text truncated ...]";
        }

        sb.append("PAGE TEXT:\n").append(text);
        return sb.toString();
    }

    /** Formats a prompt template with %1$s = page language name, %2$s = report (UI) language name - a reference to "the input" is not followed reliably. */
    private String languagePrompt(String template, JSONObject payload) {
        String pageLanguage = payload.optString("language", "en");
        String uiLanguage = payload.optString("uiLanguage", pageLanguage);
        return String.format(template, languageName(pageLanguage), languageName(uiLanguage));
    }

    /**
     * Whether the provider's chat endpoint processes inline images. DeepSeek
     * accepts {@code image_url} parts but silently ignores them (prompt token
     * count does not grow), so attaching pictures there only wastes bandwidth
     * and misleads the editor.
     */
    private boolean supportsVision(String provider) {
        return "anthropic".equalsIgnoreCase(provider) || "openai".equalsIgnoreCase(provider);
    }

    /**
     * Input for the alt text task. When {@code vision} is true, fills
     * {@code images} with the validated inline pictures ({id, mediaType, data})
     * in the same order as the IMAGE #n blocks; otherwise every image is
     * described from context only.
     */
    private String buildAltContent(JSONObject payload, JSONArray images, boolean vision) {
        StringBuilder sb = new StringBuilder();
        sb.append("PAGE PATH: ").append(payload.optString("path", "")).append('\n');
        sb.append("PAGE TITLE: ").append(payload.optString("title", "")).append("\n\n");

        JSONArray items = payload.optJSONArray("images");
        int count = items == null ? 0 : Math.min(items.length(), MAX_ALT_IMAGES);
        for (int i = 0; i < count; i++) {
            JSONObject img = items.optJSONObject(i);
            if (img == null) {
                continue;
            }

            int id = img.optInt("id", i);
            sb.append("IMAGE #").append(id).append('\n');
            sb.append("- file: ").append(clipTo(img.optString("filename", ""), 200)).append('\n');
            sb.append("- rendered size: ").append(img.optInt("width", 0)).append('x').append(img.optInt("height", 0)).append('\n');
            if (!img.optString("linkTarget", "").isBlank()) {
                sb.append("- is a link to: ").append(clipTo(img.optString("linkTarget", ""), 200)).append('\n');
            }

            appendIfPresent(sb, "caption", img.optString("caption", ""));
            appendIfPresent(sb, "nearest heading", img.optString("heading", ""));
            appendIfPresent(sb, "surrounding text", img.optString("context", ""));

            String data = img.optString("data", "");
            String mediaType = img.optString("mediaType", "");
            boolean validType = mediaType.equals("image/jpeg") || mediaType.equals("image/png") || mediaType.equals("image/webp");
            if (vision && !data.isBlank() && validType && data.length() <= MAX_IMAGE_BASE64_CHARS && data.matches("[A-Za-z0-9+/=]+")) {
                images.put(new JSONObject().put("id", id).put("mediaType", mediaType).put("data", data));
                sb.append("- picture: attached below as IMAGE #").append(id).append('\n');
            } else {
                sb.append("- picture: not available (infer from context)\n");
            }

            sb.append('\n');
        }

        return sb.toString();
    }

    /** Input for the plain-language task: the hardest sentences, numbered. */
    private String buildSimplifyContent(JSONObject payload) {
        StringBuilder sb = new StringBuilder();
        sb.append("PAGE PATH: ").append(payload.optString("path", "")).append("\n\n");
        JSONArray sentences = payload.optJSONArray("sentences");
        int count = sentences == null ? 0 : Math.min(sentences.length(), MAX_SENTENCES);
        for (int i = 0; i < count; i++) {
            JSONObject s = sentences.optJSONObject(i);
            if (s == null) {
                continue;
            }

            sb.append("SENTENCE #").append(s.optInt("id", i)).append(" (").append(s.optInt("words", 0)).append(" words):\n")
                    .append(clipTo(s.optString("text", ""), 1500)).append("\n\n");
        }

        return sb.toString();
    }

    private void appendIfPresent(StringBuilder sb, String label, String value) {
        if (value != null && !value.isBlank()) {
            sb.append("- ").append(label).append(": ").append(clipTo(value, MAX_CONTEXT_CHARS)).append('\n');
        }
    }

    private String clipTo(String value, int max) {
        String trimmed = value == null ? "" : value.trim().replaceAll("\\s+", " ");
        return trimmed.length() > max ? trimmed.substring(0, max) : trimmed;
    }

    /** Input for the SEO assist task: current SEO state + headings + SEO findings + page text. */
    private String buildSeoAssistContent(JSONObject payload) {
        StringBuilder sb = new StringBuilder();
        String pageLanguage = payload.optString("language", "en");
        String uiLanguage = payload.optString("uiLanguage", pageLanguage);
        sb.append("PAGE LANGUAGE: ").append(languageName(pageLanguage)).append('\n');
        sb.append("REPORT LANGUAGE: ").append(languageName(uiLanguage)).append('\n');
        sb.append("PAGE PATH: ").append(payload.optString("path", "")).append('\n');
        sb.append("CURRENT TITLE: ").append(payload.optString("title", "")).append('\n');
        sb.append("CURRENT META DESCRIPTION: ").append(payload.optString("description", "")).append("\n\n");

        JSONArray headings = payload.optJSONArray("headings");
        sb.append("CURRENT HEADINGS:\n");
        if (headings == null || headings.length() == 0) {
            sb.append("- (none)\n");
        } else {
            for (int i = 0; i < Math.min(headings.length(), MAX_HEADINGS_IN); i++) {
                JSONObject h = headings.optJSONObject(i);
                if (h != null) {
                    sb.append("- ").append(h.optString("level", "h?")).append(": ")
                            .append(h.optString("text", "")).append('\n');
                }
            }
        }

        sb.append('\n');

        JSONArray ctas = payload.optJSONArray("ctas");
        if (ctas != null && ctas.length() > 0) {
            sb.append("WEAK CALLS TO ACTION (generic link/button labels):\n");
            for (int i = 0; i < Math.min(ctas.length(), MAX_CTAS); i++) {
                JSONObject cta = ctas.optJSONObject(i);
                if (cta == null) {
                    continue;
                }

                sb.append("- \"").append(clipTo(cta.optString("text", ""), 100)).append('"');
                if (cta.optInt("count", 1) > 1) {
                    sb.append(" (used ").append(cta.optInt("count", 1)).append(" times)");
                }

                if (!cta.optString("target", "").isBlank()) {
                    sb.append(" -> ").append(clipTo(cta.optString("target", ""), 150));
                }

                if (!cta.optString("context", "").isBlank()) {
                    sb.append(" | context: ").append(clipTo(cta.optString("context", ""), 300));
                }

                sb.append('\n');
            }

            sb.append('\n');
        }

        JSONArray findings = payload.optJSONArray("findings");
        if (findings != null && findings.length() > 0) {
            sb.append("AUTOMATED SEO FINDINGS:\n");
            for (int i = 0; i < Math.min(findings.length(), MAX_DIGEST_LINES); i++) {
                sb.append("- ").append(findings.optString(i, "")).append('\n');
            }

            sb.append('\n');
        }

        String text = payload.optString("text", "");
        if (text.length() > MAX_TEXT_CHARS) {
            text = text.substring(0, MAX_TEXT_CHARS) + "\n[... text truncated ...]";
        }

        sb.append("PAGE TEXT:\n").append(text);
        return sb.toString();
    }

    /** Resolves an ISO code to an explicit language name - models follow "write in French" far more reliably than "write in fr". */
    private String languageName(String isoCode) {
        String code = isoCode == null ? "en" : isoCode.toLowerCase();
        if (code.startsWith("fr")) {
            return "French";
        }

        if (code.startsWith("de")) {
            return "German";
        }

        if (code.startsWith("es")) {
            return "Spanish";
        }

        if (code.startsWith("it")) {
            return "Italian";
        }

        if (code.startsWith("pt")) {
            return "Portuguese";
        }

        if (code.startsWith("nl")) {
            return "Dutch";
        }

        if (code.startsWith("en")) {
            return "English";
        }

        return isoCode;
    }

    /**
     * Returns {text, inputTokens, outputTokens, truncated} extracted from the
     * provider envelope. {@code images} ({id, mediaType, data}) are attached as
     * multimodal parts after the text in each provider's own format; an empty
     * array keeps the plain-string content every provider accepts.
     */
    private JSONObject callProvider(String provider, String model, String basePrompt, String userContent, JSONArray images) throws IOException {
        String systemPrompt = basePrompt;
        String appendix = configService.getPromptAppendix();
        if (!appendix.isBlank()) {
            systemPrompt += "\n\nAdditional site-specific instructions:\n" + appendix;
        }

        JSONObject body = new JSONObject();
        body.put("model", model);
        body.put("max_tokens", configService.getMaxTokens());

        boolean openAiStyle = "openai".equalsIgnoreCase(provider) || "deepseek".equalsIgnoreCase(provider);
        Object userMessage = userContent;
        if (images.length() > 0) {
            JSONArray parts = new JSONArray();
            parts.put(new JSONObject().put("type", "text").put("text", userContent));
            for (int i = 0; i < images.length(); i++) {
                JSONObject img = images.getJSONObject(i);
                parts.put(new JSONObject().put("type", "text").put("text", "IMAGE #" + img.getInt("id") + ":"));
                if (openAiStyle) {
                    String dataUrl = "data:" + img.getString("mediaType") + ";base64," + img.getString("data");
                    parts.put(new JSONObject().put("type", "image_url")
                            .put("image_url", new JSONObject().put("url", dataUrl)));
                } else {
                    parts.put(new JSONObject().put("type", "image").put("source", new JSONObject()
                            .put("type", "base64")
                            .put("media_type", img.getString("mediaType"))
                            .put("data", img.getString("data"))));
                }
            }

            userMessage = parts;
        }

        String targetUrl;
        if (openAiStyle) {
            targetUrl = "openai".equalsIgnoreCase(provider) ? OPENAI_URL : DEEPSEEK_URL;
            JSONArray messages = new JSONArray();
            messages.put(new JSONObject().put("role", "system").put("content", systemPrompt));
            messages.put(new JSONObject().put("role", "user").put("content", userMessage));
            body.put("messages", messages);
            if ("deepseek".equalsIgnoreCase(provider)) {
                // DeepSeek V4 models reason by default: the hidden reasoning_content
                // consumes the max_tokens budget (empty answer) and the visible
                // answer tends to ignore the JSON-only instruction. Structured
                // extraction needs no chain-of-thought - disable it.
                body.put("thinking", new JSONObject().put("type", "disabled"));
            }
        } else {
            targetUrl = ANTHROPIC_URL;
            body.put("system", systemPrompt);
            JSONArray messages = new JSONArray();
            messages.put(new JSONObject().put("role", "user").put("content", userMessage));
            body.put("messages", messages);
        }

        HttpURLConnection conn = (HttpURLConnection) new URL(targetUrl).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(120_000);
        conn.setRequestProperty("Content-Type", "application/json");
        if ("anthropic".equalsIgnoreCase(provider)) {
            conn.setRequestProperty("x-api-key", configService.getApiKey());
            conn.setRequestProperty("anthropic-version", "2023-06-01");
        } else {
            conn.setRequestProperty("Authorization", "Bearer " + configService.getApiKey());
        }

        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }

        int status = conn.getResponseCode();
        InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        String response = stream == null ? "" : new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        conn.disconnect();

        if (status >= 400) {
            logger.warn("AI provider {} returned {}: {}", provider, status, response);
            throw new IOException("provider returned HTTP " + status);
        }

        JSONObject envelope = new JSONObject(response);
        JSONObject result = new JSONObject();
        JSONObject usage = envelope.optJSONObject("usage");
        if ("anthropic".equalsIgnoreCase(provider)) {
            result.put("text", envelope.getJSONArray("content").getJSONObject(0).getString("text"));
            result.put("truncated", "max_tokens".equals(envelope.optString("stop_reason")));
            if (usage != null) {
                result.put("inputTokens", usage.optLong("input_tokens", -1));
                result.put("outputTokens", usage.optLong("output_tokens", -1));
            }
        } else {
            JSONObject choice = envelope.getJSONArray("choices").getJSONObject(0);
            JSONObject message = choice.getJSONObject("message");
            String content = message.optString("content", "");
            if (content.isBlank() && message.has("reasoning_content")) {
                throw new IOException("model spent the whole max_tokens budget on reasoning and returned no answer"
                        + " - raise AI_MAX_TOKENS or use a non-reasoning model");
            }

            result.put("text", content);
            result.put("truncated", "length".equals(choice.optString("finish_reason")));
            if (usage != null) {
                result.put("inputTokens", usage.optLong("prompt_tokens", -1));
                result.put("outputTokens", usage.optLong("completion_tokens", -1));
            }
        }

        return result;
    }

    /**
     * Parses the model answer defensively (code fences, leading prose) and
     * re-serializes only whitelisted fields, so a malformed or malicious
     * answer can never inject unexpected structure into the client.
     */
    private JSONObject parseReview(String rawAnswer) {
        String cleaned = rawAnswer.trim();
        int start = cleaned.indexOf('{');
        if (start < 0) {
            throw new IllegalStateException("model did not return JSON");
        }

        JSONObject parsed = parseLenient(cleaned.substring(start));

        JSONObject safe = new JSONObject();
        safe.put("summary", parsed.optString("summary", ""));
        JSONArray safeRecs = new JSONArray();
        JSONArray recs = parsed.optJSONArray("recommendations");
        if (recs != null) {
            for (int i = 0; i < Math.min(recs.length(), MAX_RECOMMENDATIONS); i++) {
                JSONObject r = recs.optJSONObject(i);
                if (r == null || r.optString("title", "").isBlank()) {
                    continue;
                }

                JSONObject safeRec = new JSONObject();
                safeRec.put("severity", normalize(r.optString("severity", "moderate"),
                        new String[]{"critical", "serious", "moderate", "minor"}, "moderate"));
                safeRec.put("category", normalize(r.optString("category", "content"),
                        new String[]{"content", "seo", "accessibility", "performance", "ux",
                                "proofreading", "factuality", "consistency", "conversion",
                                "localization", "legal", "ecodesign"}, "content"));
                safeRec.put("title", r.optString("title", ""));
                safeRec.put("detail", r.optString("detail", ""));
                safeRec.put("wording", r.optString("wording", ""));
                safeRec.put("fix", clip(r.optString("fix", "")));
                safeRecs.put(safeRec);
            }
        }

        safe.put("recommendations", safeRecs);
        return safe;
    }

    /**
     * Whitelisting parser for the SEO assist answer: bounded arrays of plain
     * strings (length-capped), a normalized heading level, nothing else.
     */
    private JSONObject parseSeoAssist(String rawAnswer) {
        String cleaned = rawAnswer.trim();
        int start = cleaned.indexOf('{');
        if (start < 0) {
            throw new IllegalStateException("model did not return JSON");
        }

        JSONObject parsed = parseLenient(cleaned.substring(start));

        JSONObject safe = new JSONObject();
        safe.put("titles", safeStrings(parsed.optJSONArray("titles"), MAX_SUGGESTIONS));
        safe.put("metaDescriptions", safeStrings(parsed.optJSONArray("metaDescriptions"), MAX_SUGGESTIONS));

        JSONObject social = parsed.optJSONObject("social");
        JSONObject safeSocial = new JSONObject();
        safeSocial.put("title", clip(social == null ? "" : social.optString("title", "")));
        safeSocial.put("description", clip(social == null ? "" : social.optString("description", "")));
        safe.put("social", safeSocial);

        JSONObject keywords = parsed.optJSONObject("keywords");
        JSONObject safeKeywords = new JSONObject();
        safeKeywords.put("focus", clip(keywords == null ? "" : keywords.optString("focus", "")));
        safeKeywords.put("secondary", safeStrings(keywords == null ? null : keywords.optJSONArray("secondary"), MAX_KEYWORDS));
        safe.put("keywords", safeKeywords);

        JSONArray safeHeadings = new JSONArray();
        JSONArray headings = parsed.optJSONArray("headings");
        if (headings != null) {
            for (int i = 0; i < Math.min(headings.length(), MAX_HEADING_SUGGESTIONS); i++) {
                JSONObject h = headings.optJSONObject(i);
                if (h == null || h.optString("suggested", "").isBlank()) {
                    continue;
                }

                JSONObject safeH = new JSONObject();
                safeH.put("level", normalize(h.optString("level", "h2"), new String[]{"h1", "h2", "h3"}, "h2"));
                safeH.put("current", clip(h.optString("current", "")));
                safeH.put("suggested", clip(h.optString("suggested", "")));
                safeH.put("reason", clip(h.optString("reason", "")));
                safeHeadings.put(safeH);
            }
        }

        safe.put("headings", safeHeadings);

        JSONArray safeCtas = new JSONArray();
        JSONArray ctas = parsed.optJSONArray("ctas");
        if (ctas != null) {
            for (int i = 0; i < Math.min(ctas.length(), MAX_CTAS); i++) {
                JSONObject c = ctas.optJSONObject(i);
                if (c == null || c.optString("current", "").isBlank()) {
                    continue;
                }

                JSONArray suggestions = safeStrings(c.optJSONArray("suggestions"), MAX_SUGGESTIONS);
                if (suggestions.length() == 0) {
                    continue;
                }

                JSONObject safeC = new JSONObject();
                safeC.put("current", clip(c.optString("current", "")));
                safeC.put("suggestions", suggestions);
                safeC.put("reason", clip(c.optString("reason", "")));
                safeCtas.put(safeC);
            }
        }

        safe.put("ctas", safeCtas);
        return safe;
    }

    /** Whitelisting parser for the plain-language answer: bounded list of {id, rewrite, reason}. */
    private JSONObject parseSimplify(String rawAnswer) {
        String cleaned = rawAnswer.trim();
        int start = cleaned.indexOf('{');
        if (start < 0) {
            throw new IllegalStateException("model did not return JSON");
        }

        JSONObject parsed = parseLenient(cleaned.substring(start));
        JSONArray safeSentences = new JSONArray();
        JSONArray sentences = parsed.optJSONArray("sentences");
        if (sentences != null) {
            for (int i = 0; i < Math.min(sentences.length(), MAX_SENTENCES); i++) {
                JSONObject s = sentences.optJSONObject(i);
                if (s == null || !s.has("id") || s.optString("rewrite", "").isBlank()) {
                    continue;
                }

                JSONObject safeS = new JSONObject();
                safeS.put("id", s.optInt("id", -1));
                safeS.put("rewrite", clipTo(s.optString("rewrite", ""), 1500));
                safeS.put("reason", clip(s.optString("reason", "")));
                safeSentences.put(safeS);
            }
        }

        JSONObject safe = new JSONObject();
        safe.put("sentences", safeSentences);
        return safe;
    }

    /** Whitelisting parser for the alt text answer: bounded list of {id, decorative, alt, reason}. */
    private JSONObject parseAltText(String rawAnswer) {
        String cleaned = rawAnswer.trim();
        int start = cleaned.indexOf('{');
        if (start < 0) {
            throw new IllegalStateException("model did not return JSON");
        }

        JSONObject parsed = parseLenient(cleaned.substring(start));
        JSONArray safeImages = new JSONArray();
        JSONArray images = parsed.optJSONArray("images");
        if (images != null) {
            for (int i = 0; i < Math.min(images.length(), MAX_ALT_IMAGES); i++) {
                JSONObject img = images.optJSONObject(i);
                if (img == null || !img.has("id")) {
                    continue;
                }

                JSONObject safeImg = new JSONObject();
                safeImg.put("id", img.optInt("id", -1));
                boolean decorative = img.optBoolean("decorative", false);
                safeImg.put("decorative", decorative);
                safeImg.put("alt", decorative ? "" : clip(img.optString("alt", "")));
                safeImg.put("reason", clip(img.optString("reason", "")));
                safeImages.put(safeImg);
            }
        }

        JSONObject safe = new JSONObject();
        safe.put("images", safeImages);
        return safe;
    }

    private JSONArray safeStrings(JSONArray source, int max) {
        JSONArray out = new JSONArray();
        if (source == null) {
            return out;
        }

        for (int i = 0; i < source.length() && out.length() < max; i++) {
            String value = clip(source.optString(i, ""));
            if (!value.isBlank()) {
                out.put(value);
            }
        }

        return out;
    }

    private String clip(String value) {
        String trimmed = value == null ? "" : value.trim();
        return trimmed.length() > MAX_SUGGESTION_CHARS ? trimmed.substring(0, MAX_SUGGESTION_CHARS) : trimmed;
    }

    /**
     * Parses the model JSON, salvaging answers truncated by the max_tokens
     * limit: cut back to the last complete recommendation object and close
     * the array and root object. Complete recommendations are recovered
     * instead of failing the whole review.
     */
    private JSONObject parseLenient(String raw) {
        int end = raw.lastIndexOf('}');
        if (end > 0) {
            try {
                return new JSONObject(raw.substring(0, end + 1));
            } catch (Exception e) {
                // Fall through to truncation salvage
            }
        }

        int idx = raw.lastIndexOf("},");
        while (idx > 0) {
            try {
                return new JSONObject(raw.substring(0, idx + 1) + "]}");
            } catch (Exception e) {
                idx = raw.lastIndexOf("},", idx - 1);
            }
        }

        throw new IllegalStateException("model returned malformed JSON");
    }

    private String normalize(String value, String[] allowed, String fallback) {
        for (String a : allowed) {
            if (a.equalsIgnoreCase(value)) {
                return a;
            }
        }

        return fallback;
    }

    /** True when the current user may read the audited node (binds the endpoint to real editorial access). */
    private boolean canRead(String path) {
        if (path == null || path.isBlank() || !path.startsWith("/")) {
            return false;
        }

        try {
            JCRSessionWrapper session = JCRSessionFactory.getInstance().getCurrentUserSession();
            return session.nodeExists(path) && session.getNode(path).hasPermission("jcr:read");
        } catch (Exception e) {
            return false;
        }
    }

    /** Rejects cross-origin browser requests; an absent Origin/Referer means a non-browser caller (no CSRF risk). */
    private boolean isSameOrigin(HttpServletRequest req) {
        String candidate = req.getHeader("Origin");
        if (candidate == null) {
            candidate = req.getHeader("Referer");
        }

        if (candidate == null) {
            return true;
        }

        try {
            String candidateHost = new URL(candidate).getHost();
            String host = req.getHeader("Host");
            String requestHost = host != null ? host.split(":")[0] : req.getServerName();
            return candidateHost.equalsIgnoreCase(requestHost);
        } catch (Exception e) {
            return false;
        }
    }

    /** Per-user sliding-window limiter over RATE_WINDOW_MS. */
    private boolean isRateLimited(String user) {
        long now = System.currentTimeMillis();
        Deque<Long> window = callWindows.computeIfAbsent(user, k -> new ArrayDeque<>());
        synchronized (window) {
            while (!window.isEmpty() && now - window.peekFirst() > RATE_WINDOW_MS) {
                window.pollFirst();
            }

            if (window.size() >= RATE_MAX_CALLS) {
                return true;
            }

            window.addLast(now);
            return false;
        }
    }

    private boolean isGuest() {
        JahiaUser user = JCRSessionFactory.getInstance().getCurrentUser();
        return user == null || "guest".equals(user.getUsername());
    }

    private void writeJson(HttpServletResponse res, int status, JSONObject json) throws IOException {
        res.setStatus(status);
        res.setContentType("application/json;charset=UTF-8");
        res.getWriter().write(json.toString());
    }

    private void writeError(HttpServletResponse res, int status, String message) throws IOException {
        writeJson(res, status, new JSONObject().put("error", message));
    }
}
