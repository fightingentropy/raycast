import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  LaunchProps,
  getPreferenceValues,
  showToast,
  Toast,
} from "@raycast/api";
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parse as parseHtml } from "node-html-parser";

const execAsync = promisify(exec);
const MAX_BIRD_STDIO_BYTES = 512 * 1024;
const MAX_BIRD_COMMAND_TIMEOUT_MS = 20_000;
const MAX_YT_DLP_STDIO_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_HTML_BYTES = 2_000_000;
const MAX_YOUTUBE_WEB_HTML_BYTES = 2_000_000;
const MAX_ARTICLE_TEXT_CHARS = 120_000;
const MAX_MEDIA_TRANSCRIPT_CHARS = 12_000;
const SHORT_CONTENT_BYPASS_MAX_CHARS = 700;
const MAX_YOUTUBE_DESCRIPTION_CHARS = 20_000;
const APIFY_YOUTUBE_TRANSCRIPT_ACTOR = "faVsWy9VTSNVIhWpR";
const APIFY_TIMEOUT_MS = 45_000;
const BUN_BIN_DIR = path.join(homedir(), ".bun/bin");
const BIRD_CANDIDATE_EXECUTABLES = [
  "bird",
  path.join(BUN_BIN_DIR, "bird"),
  "/opt/homebrew/bin/bird",
  "/usr/local/bin/bird",
];
const YT_DLP_CANDIDATE_EXECUTABLES = [
  "yt-dlp",
  "/opt/homebrew/bin/yt-dlp",
  "/usr/local/bin/yt-dlp",
];
const BIRD_BUN_CLI_PATH = path.join(
  homedir(),
  ".bun/install/global/node_modules/@steipete/bird/dist/cli.js",
);
const ARTICLE_ROOT_SELECTORS = [
  "article",
  "main",
  "[role='main']",
  ".article",
  ".post-content",
  ".entry-content",
  ".content",
  "#content",
  "#main",
];
const YOUTUBE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const YOUTUBE_REQUEST_HEADERS = {
  "User-Agent": YOUTUBE_USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
} as const;

type SourceKind = "x" | "youtube" | "article";

type Preferences = {
  codexModel?: string;
  codexUrl?: string;
  codexAuthFile?: string;
  birdCommand?: string;
  maxSourceChars?: string;
  apifyApiToken?: string;
};

type SourcePayload = {
  kind: SourceKind;
  url: string;
  title?: string;
  text: string;
};

type SummaryResult = {
  kind: SourceKind;
  url: string;
  title?: string;
  sourceLength: number;
  summary: string;
};

type BirdTweetMedia = {
  kind: "video" | "audio";
  urls: string[];
  preferredUrl: string | null;
  source: "extended_entities" | "card" | "entities";
};

type BirdPostPayload = {
  text: string;
  media: BirdTweetMedia | null;
};

type SubtitleTrack = {
  url: string;
  ext: string | null;
  lang: string;
};

type YouTubeCaptionTrack = {
  baseUrl: string;
  languageCode: string;
  kind: string | null;
};

type YouTubeWebContext = {
  watchUrl: string;
  html: string;
  playerResponse: Record<string, unknown> | null;
  title: string | null;
};

type YouTubeiTranscriptConfig = {
  apiKey: string;
  context: Record<string, unknown>;
  params: string;
  clientName: string | null;
  clientVersion: string | null;
  visitorData: string | null;
  pageCl: number | null;
  pageLabel: string | null;
};

export default function Command(
  props: LaunchProps<{ arguments: { url?: string } }>,
) {
  const preferences = getPreferenceValues<Preferences>();
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const autoRanUrlRef = useRef<string | null>(null);

  const initialUrl = useMemo(
    () => props.arguments?.url?.trim() ?? "",
    [props.arguments],
  );

  const summarize = useCallback(
    async (rawUrl: string) => {
      if (isLoading) {
        return;
      }

      const candidateUrl = rawUrl.trim();
      if (!candidateUrl) {
        await showToast({
          style: Toast.Style.Failure,
          title: "URL is required",
        });
        return;
      }

      setIsLoading(true);
      const progressToast = await showToast({
        style: Toast.Style.Animated,
        title: "Fetching source content",
      });

      try {
        const normalizedUrl = parseUrl(candidateUrl).toString();
        const payload = await buildSourcePayload(normalizedUrl, preferences);

        const bypassSummary = buildShortContentBypassSummary(payload);
        if (bypassSummary) {
          setResult({
            kind: payload.kind,
            url: payload.url,
            title: payload.title,
            sourceLength: payload.text.length,
            summary: bypassSummary,
          });

          progressToast.style = Toast.Style.Success;
          progressToast.title = "Summary ready";
          progressToast.message = "Bypassed model (source is already short)";
          return;
        }

        progressToast.title = "Summarizing with Codex";
        progressToast.message = payload.kind.toUpperCase();

        const summary = await summarizeWithCodex(payload, preferences);
        setResult({
          kind: payload.kind,
          url: payload.url,
          title: payload.title,
          sourceLength: payload.text.length,
          summary,
        });

        progressToast.style = Toast.Style.Success;
        progressToast.title = "Summary ready";
        progressToast.message = undefined;
      } catch (error) {
        progressToast.style = Toast.Style.Failure;
        progressToast.title = "Failed to summarize";
        progressToast.message =
          error instanceof Error ? error.message : String(error);
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, preferences],
  );

  useEffect(() => {
    const autoUrl = initialUrl.trim();
    if (!autoUrl || autoRanUrlRef.current === autoUrl) {
      return;
    }

    autoRanUrlRef.current = autoUrl;
    void summarize(autoUrl);
  }, [initialUrl, summarize]);

  if (result) {
    const markdown = renderSummaryMarkdown(result);
    return (
      <Detail
        markdown={markdown}
        actions={
          <ActionPanel>
            <Action.CopyToClipboard
              title="Copy Summary"
              content={result.summary}
            />
            <Action.OpenInBrowser
              title="Open Source"
              url={result.url}
              icon={Icon.Globe}
            />
            <Action
              title="Run Again"
              icon={Icon.RotateClockwise}
              onAction={() => {
                setResult(null);
                autoRanUrlRef.current = null;
                if (initialUrl.trim()) {
                  void summarize(initialUrl);
                }
              }}
            />
          </ActionPanel>
        }
      />
    );
  }

  return <Detail markdown="" isLoading={isLoading} />;
}

function renderSummaryMarkdown(result: SummaryResult): string {
  const lines: string[] = [];
  lines.push(`# KP Summary`);
  lines.push("");
  lines.push(`- **Type:** ${result.kind}`);
  if (result.title) lines.push(`- **Title:** ${escapeMarkdown(result.title)}`);
  lines.push(`- **URL:** ${result.url}`);
  lines.push(`- **Source chars:** ${result.sourceLength.toLocaleString()}`);
  lines.push("");
  lines.push(result.summary);
  return lines.join("\n");
}

function buildShortContentBypassSummary(payload: SourcePayload): string | null {
  const normalized = normalizeText(payload.text);
  if (!normalized || normalized.length > SHORT_CONTENT_BYPASS_MAX_CHARS) {
    return null;
  }

  return [
    "## TL;DR",
    "- Source content is already concise, so no model summarization was needed.",
    "",
    "## Key Points",
    normalized,
    "",
    "## Important Context",
    `- Source type: ${payload.kind}`,
    "",
    "## Actionable Takeaways",
    "- Read and use the original points directly.",
  ].join("\n");
}

async function buildSourcePayload(
  url: string,
  preferences: Preferences,
): Promise<SourcePayload> {
  const parsed = parseUrl(url);
  const kind = detectSourceKind(parsed.hostname);

  if (kind === "x") {
    const text = await fetchXPostWithBird(url, preferences.birdCommand);
    return { kind, url, text };
  }

  if (kind === "youtube") {
    const { title, text } = await fetchYouTubeTranscript(url, preferences);
    return { kind, url, title, text };
  }

  const { title, text } = await fetchArticle(url);
  return { kind: "article", url, title, text };
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    try {
      return new URL(`https://${value}`);
    } catch {
      throw new Error("Invalid URL");
    }
  }
}

