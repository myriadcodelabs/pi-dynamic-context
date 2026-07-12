/**
 * pi-dynamic-context Extension
 *
 * Domain-aware dynamic context management for Pi.
 *
 * Current behavior:
 * - Before each prompt, the extension automatically selects the best domain
 *   based on the user's prompt and existing stored context.
 * - The selected domain is transient/per-prompt and is not persisted.
 * - Before each provider request, the extension rewrites the final provider
 *   payload so prior input history is replaced by the latest dynamic-context
 *   summary plus the current turn. The full session history remains persisted;
 *   only the provider-bound payload is compacted/replaced.
 * - Context extraction persists curated context entries, grouped by domain,
 *   in the current session.
 * - At the end of each agent completion, the extension extracts context for
 *   the selected domain via a direct model call and stores it in the session.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DomainDefinition {
  name: string;
  description: string;
  extractionPrompt: string;
  injectionFormat: string;
}

interface DomainConfig {
  domains: DomainDefinition[];
}

interface DomainContextState {
  contextText: string;
  lastExtractedAt: number;
  extractionCount: number;
}

interface StoreContextDetails {
  domainName: string;
  contextText: string;
  extractedAt: number;
  extractionCount: number;
  lastExtractedEntryId?: string | null;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface AgentMessageLike {
  role?: string;
  content?: unknown;
  customType?: string;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
}

interface SessionEntry {
  id?: string;
  type: string;
  customType?: string;
  data?: unknown;
  message?: AgentMessageLike;
}

// ---------------------------------------------------------------------------
// Load domain config
// ---------------------------------------------------------------------------

function loadDomainConfig(): DomainConfig {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const configPath = join(__dirname, "domains.json");
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as DomainConfig;
}

function findDomain(domains: DomainDefinition[], name: string): DomainDefinition | undefined {
  return domains.find((d) => d.name === name);
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const domainConfig = loadDomainConfig();
  const domainNames = domainConfig.domains.map((d) => d.name);

  // Transient, selected automatically for each prompt. Not persisted.
  let currentDomain: string | null = null;

  // Persisted context, reconstructed from custom session entries.
  const contextsByDomain = new Map<string, DomainContextState>();

  // Global extraction cursor: avoids reprocessing already-extracted turns.
  let lastExtractedEntryId: string | null = null;
  let totalExtractionCount = 0;
  let isExtracting = false;

  // -----------------------------------------------------------------------
  // State reconstruction from session entries
  // -----------------------------------------------------------------------

  const reconstructState = (ctx: ExtensionContext) => {
    currentDomain = null; // Important: domain is per-prompt and not persisted.
    contextsByDomain.clear();
    lastExtractedEntryId = null;
    totalExtractionCount = 0;

    for (const entry of ctx.sessionManager.getBranch() as unknown as SessionEntry[]) {
      if (entry.type !== "custom" || entry.customType !== "dynamic-context-extraction") continue;

      const data = entry.data as StoreContextDetails | undefined;
      if (!data?.domainName || typeof data.contextText !== "string") continue;

      contextsByDomain.set(data.domainName, {
        contextText: data.contextText,
        lastExtractedAt: data.extractedAt,
        extractionCount: data.extractionCount,
      });

      totalExtractionCount++;
      // Use the custom entry itself as the cursor when reconstructing. New user
      // turns will be appended after it, and custom entries are ignored by text
      // serialization anyway.
      lastExtractedEntryId = entry.id ?? data.lastExtractedEntryId ?? null;
    }
  };

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  // -----------------------------------------------------------------------
  // Tool: get_dynamic_context
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "get_dynamic_context",
    label: "Get Context",
    description:
      "Get the current dynamic context state: the transient domain selected for the current prompt and stored context grouped by domain.",
    promptSnippet: "Inspect the current dynamic context state",
    promptGuidelines: [
      "Use get_dynamic_context to inspect what domain was auto-selected for the current prompt and what context is stored by domain.",
    ],
    parameters: Type.Object({}),

    async execute() {
      const sections: string[] = [];
      sections.push(`**Domain Selection Mode:** automatic per prompt`);
      sections.push(`**Current Prompt Domain:** ${currentDomain ?? "not selected yet"}`);
      sections.push(`**Total Extraction Entries:** ${totalExtractionCount}`);
      sections.push("");

      if (contextsByDomain.size === 0) {
        sections.push("**Stored Context:** (empty - no context extracted yet)");
      } else {
        sections.push("**Stored Context By Domain:**");
        for (const [domainName, state] of contextsByDomain.entries()) {
          sections.push("");
          sections.push(`### ${domainName}`);
          sections.push(`- Extractions: ${state.extractionCount}`);
          sections.push(`- Last Extraction: ${new Date(state.lastExtractedAt).toISOString()}`);
          sections.push("");
          sections.push(state.contextText);
        }
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
        details: {
          mode: "automatic-per-prompt",
          currentDomain,
          contexts: Object.fromEntries(contextsByDomain.entries()),
          totalExtractionCount,
        },
      };
    },

    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("get_dynamic_context")), 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as {
        currentDomain?: string | null;
        contexts?: Record<string, DomainContextState>;
        totalExtractionCount?: number;
      };
      const domainCount = details.contexts ? Object.keys(details.contexts).length : 0;
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("accent", `Auto domain: ${details.currentDomain ?? "not selected"}`) +
          theme.fg("dim", ` | Stored domains: ${domainCount}`) +
          theme.fg("dim", ` | Extractions: ${details.totalExtractionCount ?? 0}`),
        0,
        0,
      );
    },
  });

  // -----------------------------------------------------------------------
  // Command: /dynamic-context
  // -----------------------------------------------------------------------

  pi.registerCommand("dynamic-context", {
    description: "Show current dynamic context state",
    handler: async (_args, ctx) => {
      const storedDomains = [...contextsByDomain.keys()].join(", ") || "none";
      ctx.ui.notify(
        `Auto-domain mode | Current: ${currentDomain ?? "not selected"} | Stored domains: ${storedDomains} | Extractions: ${totalExtractionCount}`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------------
  // Conversation serialization helpers
  // -----------------------------------------------------------------------

  const extractTextParts = (content: unknown): string[] => {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];

    const textParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const block = part as ContentBlock;
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }
    return textParts;
  };

  const extractToolCallLines = (content: unknown): string[] => {
    if (!Array.isArray(content)) return [];

    const toolCalls: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const block = part as ContentBlock;
      if (block.type === "toolCall" && typeof block.name === "string") {
        const args = block.arguments ?? {};
        toolCalls.push(`[Tool call: ${block.name}(${JSON.stringify(args)})]`);
      }
    }
    return toolCalls;
  };

  const buildConversationText = (entries: SessionEntry[]): string => {
    const sections: string[] = [];

    for (const entry of entries) {
      if (entry.type !== "message" || !entry.message?.role) continue;

      const role = entry.message.role;
      const isUser = role === "user";
      const isAssistant = role === "assistant";
      if (!isUser && !isAssistant) continue;

      const entryLines: string[] = [];
      const textParts = extractTextParts(entry.message.content);
      if (textParts.length > 0) {
        const roleLabel = isUser ? "User" : "Assistant";
        const messageText = textParts.join("\n").trim();
        if (messageText.length > 0) entryLines.push(`${roleLabel}: ${messageText}`);
      }
      if (isAssistant) entryLines.push(...extractToolCallLines(entry.message.content));
      if (entryLines.length > 0) sections.push(entryLines.join("\n"));
    }

    return sections.join("\n\n");
  };

  const getNewEntriesSince = (branch: SessionEntry[], sinceId: string | null): SessionEntry[] => {
    if (!sinceId) return branch;
    const sinceIndex = branch.findIndex((e) => e.id === sinceId);
    if (sinceIndex === -1) return branch;
    return branch.slice(sinceIndex + 1);
  };

  const hasNewUserMessages = (entries: SessionEntry[]): boolean =>
    entries.some((e) => e.type === "message" && e.message?.role === "user");

  const getLatestUserText = (entries: SessionEntry[]): string => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      return extractTextParts(entry.message.content).join("\n").trim();
    }
    return "";
  };

  // -----------------------------------------------------------------------
  // Model helpers
  // -----------------------------------------------------------------------

  const getActiveModel = async (ctx: ExtensionContext) => {
    if (!ctx.model) return undefined;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) return undefined;

    return { model: ctx.model, auth };
  };

  // -----------------------------------------------------------------------
  // Automatic domain selection
  // -----------------------------------------------------------------------

  const fallbackSelectDomain = (prompt: string): string => {
    const text = prompt.toLowerCase();
    if (/\b(code|coding|bug|debug|refactor|typescript|javascript|python|file|test|build|compile|api|function|class|repo|git)\b/.test(text)) return "coding";
    if (/\b(research|source|paper|study|literature|evidence|investigate|find information|learn about)\b/.test(text)) return "research";
    if (/\b(write|draft|edit|proofread|article|blog|document|tone|audience|rewrite|copy)\b/.test(text)) return "writing";
    if (/\b(analyze|analysis|plan|strategy|options|pros|cons|risk|decision|framework|tradeoff)\b/.test(text)) return "analysis";
    return "general";
  };

  const selectDomainForPrompt = async (prompt: string, ctx: ExtensionContext): Promise<string> => {
    const fallback = fallbackSelectDomain(prompt);
    const active = await getActiveModel(ctx);
    if (!active) return fallback;

    const { model, auth } = active;

    const domainDescriptions = domainConfig.domains
      .map((d) => `- ${d.name}: ${d.description}`)
      .join("\n");

    const storedContextHints = [...contextsByDomain.entries()]
      .map(([domainName, state]) => `## ${domainName}\n${state.contextText.slice(0, 800)}`)
      .join("\n\n") || "(none)";

    const selectionPrompt = [
      "Select the single best domain for the user's next prompt.",
      "Return ONLY the domain name, with no explanation.",
      "",
      "Available domains:",
      domainDescriptions,
      "",
      "Stored context hints by domain:",
      storedContextHints,
      "",
      "User prompt:",
      prompt,
    ].join("\n");

    try {
      const response = await complete(
        model,
        {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: selectionPrompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: 16,
        },
      );

      const text = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim()
        .toLowerCase();

      const selected = domainNames.find((name) => text.includes(name));
      return selected ?? fallback;
    } catch {
      return fallback;
    }
  };

  // -----------------------------------------------------------------------
  // Event: before_agent_start → select domain for this prompt
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    currentDomain = await selectDomainForPrompt(event.prompt, ctx);
    ctx.ui.setStatus("dynctx", `Auto domain: ${currentDomain}`);
  });

  const buildDynamicContextText = (): string | null => {
    if (!currentDomain) return null;

    const domain = findDomain(domainConfig.domains, currentDomain);
    if (!domain) return null;

    const domainState = contextsByDomain.get(currentDomain);

    const domainHeader = [
      "## Dynamic Context Domain",
      "",
      `Selected domain for this prompt: ${currentDomain}`,
      `Domain description: ${domain.description}`,
      "",
      "The domain is selected automatically for this prompt only and is not persisted as session state.",
    ].join("\n");

    const contextBlock = domainState?.contextText
      ? domain.injectionFormat
          .replace("{domainName}", currentDomain)
          .replace("{context}", domainState.contextText)
      : `## Dynamic Context (${currentDomain})\n\nNo stored context exists yet for this domain.`;

    return domainHeader + "\n\n" + contextBlock;
  };

  const getProviderItemRole = (item: unknown): string | undefined => {
    if (!item || typeof item !== "object") return undefined;
    const role = (item as { role?: unknown }).role;
    return typeof role === "string" ? role : undefined;
  };

  const isDynamicContextProviderItem = (item: unknown): boolean => {
    if (!item || typeof item !== "object") return false;
    const content = (item as { content?: unknown }).content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => {
              if (!part || typeof part !== "object") return "";
              const p = part as { text?: unknown };
              return typeof p.text === "string" ? p.text : "";
            })
            .join("\n")
        : "";
    return text.includes("## Dynamic Context Domain") && text.includes("## Dynamic Context (");
  };

  const makeOpenAIResponsesContextItem = (text: string) => ({
    role: "user",
    content: [{ type: "input_text", text }],
  });

  const makeChatContextItem = (text: string) => ({
    role: "user",
    content: text,
  });

  const compactProviderItems = <T>(items: T[], dynamicItem: T): T[] => {
    const withoutOldDynamicContext = items.filter((item) => !isDynamicContextProviderItem(item));
    const lastUserIndex = withoutOldDynamicContext
      .map((item) => getProviderItemRole(item))
      .lastIndexOf("user");

    if (lastUserIndex === -1) return [dynamicItem];
    return [dynamicItem, ...withoutOldDynamicContext.slice(lastUserIndex)];
  };

  // -----------------------------------------------------------------------
  // Event: before_provider_request → replace provider-bound history
  // -----------------------------------------------------------------------

  pi.on("before_provider_request", (event) => {
    const dynamicContextText = buildDynamicContextText();
    if (!dynamicContextText) return;

    const payload = event.payload as Record<string, unknown>;

    if (Array.isArray(payload.input)) {
      return {
        ...payload,
        input: compactProviderItems(payload.input, makeOpenAIResponsesContextItem(dynamicContextText)),
      };
    }

    if (Array.isArray(payload.messages)) {
      return {
        ...payload,
        messages: compactProviderItems(payload.messages, makeChatContextItem(dynamicContextText)),
      };
    }
  });

  // -----------------------------------------------------------------------
  // Event: agent_settled → extract context for selected domain
  // -----------------------------------------------------------------------

  pi.on("agent_settled", async (_event, ctx) => {
    if (isExtracting) return;

    const branch = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
    const newEntries = getNewEntriesSince(branch, lastExtractedEntryId);
    if (!hasNewUserMessages(newEntries)) return;

    if (!currentDomain) {
      currentDomain = fallbackSelectDomain(getLatestUserText(newEntries));
    }

    const domain = findDomain(domainConfig.domains, currentDomain);
    if (!domain) return;

    const conversationText = buildConversationText(newEntries);
    if (conversationText.trim().length < 50) return;

    const active = await getActiveModel(ctx);
    if (!active) {
      ctx.ui.notify("Dynamic context: no active model available for extraction", "warning");
      return;
    }

    const { model, auth } = active;

    isExtracting = true;
    ctx.ui.setStatus("dynctx", `Extracting ${currentDomain} context...`);

    try {
      const previousContext = contextsByDomain.get(currentDomain)?.contextText ?? "";
      const previousContextNote = previousContext
        ? `\n\n## Previous context for ${currentDomain} (update/extend this — do NOT repeat verbatim):\n${previousContext}`
        : "";

      const prompt = domain.extractionPrompt
        .replace("{conversation}", conversationText)
        .replace("{previousContext}", previousContextNote);

      const response = await complete(
        model,
        {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: 4096,
        },
      );

      const extractedText = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (!extractedText) {
        ctx.ui.setStatus("dynctx", `Auto domain: ${currentDomain}`);
        return;
      }

      const previousState = contextsByDomain.get(currentDomain);
      const extractionCount = (previousState?.extractionCount ?? 0) + 1;
      const extractedAt = Date.now();

      contextsByDomain.set(currentDomain, {
        contextText: extractedText,
        lastExtractedAt: extractedAt,
        extractionCount,
      });
      totalExtractionCount++;

      const lastBranchEntry = branch[branch.length - 1];
      lastExtractedEntryId = lastBranchEntry?.id ?? null;

      pi.appendEntry("dynamic-context-extraction", {
        domainName: currentDomain,
        contextText: extractedText,
        extractedAt,
        extractionCount,
        lastExtractedEntryId,
      } satisfies StoreContextDetails);

      ctx.ui.setStatus(
        "dynctx",
        `Auto domain: ${currentDomain} | Extractions: ${totalExtractionCount}`,
      );
      ctx.ui.notify(
        `Dynamic context extracted (${currentDomain}, ${extractedText.length} chars)`,
        "info",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Dynamic context extraction failed: ${message}`, "error");
      ctx.ui.setStatus("dynctx", `Auto domain: ${currentDomain}`);
    } finally {
      isExtracting = false;
    }
  });

  // -----------------------------------------------------------------------
  // Notify on startup
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const storedDomains = [...contextsByDomain.keys()].join(", ");
    ctx.ui.setStatus(
      "dynctx",
      storedDomains ? `Auto domain ready | Stored: ${storedDomains}` : "Auto domain ready",
    );
  });
}
