/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Default Stock Tickers - Comma-separated tickers used when command argument is empty. */
  "defaultTickers"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `stocks` command */
  export type Stocks = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `stocks` command */
  export type Stocks = {
  /** $ */
  "tickers": string
}
}