function detectSourceKind(hostname: string): SourceKind {
  const host = hostname.toLowerCase();
  if (
    host === "x.com" ||
    host.endsWith(".x.com") ||
    host === "twitter.com" ||
    host.endsWith(".twitter.com")
  ) {
    return "x";
  }
  if (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be"
  ) {
    return "youtube";
  }
  return "article";
}

async function fetchXPostWithBird(
  url: string,
  birdCommandTemplate?: string,
): Promise<string> {
  const attempts = buildBirdCommandAttempts(url, birdCommandTemplate);
  let lastOutput = "";

  for (const command of attempts) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: MAX_BIRD_STDIO_BYTES,
        timeout: MAX_BIRD_COMMAND_TIMEOUT_MS,
        env: withBunInPath(process.env),
      });
      const raw = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (!raw) {
        continue;
      }
      const extracted = await extractPostText(raw);
      if (extracted && !looksLikeCliErrorText(extracted)) {
        return extracted;
      }
      lastOutput = raw;
    } catch (error) {
      const raw = getExecErrorOutput(error);
      const extracted = await extractPostText(raw);
      if (extracted && !looksLikeCliErrorText(extracted)) {
        return extracted;
      }
      if (raw) {
        lastOutput = raw;
      } else if (error instanceof Error) {
        lastOutput = error.message;
      }
    }
  }

  const fallback = await fetchXPostViaOEmbed(url);
  if (fallback) {
    return fallback;
  }

  const lastOutputExcerpt = collapseAndTruncate(lastOutput, 180);
  throw new Error(
    `Bird CLI failed to fetch the X post. ${
      lastOutputExcerpt ? `Last output: ${lastOutputExcerpt}. ` : ""
    }Run \`bird check\` to verify credentials, or set a working Bird Command Template in preferences.`,
  );
}

function buildBirdCommandAttempts(
  url: string,
  birdCommandTemplate?: string,
): string[] {
  const quotedUrl = shellQuote(url);
  const attempts: string[] = [];

  if (birdCommandTemplate?.trim()) {
    const template = birdCommandTemplate.trim();
    attempts.push(
      template.includes("{url}") ? template.replaceAll("{url}", url) : template,
    );
  }

  // Prefer direct Bun execution first to avoid wrapper/shebang PATH issues.
  const bunCandidates = [path.join(BUN_BIN_DIR, "bun"), "bun"];
  for (const bunPath of bunCandidates) {
    attempts.push(
      `${shellQuote(bunPath)} ${shellQuote(BIRD_BUN_CLI_PATH)} read ${quotedUrl} --json-full`,
    );
    attempts.push(
      `${shellQuote(bunPath)} ${shellQuote(BIRD_BUN_CLI_PATH)} ${quotedUrl} --json-full`,
    );
    attempts.push(
      `${shellQuote(bunPath)} ${shellQuote(BIRD_BUN_CLI_PATH)} read ${quotedUrl} --json`,
    );
    attempts.push(
      `${shellQuote(bunPath)} ${shellQuote(BIRD_BUN_CLI_PATH)} ${quotedUrl} --json`,
    );
  }

  const patterns = [
    "{bird} read {url} --json-full",
    "{bird} {url} --json-full",
    "{bird} read {url} --json",
    "{bird} {url} --json",
    "{bird} read {url}",
    "{bird} {url}",
    // Backward-compatible fallbacks for older syntax variants.
    "{bird} x post {url} --json",
    "{bird} post {url} --json",
    "{bird} x {url} --json",
  ];

  for (const birdPath of BIRD_CANDIDATE_EXECUTABLES) {
    for (const pattern of patterns) {
      attempts.push(
        pattern
          .replaceAll("{bird}", shellQuote(birdPath))
          .replaceAll("{url}", quotedUrl),
      );
    }
  }

  return Array.from(new Set(attempts));
}

async function extractPostText(raw: string): Promise<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const payload = extractBirdPostPayload(parsed);
    if (!payload?.text) {
      return null;
    }
    return await enrichPostTextWithMedia(payload);
  } catch {
    return trimmed || null;
  }
}

function extractBirdPostPayload(value: unknown): BirdPostPayload | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractBirdPostPayload(item);
      if (candidate) return candidate;
    }
    return null;
  }

  const obj = asRecord(value);
  if (!obj) {
    return null;
  }

  const legacy = asRecord(obj.legacy);
  const noteTweet = asRecord(
    asRecord(asRecord(obj.note_tweet)?.note_tweet_results)?.result,
  );
  const textCandidates = collectBirdTextCandidates(value);
  const mergedThreadText = mergeBirdTextCandidates(textCandidates);
  const text = firstNonEmptyString([
    mergedThreadText,
    ...textCandidates,
    asString(obj.text),
    asString(obj.full_text),
    asString(legacy?.text),
    asString(legacy?.full_text),
    asString(noteTweet?.text),
    asString(obj.content),
    findCandidateText(obj),
  ]);

  if (!text) {
    return null;
  }

  const media = extractMediaFromBirdRaw(obj._raw ?? obj);
  return {
    text: normalizeText(text),
    media,
  };
}

function mergeBirdTextCandidates(candidates: string[]): string | null {
  if (!candidates.length) {
    return null;
  }

  const selected: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length < 20) continue;
    if (selected.some((existing) => existing.includes(candidate))) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= 10) {
      break;
    }
  }

  if (selected.length === 0) {
    return null;
  }

  return selected.join("\n\n");
}

