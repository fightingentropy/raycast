/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `kp-summarize` command */
  export type KpSummarize = ExtensionPreferences & {
  /** Codex Model - Model name for Codex backend requests */
  "codexModel": string,
  /** Codex URL - Codex responses endpoint */
  "codexUrl": string,
  /** Codex Auth File - Path to auth.json containing access_token */
  "codexAuthFile": string,
  /** Bird Command Template - Optional shell command with {url} placeholder, e.g. bird x post "{url}" --json */
  "birdCommand"?: string,
  /** Max Source Characters - Input text truncation limit before sending to Codex */
  "maxSourceChars": string,
  /** Apify API Token - Optional token for last-resort YouTube transcript fallback */
  "apifyApiToken"?: string
}
}

declare namespace Arguments {
  /** Arguments passed to the `kp-summarize` command */
  export type KpSummarize = {
  /** YouTube, X, or article URL */
  "url": string
}
}

