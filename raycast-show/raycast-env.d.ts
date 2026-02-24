/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** TMDB API Key - Optional override. Falls back to TMDB_API_KEY from .env. */
  "tmdbApiKey"?: string,
  /** Real-Debrid Token - Optional override. Falls back to REAL_DEBRID_TOKEN from .env. */
  "realDebridToken"?: string,
  /** Torrentio Base URL - Optional override. Falls back to TORRENTIO_BASE_URL from .env. */
  "torrentioBaseUrl"?: string,
  /** Player Binary - Executable name/path, e.g. vlc, mpv, /Applications/VLC.app/Contents/MacOS/VLC. */
  "playerBinary"?: string,
  /** Legacy MPV Binary - Backward compatibility. Prefer Player Binary instead. */
  "mpvBinary"?: string,
  /** Download Directory - Directory for downloads. Defaults to ~/Downloads. */
  "downloadDirectory"?: string,
  /** FFmpeg Binary - Executable name/path for ffmpeg used by MP4 conversion downloads. */
  "ffmpegBinary"?: string,
  /** Preferred Quality - Preferred source quality for ranking. */
  "preferredQuality": "auto" | "2160p" | "1080p" | "720p",
  /** Minimum Seeders - Optional numeric filter. */
  "minSeeders"?: string,
  /** Enable Resolved Cache - Reuse previously resolved links when available. */
  "enableResolvedCache": boolean,
  /** Clear Resolved Cache on Launch - Delete all cached resolved links when this command starts. */
  "clearResolvedCacheOnLaunch": boolean
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `show` command */
  export type Show = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `show` command */
  export type Show = {}
}