function collectBirdTextCandidates(root: unknown): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | null | undefined) => {
    if (!value) return;
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const obj = asRecord(value);
    if (!obj) return;

    const legacy = asRecord(obj.legacy);
    const noteTweet = asRecord(
      asRecord(asRecord(obj.note_tweet)?.note_tweet_results)?.result,
    );
    const quotedStatus = asRecord(obj.quoted_status_result);
    const quotedStatusResult = asRecord(quotedStatus?.result);

    push(asString(obj.full_text));
    push(asString(obj.text));
    push(asString(legacy?.full_text));
    push(asString(legacy?.text));
    push(asString(noteTweet?.text));
    push(asString(asRecord(obj.tweet)?.text));
    push(asString(asRecord(obj.post)?.text));
    push(asString(quotedStatusResult?.full_text));
    push(asString(quotedStatusResult?.text));

    for (const nested of Object.values(obj)) {
      visit(nested);
    }
  };

  visit(root);

  // Prefer longer candidates first and keep ordering deterministic.
  return [...candidates].sort((left, right) => right.length - left.length);
}

function extractMediaFromBirdRaw(raw: unknown): BirdTweetMedia | null {
  const root = asRecord(raw);
  if (!root) return null;

  const legacy = asRecord(root.legacy);
  const extended = asRecord(legacy?.extended_entities);
  const mediaEntries = asArray(extended?.media);
  if (mediaEntries && mediaEntries.length > 0) {
    const urls = new Set<string>();
    let preferredUrl: string | null = null;
    let preferredBitrate = -1;
    let kind: BirdTweetMedia["kind"] = "video";

    for (const entry of mediaEntries) {
      const media = asRecord(entry);
      const mediaType = asString(media?.type);
      if (mediaType === "audio") {
        kind = "audio";
      }
      if (
        mediaType !== "video" &&
        mediaType !== "animated_gif" &&
        mediaType !== "audio"
      ) {
        continue;
      }
      const videoInfo = asRecord(media?.video_info);
      const variants = asArray(videoInfo?.variants);
      if (!variants) continue;

      for (const variant of variants) {
        const variantRecord = asRecord(variant);
        const url = asString(variantRecord?.url);
        if (!url || !isLikelyVideoUrl(url)) continue;
        urls.add(url);

        const contentType = asString(variantRecord?.content_type) ?? "";
        const bitrate =
          typeof variantRecord?.bitrate === "number"
            ? variantRecord.bitrate
            : -1;
        if (contentType.includes("video/mp4") && bitrate >= preferredBitrate) {
          preferredBitrate = bitrate;
          preferredUrl = url;
        } else if (!preferredUrl) {
          preferredUrl = url;
        }
      }
    }

    if (urls.size > 0) {
      return {
        kind,
        urls: Array.from(urls),
        preferredUrl,
        source: "extended_entities",
      };
    }
  }

  const card = asRecord(root.card);
  const cardLegacy = asRecord(card?.legacy);
  const bindings = asArray(cardLegacy?.binding_values);
  if (bindings) {
    const urls = new Set<string>();
    for (const binding of bindings) {
      const record = asRecord(binding);
      const key = asString(record?.key);
      if (key !== "broadcast_url") continue;
      const value = asRecord(record?.value);
      const url = asString(value?.string_value);
      if (url && isLikelyVideoUrl(url)) urls.add(url);
    }
    if (urls.size > 0) {
      const preferredUrl = urls.values().next().value ?? null;
      return {
        kind: "video",
        urls: Array.from(urls),
        preferredUrl,
        source: "card",
      };
    }
  }

  const entities = asRecord(legacy?.entities);
  const entityUrls = asArray(entities?.urls);
  if (entityUrls) {
    const urls = new Set<string>();
    for (const entity of entityUrls) {
      const record = asRecord(entity);
      const expanded = asString(record?.expanded_url);
      if (!expanded || !isLikelyVideoUrl(expanded)) continue;
      urls.add(expanded);
    }
    if (urls.size > 0) {
      const preferredUrl = urls.values().next().value ?? null;
      return {
        kind: "video",
        urls: Array.from(urls),
        preferredUrl,
        source: "entities",
      };
    }
  }

  return null;
}

function isLikelyVideoUrl(url: string): boolean {
  return (
    url.includes("video.twimg.com") ||
    url.includes("/i/broadcasts/") ||
    url.endsWith(".m3u8") ||
    url.endsWith(".mp4")
  );
}

async function enrichPostTextWithMedia(
  payload: BirdPostPayload,
): Promise<string> {
  const media = payload.media;
  if (!media) {
    return payload.text;
  }

  const mediaUrl = media.preferredUrl ?? media.urls[0] ?? null;
  if (!mediaUrl) {
    return payload.text;
  }

  const mediaContext = `[Attached ${media.kind} media: ${mediaUrl}]`;
  const transcript = await tryExtractTranscriptFromXMedia(mediaUrl);
  if (!transcript) {
    return `${payload.text}\n\n${mediaContext}`;
  }

  return `${payload.text}\n\n${mediaContext}\n\nMedia transcript:\n${transcript}`;
}

let cachedYtDlpExecutable: string | null | undefined;

async function resolveYtDlpExecutable(): Promise<string | null> {
  if (cachedYtDlpExecutable !== undefined) {
    return cachedYtDlpExecutable;
  }

  for (const candidate of YT_DLP_CANDIDATE_EXECUTABLES) {
    try {
      await execAsync(`${shellQuote(candidate)} --version`, {
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: withBunInPath(process.env),
      });
      cachedYtDlpExecutable = candidate;
      return candidate;
    } catch {
      // Try next executable candidate.
    }
  }

  cachedYtDlpExecutable = null;
  return null;
}

async function tryExtractTranscriptFromXMedia(
  mediaUrl: string,
): Promise<string | null> {
  const ytDlpExecutable = await resolveYtDlpExecutable();
  if (!ytDlpExecutable) {
    return null;
  }

  try {
    const { stdout } = await execAsync(
      `${shellQuote(ytDlpExecutable)} -J --no-warnings ${shellQuote(mediaUrl)}`,
      {
        timeout: MAX_BIRD_COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_YT_DLP_STDIO_BYTES,
        env: withBunInPath(process.env),
      },
    );

    const metadata = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const track = pickSubtitleTrackFromYtDlpMetadata(metadata);
    if (!track) {
      return null;
    }

    const response = await fetch(track.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      return null;
    }

    const raw = await readResponseTextWithLimit(response, 1_000_000);
    const text = parseSubtitlePayloadToText(raw, track.ext);
    if (!text) {
      return null;
    }

    return limitText(text, MAX_MEDIA_TRANSCRIPT_CHARS);
  } catch {
    return null;
  }
}

