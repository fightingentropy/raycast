# Key Points (Raycast Extension)

`Kp Summarize` summarizes an X post, YouTube video, or article URL using Codex.

## What it does

- Detects URL type automatically:
  - `x.com` / `twitter.com` -> X post
  - `youtube.com` / `youtu.be` -> YouTube transcript
  - Everything else -> article scrape
- Fetches source text:
  - X posts via Bird CLI
  - YouTube via cascade: `youtubei -> captionTracks -> yt-dlp -> Apify`
  - Articles via lightweight HTML parsing
- Sends source text to Codex and returns a structured markdown summary.

## Setup

1. Install deps:

```bash
npm install
```

2. Run in Raycast development mode:

```bash
npm run dev
```

3. In Raycast, open `Kp Summarize` and set command preferences if needed:

- `Codex Auth File` (default `~/.codex/auth.json`)
- `Codex URL` (default `https://chatgpt.com/backend-api/codex/responses`)
- `Codex Model` (default `gpt-5.2-codex`)
- `Bird Command Template` (optional, must include `{url}`)
- `Max Source Characters`
- `Apify API Token` (optional, only used in final YouTube fallback stage)

## Notes

- Bird CLI fallback attempts are built in. If your Bird syntax differs, set `Bird Command Template` explicitly.
- If you want to publish this extension, replace the `author` field in `package.json` with your Raycast username.
