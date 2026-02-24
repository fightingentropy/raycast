# Raycast Show

Raycast command (movies + TV) that follows the streaming pipeline in `PIPELINE.md`:

1. Search movie or TV show in TMDB
2. Resolve TMDB -> IMDb ID
3. Fetch candidates from Torrentio
4. Resolve through Real-Debrid
5. Launch playable URL in VLC/mpv
6. Optionally choose a Torrentio source, resolve it through Real-Debrid, and download (or convert to MP4 via ffmpeg)

## Setup

```bash
npm install
npm run dev
```

Configuration can come from Raycast command preferences (recommended) or environment variables:

- `TMDB_API_KEY`
- `REAL_DEBRID_TOKEN`
- `TORRENTIO_BASE_URL` (optional)
- `PLAYER_BINARY` (optional, default `mpv`, e.g. `vlc`)
- `MPV_BINARY` (legacy fallback)
- `DOWNLOAD_DIRECTORY` (optional, default `~/Downloads`)
- `FFMPEG_BINARY` (optional, default `ffmpeg`)

Cache preferences:

- `Enable Resolved Cache`: reuse previously resolved links before resolving again.
- `Clear Resolved Cache on Launch`: wipe all saved resolved links the next time the command starts.


TV shows support episode selection from the `Choose Episode` action in search results.

## Action behavior

- `Play Movie` / `Play Episode`:
  - Resolves and streams the top ranked candidate in VLC/mpv.
  - From the main TV result row, play uses the default episode (`S01E01` if available).
  - To play a specific episode, use `Choose Episode` first.

- `Download Movie` / `Download Episode`:
  - Loads ranked Torrentio source candidates.
  - You choose the source.
  - The selected source is resolved via Real-Debrid.
  - The file is downloaded as-is (original container/codec).

- `Download ... as MP4`:
  - Same source-selection flow as normal download.
  - Selected source is resolved via Real-Debrid.
  - Download + MP4 conversion starts in background via `ffmpeg`.
  - It attempts audio passthrough first (`-c:a copy`) and falls back to AAC if needed.