function pickSubtitleTrackFromYtDlpMetadata(
  metadata: Record<string, unknown>,
): SubtitleTrack | null {
  const subtitles = asRecord(metadata.subtitles);
  const automatic = asRecord(metadata.automatic_captions);
  return (
    pickSubtitleTrackFromLanguageMap(subtitles) ??
    pickSubtitleTrackFromLanguageMap(automatic)
  );
}

function pickSubtitleTrackFromLanguageMap(
  languageMap: Record<string, unknown> | null,
): SubtitleTrack | null {
  if (!languageMap) {
    return null;
  }

  const orderedLanguages = Object.keys(languageMap).sort(
    (left, right) => languagePriority(right) - languagePriority(left),
  );

  let best: SubtitleTrack | null = null;
  let bestScore = -1;

  for (const lang of orderedLanguages) {
    const entries = asArray(languageMap[lang]);
    if (!entries) continue;

    for (const entry of entries) {
      const record = asRecord(entry);
      const url = asString(record?.url);
      if (!url) continue;
      const ext = asString(record?.ext);
      const score = languagePriority(lang) * 10 + subtitleFormatPriority(ext);
      if (score > bestScore) {
        bestScore = score;
        best = { url, ext, lang };
      }
    }
  }

  return best;
}

function languagePriority(languageCode: string): number {
  const code = languageCode.toLowerCase();
  if (code.startsWith("en")) return 3;
  if (code.startsWith("zh")) return 2;
  if (code.startsWith("es")) return 2;
  return 1;
}

function subtitleFormatPriority(ext: string | null): number {
  const format = (ext ?? "").toLowerCase();
  if (format === "json3") return 5;
  if (format === "srv3" || format === "srv2" || format === "xml") return 4;
  if (format === "vtt" || format === "webvtt") return 3;
  if (format === "ttml") return 2;
  if (format === "srt") return 1;
  return 0;
}

function findCandidateText(value: unknown): string | null {
  if (typeof value === "string") {
    if (value.trim().length > 0) return value;
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findCandidateText(item);
      if (nested) return nested;
    }
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const priorityKeys = [
    "full_text",
    "text",
    "content",
    "body",
    "tweet",
    "post",
    "data",
  ];

  for (const key of priorityKeys) {
    if (key in obj) {
      const candidate = findCandidateText(obj[key]);
      if (candidate) return candidate;
    }
  }

  for (const candidate of Object.values(obj)) {
    const nested = findCandidateText(candidate);
    if (nested) return nested;
  }

  return null;
}

async function fetchXPostViaOEmbed(url: string): Promise<string | null> {
  try {
    const normalizedUrl = normalizeXUrlForOEmbed(url);
    const endpoint = `https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(normalizedUrl)}`;
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      html?: string;
      author_name?: string;
    };

    if (typeof payload.html !== "string" || !payload.html.trim()) {
      return null;
    }

    const parsed = parseHtml(payload.html);
    const text = normalizeText(parsed.textContent ?? "");
    if (!text) {
      return null;
    }

    return text;
  } catch {
    return null;
  }
}

function normalizeXUrlForOEmbed(url: string): string {
  const parsed = parseUrl(url);
  const host = parsed.hostname.toLowerCase();
  if (host === "x.com" || host.endsWith(".x.com")) {
    parsed.hostname = "twitter.com";
  }
  return parsed.toString();
}

function getExecErrorOutput(error: unknown): string {
  if (!isObject(error)) {
    return "";
  }

  const stdout =
    typeof error.stdout === "string"
      ? error.stdout
      : Buffer.isBuffer(error.stdout)
        ? error.stdout.toString("utf8")
        : "";
  const stderr =
    typeof error.stderr === "string"
      ? error.stderr
      : Buffer.isBuffer(error.stderr)
        ? error.stderr.toString("utf8")
        : "";

  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

function looksLikeCliErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  if (/^\s*env:\s+/i.test(text)) {
    return true;
  }

  const markers = [
    "error",
    "failed",
    "not found",
    "no such file or directory",
    "unauthorized",
    "not authenticated",
    "auth_token",
    "ct0",
    "forbidden",
    "command not found",
    "usage: bird",
  ];

  return markers.some((marker) => normalized.includes(marker));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function withBunInPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const pathParts = currentPath.split(":").filter(Boolean);
  const mustHave = [
    BUN_BIN_DIR,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  for (const part of mustHave) {
    if (!pathParts.includes(part)) {
      pathParts.unshift(part);
    }
  }

  return {
    ...env,
    [pathKey]: pathParts.join(":"),
  };
}

async function fetchYouTubeTranscript(
  url: string,
  preferences: Preferences,
): Promise<{ title?: string; text: string }> {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) {
    throw new Error("Could not extract YouTube video ID");
  }

  const errors: string[] = [];
  const webContext = await fetchYouTubeWebContext(videoId, errors);

  if (webContext) {
    const fromWebProviders = await fetchTranscriptFromYouTubeWebContext(
      webContext,
      errors,
    );
    if (fromWebProviders) {
      return { title: webContext.title || undefined, text: fromWebProviders };
    }
  }

  const fromYtDlp = await fetchTranscriptWithYtDlpForYouTube(url, errors);
  if (fromYtDlp) {
    return { title: webContext?.title || undefined, text: fromYtDlp };
  }

  const apifyToken = resolveApifyApiToken(preferences);
  const fromApify = await fetchTranscriptWithApify(url, apifyToken, errors);
  if (fromApify) {
    return { title: webContext?.title || undefined, text: fromApify };
  }

  if (webContext) {
    const shortDescription =
      extractYouTubeShortDescriptionFromPlayerResponse(
        webContext.playerResponse,
      ) ?? extractYouTubeShortDescriptionFromHtml(webContext.html);
    if (shortDescription) {
      return {
        title: webContext.title || undefined,
        text: limitText(shortDescription, MAX_YOUTUBE_DESCRIPTION_CHARS),
      };
    }
  }

  const detail = collapseAndTruncate(errors.join(" | "), 220);
  throw new Error(
    detail
      ? `No transcript found for this video (${detail})`
      : "No transcript found for this video",
  );
}

