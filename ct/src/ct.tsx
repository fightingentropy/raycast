import { Action, ActionPanel, List } from "@raycast/api";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { useCallback, useEffect, useState } from "react";
import { delimiter } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LIST_URL = "https://x.com/i/lists/1933193197817135501";

type BirdTweet = {
  id: string;
  text: string;
  url?: string;
  mediaUrls: string[];
  author: {
    username: string;
  };
};

async function fetchTimeline(): Promise<BirdTweet[]> {
  const home = homedir();
  const birdPath = await resolveBirdPath();
  const pathParts = new Set([
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    `${home}/.bun/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { stdout } = await execFileAsync(
        birdPath,
        ["list-timeline", LIST_URL, "--count", "20"],
        {
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, PATH: Array.from(pathParts).join(delimiter) },
        },
      );

      return parseBirdTimelinePlain(stdout);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("Failed to load timeline");
}

function parseBirdTimelinePlain(raw: string): BirdTweet[] {
  const cleaned = stripUnsafeControlChars(stripAnsi(raw));
  const lines = cleaned.split(/\r?\n/);
  const tweets: BirdTweet[] = [];

  let currentAuthor: string | null = null;
  let collecting = false;
  let textLines: string[] = [];
  let currentUrl: string | undefined;
  let currentMediaUrls: string[] = [];
  let idCounter = 0;

  const flush = () => {
    if (!currentAuthor) return;
    const text = textLines.join("\n").trim();
    if (!text) return;
    tweets.push({
      id: `plain-${idCounter++}`,
      text,
      url: currentUrl,
      mediaUrls: currentMediaUrls,
      author: { username: currentAuthor.replace(/^@/, "") },
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("@") && trimmed.includes(":")) {
      flush();
      const authorPart = trimmed.split(":")[0] ?? "";
      currentAuthor = authorPart.split(" ")[0] ?? null;
      collecting = true;
      textLines = [];
      currentUrl = undefined;
      currentMediaUrls = [];
      continue;
    }

    if (!collecting || !currentAuthor) continue;
    if (trimmed.startsWith("📅")) continue;
    if (trimmed.startsWith("🔗")) {
      const maybeUrl = trimmed.replace(/^🔗\s*/, "").trim();
      if (maybeUrl.startsWith("http")) {
        currentUrl = maybeUrl;
      }
      continue;
    }
    if (
      trimmed.startsWith("┌") ||
      trimmed.startsWith("│") ||
      trimmed.startsWith("└")
    )
      continue;
    if (trimmed.startsWith("🖼")) {
      const maybeMediaUrl = trimmed.replace(/^🖼️?\s*/, "").trim();
      if (maybeMediaUrl.startsWith("http")) {
        currentMediaUrls.push(maybeMediaUrl);
      }
      continue;
    }
    if (/^[\u2500-]+$/.test(trimmed)) {
      flush();
      collecting = false;
      currentAuthor = null;
      textLines = [];
      currentUrl = undefined;
      currentMediaUrls = [];
      continue;
    }

    textLines.push(trimmed);
  }

  flush();
  return tweets.slice(0, 20);
}

function stripAnsi(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const current = input.charCodeAt(i);
    const next = i + 1 < input.length ? input.charCodeAt(i + 1) : -1;

    // Skip CSI escape sequence: ESC [ ... letter
    if (current === 27 && next === 91) {
      i += 2;
      while (i < input.length) {
        const code = input.charCodeAt(i);
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
          break;
        }
        i++;
      }
      continue;
    }

    out += input[i];
  }

  return out;
}

function stripUnsafeControlChars(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const isAllowed = code === 9 || code === 10 || code === 13 || code >= 32;
    if (isAllowed) {
      out += input[i];
    }
  }
  return out;
}

async function resolveBirdPath(): Promise<string> {
  const home = homedir();
  const candidates = [
    "bird",
    `${home}/.bun/bin/bird`,
    "/opt/homebrew/bin/bird",
    "/usr/local/bin/bird",
    "/usr/bin/bird",
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep trying candidates until we find an executable.
    }
  }

  throw new Error("bird CLI not found. Install it and ensure it's in PATH.");
}

export default function Command() {
  const [tweets, setTweets] = useState<BirdTweet[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextTweets = await fetchTimeline();
      setTweets(nextTweets.slice(0, 20));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  if (error) {
    return (
      <List>
        <List.EmptyView
          title="Failed to load timeline"
          description={error}
          actions={
            <ActionPanel>
              <Action title="Retry" onAction={load} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  if (tweets.length === 0) {
    return (
      <List isLoading={isLoading}>
        {isLoading ? (
          <List.EmptyView title="Loading tweets..." />
        ) : (
          <List.EmptyView title="No tweets found" />
        )}
      </List>
    );
  }

  return (
    <List isLoading={isLoading} isShowingDetail>
      {tweets.map((tweet) => {
        const text =
          (tweet.text ?? "").trim().length > 0
            ? tweet.text.trim()
            : "(no text)";
        const username = tweet.author?.username
          ? `@${tweet.author.username}`
          : "@unknown";
        const output = `${text}\n${username}`;
        const firstLine = text.split(/\r?\n/)[0] ?? text;

        return (
          <List.Item
            key={tweet.id}
            title={`${firstLine} ${username}`}
            detail={
              <List.Item.Detail
                markdown={`${username}\n\n${escapeMarkdown(text)}${renderImages(tweet.mediaUrls)}${tweet.url ? `\n\n[Open Tweet](${tweet.url})` : ""}`}
              />
            }
            actions={
              <ActionPanel>
                {tweet.url ? (
                  <Action.OpenInBrowser title="Open Tweet" url={tweet.url} />
                ) : null}
                <Action.CopyToClipboard title="Copy Tweet" content={output} />
                <Action title="Refresh" onAction={load} />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");
}

function renderImages(urls: string[]): string {
  if (urls.length === 0) return "";
  return `\n\n${urls.map((url) => `![](${url})`).join("\n\n")}`;
}