async function fetchYouTubeWebContext(
  videoId: string,
  errors: string[],
): Promise<YouTubeWebContext | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  try {
    const response = await fetch(watchUrl, {
      headers: {
        ...YOUTUBE_REQUEST_HEADERS,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      errors.push(`youtube watch page: HTTP ${response.status}`);
      return null;
    }

    const html = await readResponseTextWithLimit(
      response,
      MAX_YOUTUBE_WEB_HTML_BYTES,
    );
    const playerResponse = extractYouTubeInitialPlayerResponse(html);
    const title =
      extractYouTubeTitleFromPlayerResponse(playerResponse) ??
      extractHtmlTitle(html);

    return {
      watchUrl,
      html,
      playerResponse,
      title,
    };
  } catch (error) {
    errors.push(
      `youtube watch page: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function fetchTranscriptFromYouTubeWebContext(
  webContext: YouTubeWebContext,
  errors: string[],
): Promise<string | null> {
  const youtubeiConfig = extractYouTubeiTranscriptConfig(webContext.html);
  if (youtubeiConfig) {
    try {
      const text = await fetchTranscriptFromYouTubei(
        youtubeiConfig,
        webContext.watchUrl,
      );
      if (text) {
        return text;
      }
      errors.push("youtubei: returned empty transcript");
    } catch (error) {
      errors.push(
        `youtubei: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    errors.push("youtubei: transcript endpoint config missing");
  }

  if (!webContext.playerResponse) {
    errors.push("captionTracks: ytInitialPlayerResponse missing");
    return null;
  }

  return fetchTranscriptFromCaptionTracks(
    extractCaptionTracksFromPlayerResponse(webContext.playerResponse),
    errors,
  );
}

async function fetchTranscriptWithYtDlpForYouTube(
  url: string,
  errors: string[],
): Promise<string | null> {
  const ytDlpExecutable = await resolveYtDlpExecutable();
  if (!ytDlpExecutable) {
    errors.push("yt-dlp: executable not found");
    return null;
  }

  try {
    const { stdout } = await execAsync(
      `${shellQuote(ytDlpExecutable)} -J --no-warnings --no-playlist ${shellQuote(url)}`,
      {
        timeout: MAX_BIRD_COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_YT_DLP_STDIO_BYTES,
        env: withBunInPath(process.env),
      },
    );

    const metadata = asRecord(JSON.parse(stdout.trim()));
    if (!metadata) {
      errors.push("yt-dlp: invalid metadata payload");
      return null;
    }

    const track = pickSubtitleTrackFromYtDlpMetadata(metadata);
    if (!track) {
      errors.push("yt-dlp: no subtitle tracks in metadata");
      return null;
    }

    const response = await fetch(track.url, {
      headers: YOUTUBE_REQUEST_HEADERS,
      redirect: "follow",
    });
    if (!response.ok) {
      errors.push(`yt-dlp: subtitle request HTTP ${response.status}`);
      return null;
    }

    const raw = await readResponseTextWithLimit(response, 1_000_000);
    const text = parseSubtitlePayloadToText(raw, track.ext);
    if (!text) {
      errors.push("yt-dlp: subtitle payload could not be parsed");
      return null;
    }

    return limitText(text, MAX_MEDIA_TRANSCRIPT_CHARS);
  } catch (error) {
    errors.push(
      `yt-dlp: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function resolveApifyApiToken(preferences: Preferences): string | null {
  const explicit = preferences.apifyApiToken?.trim();
  if (explicit) {
    return explicit;
  }

  const envToken = process.env.APIFY_API_TOKEN?.trim();
  return envToken || null;
}

async function fetchTranscriptWithApify(
  url: string,
  token: string | null,
  errors: string[],
): Promise<string | null> {
  if (!token) {
    errors.push("Apify: missing token (set preference or APIFY_API_TOKEN)");
    return null;
  }

  try {
    const response = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_YOUTUBE_TRANSCRIPT_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ videoUrl: url }),
        redirect: "follow",
        signal: AbortSignal.timeout(APIFY_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      errors.push(`Apify: HTTP ${response.status}`);
      return null;
    }

    const payload = (await response.json()) as unknown;
    const rows = asArray(payload);
    if (!rows?.length) {
      errors.push("Apify: empty dataset payload");
      return null;
    }

    for (const row of rows) {
      const transcript = normalizeApifyTranscript(row);
      if (transcript) {
        return transcript;
      }
    }

    errors.push("Apify: transcript items found but no usable text");
    return null;
  } catch (error) {
    errors.push(
      `Apify: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function normalizeApifyTranscript(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const dataRows = asArray(record.data);
  if (!dataRows?.length) {
    return null;
  }

  const lines: string[] = [];
  for (const row of dataRows) {
    const text = normalizeText(asString(asRecord(row)?.text) ?? "");
    if (text) {
      lines.push(text);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function extractYouTubeInitialPlayerResponse(
  html: string,
): Record<string, unknown> | null {
  const tokenIndex = html.indexOf("ytInitialPlayerResponse");
  if (tokenIndex < 0) {
    return null;
  }

  const assignmentIndex = html.indexOf("=", tokenIndex);
  if (assignmentIndex < 0) {
    return null;
  }

  const objectText = extractBalancedJsonObject(html, assignmentIndex);
  if (!objectText) {
    return null;
  }

  try {
    return asRecord(JSON.parse(objectText));
  } catch {
    return null;
  }
}

function extractYouTubeShortDescriptionFromPlayerResponse(
  payload: Record<string, unknown> | null,
): string | null {
  const videoDetails = asRecord(payload?.videoDetails);
  return normalizeText(asString(videoDetails?.shortDescription) ?? "") || null;
}

function extractYouTubeTitleFromPlayerResponse(
  payload: Record<string, unknown> | null,
): string | null {
  const videoDetails = asRecord(payload?.videoDetails);
  return normalizeText(asString(videoDetails?.title) ?? "") || null;
}

function extractYouTubeShortDescriptionFromHtml(html: string): string | null {
  return extractYouTubeShortDescriptionFromPlayerResponse(
    extractYouTubeInitialPlayerResponse(html),
  );
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) {
    return null;
  }
  return normalizeText(decodeHtmlEntities(match[1])) || null;
}

function extractYouTubeiTranscriptConfig(
  html: string,
): YouTubeiTranscriptConfig | null {
  const bootstrap = extractYouTubeBootstrapConfig(html);
  if (!bootstrap) {
    return null;
  }

  const apiKey = asString(bootstrap.INNERTUBE_API_KEY);
  const context = asRecord(bootstrap.INNERTUBE_CONTEXT);
  const params = extractYouTubeTranscriptEndpointParams(html);

  if (!apiKey || !context || !params) {
    return null;
  }

  const contextClient = asRecord(context.client);
  const visitorData = firstNonEmptyString([
    asString(bootstrap.VISITOR_DATA),
    asString(contextClient?.visitorData),
  ]);

  const clientNameValue = bootstrap.INNERTUBE_CONTEXT_CLIENT_NAME;
  const clientName =
    typeof clientNameValue === "string"
      ? clientNameValue
      : typeof clientNameValue === "number"
        ? String(clientNameValue)
        : null;

  const pageClValue = bootstrap.PAGE_CL;
  const pageCl =
    typeof pageClValue === "number" && Number.isFinite(pageClValue)
      ? pageClValue
      : null;

  return {
    apiKey,
    context,
    params,
    clientName,
    clientVersion: asString(bootstrap.INNERTUBE_CONTEXT_CLIENT_VERSION),
    visitorData,
    pageCl,
    pageLabel: asString(bootstrap.PAGE_BUILD_LABEL),
  };
}

function extractYouTubeBootstrapConfig(
  source: string,
): Record<string, unknown> | null {
  const tokens = ["ytcfg.set", "var ytcfg"];

  for (const token of tokens) {
    for (
      let index = source.indexOf(token);
      index >= 0;
      index = source.indexOf(token, index + token.length)
    ) {
      const objectText = extractBalancedJsonObject(source, index);
      if (!objectText) continue;

      try {
        const parsed = asRecord(JSON.parse(objectText));
        if (parsed) {
          return parsed;
        }
      } catch {
        // Continue scanning.
      }
    }
  }

  return null;
}

function extractYouTubeTranscriptEndpointParams(html: string): string | null {
  const patterns = [
    /"getTranscriptEndpoint":\{"params":"([^"]+)"\}/,
    /\\"getTranscriptEndpoint\\":\{\\"params\\":\\"([^\\"]+)\\"\}/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) continue;

    const value = decodeBackslashEscapes(match[1]);
    if (value) return value;
  }

  return null;
}

function decodeBackslashEscapes(value: string): string {
  return value
    .replaceAll("\\\\", "\\")
    .replaceAll("\\/", "/")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\u003d", "=")
    .replaceAll("\\u0025", "%");
}

async function fetchTranscriptFromYouTubei(
  config: YouTubeiTranscriptConfig,
  originalUrl: string,
): Promise<string | null> {
  const contextRecord = config.context;
  const clientRecord = asRecord(contextRecord.client) ?? {};
  const payload = {
    context: {
      ...contextRecord,
      client: {
        ...clientRecord,
        originalUrl,
      },
    },
    params: config.params,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": YOUTUBE_USER_AGENT,
    Accept: "application/json",
    Origin: "https://www.youtube.com",
    Referer: originalUrl,
    "X-Goog-AuthUser": "0",
    "X-Youtube-Bootstrap-Logged-In": "false",
  };

  if (config.clientName) {
    headers["X-Youtube-Client-Name"] = config.clientName;
  }
  if (config.clientVersion) {
    headers["X-Youtube-Client-Version"] = config.clientVersion;
  }
  if (config.visitorData) {
    headers["X-Goog-Visitor-Id"] = config.visitorData;
  }
  if (typeof config.pageCl === "number") {
    headers["X-Youtube-Page-CL"] = String(config.pageCl);
  }
  if (config.pageLabel) {
    headers["X-Youtube-Page-Label"] = config.pageLabel;
  }

  const response = await fetch(
    `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(config.apiKey)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "follow",
    },
  );

  if (!response.ok) {
    return null;
  }

  const raw = await response.text();
  const parsed = parseJsonWithPossibleXssiPrefix(raw);
  if (!parsed) {
    return null;
  }

  const segments = asArray(
    getNested(
      parsed,
      "actions.0.updateEngagementPanelAction.content.transcriptRenderer.content.transcriptSearchPanelRenderer.body.transcriptSegmentListRenderer.initialSegments",
    ),
  );
  if (!segments?.length) {
    return null;
  }

  const lines: string[] = [];
  for (const segment of segments) {
    const renderer = asRecord(getNested(segment, "transcriptSegmentRenderer"));
    const runs = asArray(getNested(renderer, "snippet.runs"));
    if (!runs?.length) continue;

    const text = normalizeText(
      runs
        .map((run) => asString(asRecord(run)?.text) ?? "")
        .join("")
        .trim(),
    );
    if (text) {
      lines.push(text);
    }
  }

  const transcript = normalizeText(lines.join("\n"));
  return transcript || null;
}

async function fetchTranscriptFromCaptionTracks(
  tracks: YouTubeCaptionTrack[],
  errors: string[],
): Promise<string | null> {
  if (!tracks.length) {
    errors.push("youtube web/captionTracks: no caption tracks available");
    return null;
  }

  let lastReason = "";
  for (const track of tracks) {
    const jsonUrl = withTranscriptFormat(track.baseUrl, "json3");

    try {
      const response = await fetch(jsonUrl, {
        headers: YOUTUBE_REQUEST_HEADERS,
        redirect: "follow",
      });
      if (response.ok) {
        const raw = await readResponseTextWithLimit(response, 1_000_000);
        const text = parseSubtitlePayloadToText(raw, "json3");
        if (text) {
          return text;
        }
      } else {
        lastReason = `json3 HTTP ${response.status}`;
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }

    try {
      const fallbackResponse = await fetch(track.baseUrl, {
        headers: YOUTUBE_REQUEST_HEADERS,
        redirect: "follow",
      });
      if (!fallbackResponse.ok) {
        lastReason = `caption HTTP ${fallbackResponse.status}`;
        continue;
      }

      const raw = await readResponseTextWithLimit(fallbackResponse, 1_000_000);
      const text = parseSubtitlePayloadToText(
        raw,
        inferSubtitleExt(track.baseUrl) ?? "xml",
      );
      if (text) {
        return text;
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (lastReason) {
    errors.push(`youtube web/captionTracks: ${lastReason}`);
  } else {
    errors.push("youtube web/captionTracks: all tracks returned empty content");
  }

  return null;
}

function extractCaptionTracksFromPlayerResponse(
  payload: Record<string, unknown>,
): YouTubeCaptionTrack[] {
  const captions = asRecord(payload.captions);
  const renderer =
    asRecord(captions?.playerCaptionsTracklistRenderer) ??
    asRecord(payload.playerCaptionsTracklistRenderer);
  if (!renderer) {
    return [];
  }

  const rawTracks = [
    ...(asArray(renderer.captionTracks) ?? []),
    ...(asArray(renderer.automaticCaptions) ?? []),
  ];

  const tracks: YouTubeCaptionTrack[] = [];
  const seen = new Set<string>();

  for (const candidate of rawTracks) {
    const track = asRecord(candidate);
    const baseUrl = firstNonEmptyString([
      asString(track?.baseUrl),
      asString(track?.url),
    ]);
    if (!baseUrl) continue;

    const languageCode = (asString(track?.languageCode) ?? "").toLowerCase();
    const kind = asString(track?.kind);
    const dedupeKey = `${languageCode}|${baseUrl}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    tracks.push({
      baseUrl,
      languageCode,
      kind,
    });
  }

  tracks.sort((left, right) => {
    const leftAuto = left.kind === "asr" ? 1 : 0;
    const rightAuto = right.kind === "asr" ? 1 : 0;
    if (leftAuto !== rightAuto) return leftAuto - rightAuto;
    return (
      languagePriority(right.languageCode) - languagePriority(left.languageCode)
    );
  });

  return tracks;
}

function withTranscriptFormat(url: string, format: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("fmt", format);
    if (format === "json3") {
      parsed.searchParams.set("alt", "json");
    }
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    if (format === "json3") {
      return `${url}${separator}fmt=json3&alt=json`;
    }
    return `${url}${separator}fmt=${encodeURIComponent(format)}`;
  }
}

function inferSubtitleExt(url: string): string | null {
  try {
    const parsed = new URL(url);
    const fmt = parsed.searchParams.get("fmt");
    if (fmt) {
      return fmt;
    }
    const extMatch = parsed.pathname.match(/\.([a-z0-9]+)$/i);
    return extMatch?.[1]?.toLowerCase() ?? null;
  } catch {
    const extMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
    return extMatch?.[1]?.toLowerCase() ?? null;
  }
}

function parseJsonWithPossibleXssiPrefix(
  raw: string,
): Record<string, unknown> | null {
  const trimmed = raw.trimStart();
  const sanitized = trimmed.startsWith(")]}'") ? trimmed.slice(4) : trimmed;
  try {
    return asRecord(JSON.parse(sanitized));
  } catch {
    return null;
  }
}

function getYouTubeVideoId(url: string): string | null {
  const parsed = parseUrl(url);
  const host = parsed.hostname.toLowerCase();

  if (host === "youtu.be") {
    return parsed.pathname.slice(1).split("/")[0] || null;
  }

  if (parsed.searchParams.get("v")) {
    return parsed.searchParams.get("v");
  }

  const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?#]+)/);
  if (shortsMatch) return shortsMatch[1];

  const embedMatch = parsed.pathname.match(/^\/embed\/([^/?#]+)/);
  if (embedMatch) return embedMatch[1];

  return null;
}

async function fetchArticle(
  url: string,
): Promise<{ title?: string; text: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch article (${response.status})`);
  }

  const html = await readResponseTextWithLimit(
    response,
    MAX_ARTICLE_HTML_BYTES,
  );
  const extracted = extractArticleFromHtml(html);
  if (!extracted.text) {
    throw new Error("Could not extract readable article text");
  }

  return {
    title: extracted.title,
    text: limitText(extracted.text, MAX_ARTICLE_TEXT_CHARS),
  };
}

async function summarizeWithCodex(
  payload: SourcePayload,
  preferences: Preferences,
  customInstruction?: string,
): Promise<string> {
  const authPath = expandTilde(
    preferences.codexAuthFile?.trim() || "~/.codex/auth.json",
  );
  const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<
    string,
    unknown
  >;
  const token =
    (typeof auth.access_token === "string" ? auth.access_token : undefined) ||
    (isObject(auth.tokens) && typeof auth.tokens.access_token === "string"
      ? auth.tokens.access_token
      : undefined);

  if (!token) {
    throw new Error(`No access token found in ${authPath}`);
  }

  const maxSourceChars = Number.parseInt(
    preferences.maxSourceChars || "20000",
    10,
  );
  const clippedText = clipText(
    payload.text,
    Number.isFinite(maxSourceChars) ? maxSourceChars : 20000,
  );

  const prompt = buildPrompt(payload, clippedText, customInstruction);

  const res = await fetch(
    preferences.codexUrl || "https://chatgpt.com/backend-api/codex/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: preferences.codexModel || "gpt-5.2-codex",
        instructions: "",
        stream: true,
        store: false,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: prompt }],
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(
      `Codex request failed (${res.status}): ${extractErrorDetail(errorBody)}`,
    );
  }

  const bodyText = await res.text();
  const text = extractTextFromCodexResponseBody(bodyText);
  if (!text) {
    throw new Error("Codex returned an empty response");
  }
  return text;
}

function extractTextFromCodexResponseBody(bodyText: string): string | null {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const direct = extractCodexText(parsed);
    if (direct) {
      return direct;
    }
  } catch {
    // Not JSON; continue with SSE parser.
  }

  return extractTextFromSse(trimmed);
}

function extractTextFromSse(raw: string): string | null {
  const deltas: string[] = [];
  let completed = "";
  let currentEvent = "";
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (!dataLines.length) return;

    const data = dataLines.join("\n").trim();
    dataLines = [];

    if (!data || data === "[DONE]") return;

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const type =
        typeof parsed.type === "string" ? parsed.type : currentEvent || "";

      if (
        type === "response.output_text.delta" &&
        typeof parsed.delta === "string"
      ) {
        deltas.push(parsed.delta);
        return;
      }

      if (type === "response.completed" && isObject(parsed.response)) {
        const fromCompleted = extractCodexText(parsed.response);
        if (fromCompleted) {
          completed = fromCompleted;
          return;
        }
      }

      const generic = extractCodexText(parsed);
      if (generic && !completed) {
        completed = generic;
      }
    } catch {
      // Ignore malformed SSE chunk and continue.
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
      continue;
    }
    if (!line.trim()) {
      flushEvent();
      currentEvent = "";
    }
  }
  flushEvent();

  const deltaText = deltas.join("").trim();
  if (deltaText) {
    return deltaText;
  }
  if (completed.trim()) {
    return completed.trim();
  }
  return null;
}

function extractCodexText(body: Record<string, unknown>): string | null {
  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }

  if (Array.isArray(body.output_text)) {
    const joined = body.output_text
      .map((part) => (typeof part === "string" ? part : ""))
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  if (Array.isArray(body.output)) {
    const collected: string[] = [];

    for (const item of body.output) {
      if (!isObject(item)) continue;
      const content = item.content;
      if (!Array.isArray(content)) continue;

      for (const part of content) {
        if (!isObject(part)) continue;

        const type = part.type;
        if (
          (type === "output_text" || type === "text") &&
          typeof part.text === "string"
        ) {
          collected.push(part.text);
        }
      }
    }

    const merged = collected.join("\n").trim();
    if (merged) return merged;
  }

  return null;
}

function extractErrorDetail(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Unknown error";

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const detailCandidates = [
      parsed.detail,
      parsed.error,
      isObject(parsed.error) ? parsed.error.message : null,
      parsed.message,
    ];
    for (const candidate of detailCandidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return collapseAndTruncate(candidate, 220);
      }
    }
  } catch {
    // Not JSON.
  }

  return collapseAndTruncate(trimmed, 220);
}

function buildPrompt(
  payload: SourcePayload,
  clippedText: string,
  customInstruction?: string,
): string {
  const extra = customInstruction?.trim();

  return [
    "You are summarizing source content for a Raycast command called Key Points.",
    `Source type: ${payload.kind}`,
    `Source URL: ${payload.url}`,
    payload.title ? `Source title: ${payload.title}` : "",
    "",
    "Return concise markdown with these sections:",
    "## TL;DR",
    "## Key Points",
    "## Important Context",
    "## Actionable Takeaways",
    "",
    "Rules:",
    "- Do not invent details not present in the source.",
    "- Mention uncertainty when source is ambiguous.",
    "- Keep the response useful and skimmable.",
    "- Do not claim the source is incomplete, truncated, or missing an ending unless the literal marker '[Truncated' appears in the source text.",
    extra ? `- Additional user instruction: ${extra}` : "",
    "",
    "Source content:",
    clippedText,
  ]
    .filter(Boolean)
    .join("\n");
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars))}\n\n[Truncated before summarization due to max source length.]`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function extractArticleFromHtml(html: string): {
  title?: string;
  text: string;
} {
  const root = parseHtml(html, {
    comment: false,
    blockTextElements: {
      script: true,
      style: true,
      pre: true,
      noscript: true,
    },
  });

  for (const selector of [
    "script",
    "style",
    "noscript",
    "svg",
    "iframe",
    "canvas",
    "form",
  ]) {
    for (const node of root.querySelectorAll(selector)) {
      node.remove();
    }
  }

  let bestText = "";
  for (const selector of ARTICLE_ROOT_SELECTORS) {
    for (const node of root.querySelectorAll(selector)) {
      const candidate = normalizeText(node.textContent);
      if (candidate.length > bestText.length) {
        bestText = candidate;
      }
    }
  }

  if (!bestText) {
    bestText = normalizeText(root.textContent);
  }

  return {
    title:
      normalizeText(root.querySelector("title")?.textContent ?? "") ||
      undefined,
    text: bestText,
  };
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return limitText(text, maxBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const nextBytes = bytesRead + value.byteLength;
    if (nextBytes > maxBytes) {
      const allowed = Math.max(0, maxBytes - bytesRead);
      if (allowed > 0) {
        output += decoder.decode(value.subarray(0, allowed), { stream: true });
      }
      await reader.cancel();
      output += decoder.decode();
      return `${output}\n<!-- HTML truncated due to size limit -->`;
    }

    bytesRead = nextBytes;
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

function extractBalancedJsonObject(
  source: string,
  startAt: number,
): string | null {
  const start = source.indexOf("{", startAt);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (!char) continue;

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (quote && char === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseSubtitlePayloadToText(
  raw: string,
  ext: string | null,
): string | null {
  const format = (ext ?? "").toLowerCase();

  const candidates = [
    format,
    "json3",
    "xml",
    "srv3",
    "srv2",
    "vtt",
    "srt",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "json3") {
      const json3 = parseJson3Subtitle(raw);
      if (json3) return json3;
      continue;
    }
    if (candidate === "xml" || candidate === "srv3" || candidate === "srv2") {
      const xml = parseXmlSubtitle(raw);
      if (xml) return xml;
      continue;
    }
    if (candidate === "vtt" || candidate === "webvtt") {
      const vtt = parseVttSubtitle(raw);
      if (vtt) return vtt;
      continue;
    }
    if (candidate === "srt") {
      const srt = parseSrtSubtitle(raw);
      if (srt) return srt;
      continue;
    }
  }

  // If the extension is wrong or missing, try all parsers one last time.
  return (
    parseJson3Subtitle(raw) ??
    parseXmlSubtitle(raw) ??
    parseVttSubtitle(raw) ??
    parseSrtSubtitle(raw) ??
    (normalizeText(raw) || null)
  );
}

function parseJson3Subtitle(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = parseJsonWithPossibleXssiPrefix(raw);
  }

  const payload = asRecord(parsed);
  if (!payload) return null;

  const events = asArray(payload.events);
  if (!events?.length) return null;

  const lines: string[] = [];
  for (const event of events) {
    const eventRecord = asRecord(event);
    const segments = asArray(eventRecord?.segs);
    if (!segments?.length) continue;

    const line = normalizeText(
      segments
        .map((segment) =>
          decodeHtmlEntities(asString(asRecord(segment)?.utf8) ?? ""),
        )
        .join("")
        .trim(),
    );
    if (line) {
      lines.push(line);
    }
  }

  const text = lines.join("\n").trim();
  return text || null;
}

function parseXmlSubtitle(raw: string): string | null {
  const lines: string[] = [];

  const textTagPattern = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null = textTagPattern.exec(raw);
  while (match) {
    const content = match[1] ?? "";
    const normalized = normalizeText(
      decodeHtmlEntities(content.replace(/<[^>]+>/g, " ")),
    );
    if (normalized) {
      lines.push(normalized);
    }
    match = textTagPattern.exec(raw);
  }

  // Some subtitle payloads use <p> tags instead of <text>.
  if (lines.length === 0) {
    const paragraphPattern = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let paragraphMatch: RegExpExecArray | null = paragraphPattern.exec(raw);
    while (paragraphMatch) {
      const content = paragraphMatch[1] ?? "";
      const normalized = normalizeText(
        decodeHtmlEntities(content.replace(/<[^>]+>/g, " ")),
      );
      if (normalized) {
        lines.push(normalized);
      }
      paragraphMatch = paragraphPattern.exec(raw);
    }
  }

  const text = lines.join("\n").trim();
  return text || null;
}

function parseVttSubtitle(raw: string): string | null {
  const lines: string[] = [];
  const currentCue: string[] = [];

  const flushCue = () => {
    if (!currentCue.length) return;
    const line = normalizeText(currentCue.join(" "));
    currentCue.length = 0;
    if (line) {
      lines.push(line);
    }
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushCue();
      continue;
    }
    if (
      /^WEBVTT/i.test(line) ||
      /^NOTE/i.test(line) ||
      /^STYLE/i.test(line) ||
      /^REGION/i.test(line) ||
      /^\d+$/.test(line) ||
      /-->/i.test(line)
    ) {
      continue;
    }
    currentCue.push(decodeHtmlEntities(line.replace(/<[^>]+>/g, " ")));
  }
  flushCue();

  const text = lines.join("\n").trim();
  return text || null;
}

function parseSrtSubtitle(raw: string): string | null {
  const lines: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      /^\d+$/.test(line) ||
      /^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}$/.test(line)
    ) {
      continue;
    }
    lines.push(
      normalizeText(decodeHtmlEntities(line.replace(/<[^>]+>/g, " "))),
    );
  }
  const text = lines.join("\n").trim();
  return text || null;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&nbsp;", " ");
}

function getNested(value: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = value;

  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(part, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return null;
      }
      current = current[index];
      continue;
    }

    const record = asRecord(current);
    if (!record || !(part in record)) {
      return null;
    }
    current = record[part];
  }

  return current;
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars))}\n\n[Truncated due to size limit.]`;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function collapseAndTruncate(text: string, maxChars: number): string {
  const collapsed = normalizeText(text);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars))}...`;
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstNonEmptyString(
  values: Array<string | null | undefined>,
): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
