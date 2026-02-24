import {
  Action,
  ActionPanel,
  closeMainWindow,
  environment,
  getPreferenceValues,
  Icon,
  List,
  LocalStorage,
  open,
  showToast,
  Toast,
} from "@raycast/api";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const REAL_DEBRID_API_BASE = "https://api.real-debrid.com/rest/1.0";
const DEFAULT_TORRENTIO_BASE_URL = "https://torrentio.strem.fun";
const DEFAULT_DOWNLOAD_DIRECTORY = join(homedir(), "Downloads");
const DEFAULT_DOWNLOAD_BASENAME = "video";
const DOWNLOAD_FFMPEG_AUDIO_BITRATE = "192k";
const DEFAULT_FFMPEG_CANDIDATE_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
];

const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://explodie.org:6969/announce",
];

const TORRENT_FATAL_STATUSES: ReadonlySet<string> = new Set([
  "error",
  "magnet_error",
  "virus",
  "dead",
  "invalid_magnet",
]);
const VIDEO_FILE_REGEX = /\.(mkv|mp4|avi|mov|wmv|m4v|webm|mpg|mpeg|ts)$/i;
const TITLE_MATCH_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "of",
  "in",
  "on",
  "to",
  "for",
  "vs",
  "v",
  "movie",
]);

const ENGLISH_STREAM_MARKERS: ReadonlyArray<RegExp> = [
  /\benglish\b/i,
  /\beng\b/i,
  /\b(?:audio|lang(?:uage)?)[:\s._-]*en(?:g(?:lish)?)?\b/i,
];

const NON_ENGLISH_STREAM_MARKERS: ReadonlyArray<RegExp> = [
  /\b(hindi|tamil|telugu|french|spanish|italian|german|russian|japanese|korean|arabic|polish|portuguese|turkish|thai|vietnamese|dutch|latino|dubbed)\b/i,
  /\b(?:audio|lang(?:uage)?)[:\s._-]*(?:hi|hin|ta|tam|te|tel|fr|fra|es|spa|it|ita|de|ger|ru|rus|ja|jpn|ko|kor|ar|ara|pl|pol|pt|por|tr|tur|th|vi|nl)\b/i,
];

const MULTI_AUDIO_STREAM_MARKER = /\b(multi(?:-?audio)?|dual(?:-?audio)?)\b/i;

const STREAM_QUALITY_TARGETS = {
  auto: 0,
  "2160p": 2160,
  "1080p": 1080,
  "720p": 720,
} as const;

const RESOLVED_SOURCE_CACHE_STORAGE_KEY = "resolved-source-cache-v1";
const RESOLVED_SOURCE_CACHE_MAX_ENTRIES = 300;
const ACTIVE_DOWNLOADS_STORAGE_KEY = "active-downloads-v1";
const ACTIVE_DOWNLOADS_MAX_ENTRIES = 200;
const RD_TRANSIENT_RETRY_ATTEMPTS = 3;

type PreferredQuality = keyof typeof STREAM_QUALITY_TARGETS;

type Preferences = {
  tmdbApiKey?: string;
  realDebridToken?: string;
  torrentioBaseUrl?: string;
  playerBinary?: string;
  mpvBinary?: string;
  downloadDirectory?: string;
  ffmpegBinary?: string;
  preferredQuality?: PreferredQuality;
  minSeeders?: string;
  enableResolvedCache?: boolean | string;
  clearResolvedCacheOnLaunch?: boolean | string;
};

type RuntimeConfig = {
  tmdbApiKey: string;
  realDebridToken: string;
  torrentioBaseUrl: string;
  playerBinary: string;
  downloadDirectory: string;
  ffmpegBinary: string;
  preferredQuality: PreferredQuality;
  minSeeders: number;
  enableResolvedCache: boolean;
  clearResolvedCacheOnLaunch: boolean;
};

type TmdbMediaType = "movie" | "tv";

type TmdbContent = {
  id: number;
  media_type?: TmdbMediaType | "person";
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
};

type TmdbSearchResponse = {
  results?: TmdbContent[];
};

type TmdbMovieDetails = {
  id: number;
  title?: string;
  release_date?: string;
  imdb_id?: string;
  runtime?: number;
};

type TmdbTvDetails = {
  id: number;
  name?: string;
  first_air_date?: string;
  number_of_seasons?: number;
  external_ids?: {
    imdb_id?: string;
  };
};

type TmdbEpisode = {
  episode_number?: number;
  name?: string;
  air_date?: string;
  runtime?: number;
};

type TmdbSeasonDetails = {
  season_number?: number;
  episodes?: TmdbEpisode[];
};

type TorrentioPayload = {
  streams?: TorrentioStream[];
};

type TorrentioBehaviorHints = {
  filename?: string;
};

type TorrentioStream = {
  infoHash?: string;
  name?: string;
  title?: string;
  description?: string;
  sources?: string[];
  behaviorHints?: TorrentioBehaviorHints;
};

type StreamMatchMetadata = {
  displayTitle: string;
  displayYear: string;
  runtimeSeconds: number;
};

type MovieMetadata = StreamMatchMetadata & {
  imdbId: string;
};

type EpisodeMetadata = StreamMatchMetadata & {
  imdbId: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
};

type TvEpisodeChoice = {
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  runtimeSeconds: number;
  airDate: string;
};

type EpisodePickerProps = {
  show: TmdbContent;
  config: RuntimeConfig;
};

type RdTorrentListItem = {
  id?: string;
  hash?: string;
};

type RdTorrentFile = {
  id?: number;
  path?: string;
  bytes?: number;
};

type RdTorrentInfo = {
  status?: string;
  files?: RdTorrentFile[];
  links?: string[];
};

type UnrestrictedLink = {
  download?: string;
  filename?: string;
};

type ResolvedSource = {
  playableUrl: string;
  fallbackUrls: string[];
  filename: string;
  totalBytes: number;
  sourceHash: string;
  selectedFile: string;
  magnet: string;
  playbackTitle: string;
};

type CachedResolvedSourceEntry = {
  updatedAt: number;
  resolved: ResolvedSource;
};

type ResolvedSourceCache = Record<string, CachedResolvedSourceEntry>;

type DownloadMode = "source" | "mp4";

type DownloadJob = {
  sourceUrl: string;
  suggestedFilename: string;
  fallbackTitle: string;
  outputDirectory: string;
  ffmpegBinary: string;
  mode: DownloadMode;
};

type ActiveDownloadEntry = {
  id: string;
  pid: number;
  outputPath: string;
  title: string;
  mode: DownloadMode;
  startedAt: number;
  expectedBytes: number;
  downloadedBytes: number;
};

type DownloadSourceOption = {
  id: string;
  title: string;
  subtitle: string;
  stream: TorrentioStream;
  fallbackName: string;
  playbackTitle: string;
  resolution: number;
  seeders: number;
};

type DownloadSourcePickerProps = {
  title: string;
  mode: DownloadMode;
  loadOptions: (toast: Toast) => Promise<DownloadSourceOption[]>;
  onSelectSource: (option: DownloadSourceOption) => Promise<void>;
};

const DOT_ENV_VALUES = loadDotEnvValues();

export default function ShowCommand() {
  const config = useMemo(() => getRuntimeConfig(), []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TmdbContent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [playingItemKey, setPlayingItemKey] = useState<string | null>(null);
  const [downloadingItemKey, setDownloadingItemKey] = useState<string | null>(
    null,
  );
  const [activeDownloads, setActiveDownloads] = useState<ActiveDownloadEntry[]>(
    [],
  );
  const didRunClearCacheOnLaunch = useRef(false);

  useEffect(() => {
    if (
      !config.clearResolvedCacheOnLaunch ||
      didRunClearCacheOnLaunch.current
    ) {
      return;
    }

    didRunClearCacheOnLaunch.current = true;
    void (async () => {
      try {
        await clearResolvedSourceCache();
        await showToast({
          style: Toast.Style.Success,
          title: "Resolved cache cleared",
        });
      } catch (error) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to clear resolved cache",
          message: toErrorMessage(error),
        });
      }
    })();
  }, [config.clearResolvedCacheOnLaunch]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearchError("");
      setIsLoading(false);
      return;
    }
    if (!config.tmdbApiKey) {
      setSearchError(
        "Missing TMDB API key. Set preferences or TMDB_API_KEY in .env.",
      );
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const timeoutId = setTimeout(() => {
      void (async () => {
        setIsLoading(true);
        try {
          const found = await searchTmdbContent(trimmed, config);
          if (!cancelled) {
            setResults(found);
            setSearchError("");
          }
        } catch (error) {
          if (!cancelled) {
            setResults([]);
            setSearchError(toErrorMessage(error));
          }
        } finally {
          if (!cancelled) {
            setIsLoading(false);
          }
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [query, config]);

  useEffect(() => {
    let cancelled = false;

    const refreshActiveDownloads = () => {
      void (async () => {
        const running = await getRunningActiveDownloads();
        if (!cancelled) {
          setActiveDownloads((current) =>
            areActiveDownloadsEqual(current, running) ? current : running,
          );
        }
      })();
    };

    refreshActiveDownloads();
    const intervalId = setInterval(refreshActiveDownloads, 3000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  async function resolveContentSource(
    item: TmdbContent,
    toast: Toast,
  ): Promise<{ resolved: ResolvedSource; usedCache: boolean }> {
    const contentType = getTmdbContentType(item);
    const resolvedCacheKey = getResolvedCacheKey(item);
    let resolved: ResolvedSource | null = null;
    let usedCache = false;

    if (config.enableResolvedCache) {
      const cached = await getCachedResolvedSource(resolvedCacheKey);
      if (cached) {
        toast.message = "Trying cached stream...";
        const playableFromCache =
          await pickPlayableFromCachedResolvedSource(cached);
        if (playableFromCache) {
          resolved = playableFromCache;
          usedCache = true;
          if (playableFromCache.playableUrl !== cached.playableUrl) {
            await setCachedResolvedSource(resolvedCacheKey, playableFromCache);
          }
        } else {
          toast.message = "Cached stream expired. Resolving fresh stream...";
        }
      }
    }

    if (!resolved) {
      resolved =
        contentType === "tv"
          ? await resolveTmdbTvViaRealDebrid(item, config)
          : await resolveTmdbMovieViaRealDebrid(item, config);
      if (config.enableResolvedCache) {
        await setCachedResolvedSource(resolvedCacheKey, resolved);
      }
    }

    return { resolved, usedCache };
  }

  async function loadContentDownloadSourceOptions(
    item: TmdbContent,
  ): Promise<DownloadSourceOption[]> {
    const contentType = getTmdbContentType(item);
    if (contentType === "tv") {
      const details = await fetchTmdbTvDetails(item.id, config);
      const pickedEpisode = await pickDefaultTmdbEpisode(
        item.id,
        Number(details.number_of_seasons || 1),
        config,
      );
      return buildEpisodeDownloadSourceOptions(
        item,
        pickedEpisode,
        config,
        details,
      );
    }
    return buildMovieDownloadSourceOptions(item, config);
  }

  async function playContent(item: TmdbContent) {
    if (!config.realDebridToken) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Missing Real-Debrid token",
        message: "Set preferences or REAL_DEBRID_TOKEN in .env.",
      });
      return;
    }

    const contentType = getTmdbContentType(item);
    const contentTitle = getTmdbContentTitle(item);
    const contentKey = getTmdbContentKey(item);

    setPlayingItemKey(contentKey);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Resolving ${contentTitle || contentType}...`,
    });

    try {
      const { resolved, usedCache } = await resolveContentSource(item, toast);

      toast.title = usedCache
        ? "Launching Cached Player..."
        : "Launching Player...";
      await launchPlayerPlayback(
        config.playerBinary,
        resolved.playableUrl,
        resolved.playbackTitle || contentTitle || "Video",
      );
      toast.style = Toast.Style.Success;
      toast.title = `Playing ${resolved.playbackTitle || contentTitle || "video"}`;
      toast.message = resolved.filename || resolved.playableUrl;
      await closeMainWindow();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Playback failed";
      toast.message = toErrorMessage(error);
    } finally {
      setPlayingItemKey((current) => (current === contentKey ? null : current));
    }
  }

  async function downloadContent(
    item: TmdbContent,
    mode: DownloadMode,
    preferredSourceUrl?: string,
    resolvedOverride?: ResolvedSource,
  ) {
    if (!config.realDebridToken) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Missing Real-Debrid token",
        message: "Set preferences or REAL_DEBRID_TOKEN in .env.",
      });
      return;
    }

    const contentType = getTmdbContentType(item);
    const contentTitle = getTmdbContentTitle(item);
    const contentKey = getTmdbContentKey(item);

    setDownloadingItemKey(contentKey);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title:
        mode === "mp4"
          ? `Preparing MP4 download for ${contentTitle || contentType}...`
          : `Preparing download for ${contentTitle || contentType}...`,
    });

    try {
      const resolved =
        resolvedOverride || (await resolveContentSource(item, toast)).resolved;
      const sourceUrl = String(
        preferredSourceUrl || resolved.playableUrl,
      ).trim();
      if (!sourceUrl) {
        throw new Error("No source URL selected for download.");
      }
      const expectedBytes =
        resolved.totalBytes > 0
          ? resolved.totalBytes
          : await estimateRemoteSizeBytes(sourceUrl);
      const { outputPath, pid } = await startBackgroundDownload({
        sourceUrl,
        suggestedFilename: resolved.filename,
        fallbackTitle:
          resolved.playbackTitle || contentTitle || contentType || "Video",
        outputDirectory: config.downloadDirectory,
        ffmpegBinary: config.ffmpegBinary,
        mode,
      });
      await addActiveDownload({
        id: `download:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        pid,
        outputPath,
        title: resolved.playbackTitle || contentTitle || contentType || "Video",
        mode,
        startedAt: Date.now(),
        expectedBytes,
        downloadedBytes: 0,
      });
      const running = await getRunningActiveDownloads();
      setActiveDownloads((current) =>
        areActiveDownloadsEqual(current, running) ? current : running,
      );

      toast.style = Toast.Style.Success;
      toast.title =
        mode === "mp4"
          ? "Download + MP4 conversion started"
          : "Download started";
      toast.message = outputPath;
      await closeMainWindow();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = mode === "mp4" ? "MP4 download failed" : "Download failed";
      toast.message = toErrorMessage(error);
    } finally {
      setDownloadingItemKey((current) =>
        current === contentKey ? null : current,
      );
    }
  }
  const trimmedQuery = query.trim();
  const showMissingTmdb = !config.tmdbApiKey;

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search movie or TV show title..."
      onSearchTextChange={setQuery}
      throttle
    >
      {showMissingTmdb ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="TMDB API key missing"
          description="Set preferences or TMDB_API_KEY in .env."
        />
      ) : null}

      {!showMissingTmdb && trimmedQuery.length < 2 ? (
        <List.EmptyView
          icon={Icon.MagnifyingGlass}
          title="Type at least 2 characters"
          description="This command follows the PIPELINE.md flow: TMDB -> Torrentio -> Real-Debrid -> local player."
        />
      ) : null}

      {!showMissingTmdb && trimmedQuery.length >= 2 && searchError ? (
        <List.EmptyView
          icon={Icon.XMarkCircle}
          title="TMDB search failed"
          description={searchError}
        />
      ) : null}

      {!showMissingTmdb &&
      trimmedQuery.length >= 2 &&
      !searchError &&
      results.length === 0 &&
      !isLoading ? (
        <List.EmptyView
          icon={Icon.Document}
          title="No results"
          description="Try another movie or TV show title."
        />
      ) : null}

      {activeDownloads.length > 0 ? (
        <List.Section title={`Downloads (${activeDownloads.length})`}>
          {activeDownloads.map((entry) => (
            <List.Item
              key={`active:${entry.id}`}
              icon={Icon.Download}
              title="~/Downloads"
              subtitle={truncateMiddle(basename(entry.outputPath), 42)}
              accessories={[
                {
                  text: formatDownloadStatus(entry),
                },
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title="Open Download Folder"
                    icon={Icon.Folder}
                    onAction={() => {
                      void open(dirname(entry.outputPath));
                    }}
                  />
                  <Action.CopyToClipboard
                    title="Copy Output Path"
                    content={entry.outputPath}
                  />
                  <Action
                    title="Remove from List"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                    onAction={() => {
                      void (async () => {
                        await removeActiveDownloadById(entry.id);
                        const running = await getRunningActiveDownloads();
                        setActiveDownloads((current) =>
                          areActiveDownloadsEqual(current, running)
                            ? current
                            : running,
                        );
                      })();
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}

      {results.map((item) => {
        const mediaType = getTmdbContentType(item);
        const title = getTmdbContentTitle(item);
        const year = getTmdbContentYear(item);
        const itemKey = getTmdbContentKey(item);
        const isPlaying = playingItemKey === itemKey;
        const isDownloading = downloadingItemKey === itemKey;
        const statusLabel = mediaType === "tv" ? "TV" : "Movie";
        const playLabel =
          mediaType === "tv" ? "Play TV (S01E01)" : "Play Movie";
        const downloadLabel =
          mediaType === "tv" ? "Download TV (S01E01)" : "Download Movie";
        const downloadMp4Label =
          mediaType === "tv"
            ? "Download TV as MP4 (S01E01)"
            : "Download Movie as MP4";
        const accessoryItems: List.Item.Accessory[] = [{ text: statusLabel }];
        if (isPlaying) {
          accessoryItems.push({ text: "Resolving..." });
        }
        if (isDownloading) {
          accessoryItems.push({ text: "Downloading..." });
        }
        return (
          <List.Item
            key={itemKey}
            icon={Icon.Video}
            title={title || "Untitled"}
            subtitle={year || "Unknown year"}
            accessories={accessoryItems}
            actions={
              <ActionPanel>
                <Action
                  title={playLabel}
                  icon={Icon.Play}
                  onAction={() => {
                    void playContent(item);
                  }}
                />
                {mediaType === "tv" ? (
                  <Action.Push
                    title="Choose Episode"
                    icon={Icon.List}
                    shortcut={{ modifiers: ["cmd"], key: "return" }}
                    target={<EpisodePicker show={item} config={config} />}
                  />
                ) : null}
                <Action.Push
                  title={downloadLabel}
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                  target={
                    <DownloadSourcePicker
                      title={title || "Video"}
                      mode="source"
                      loadOptions={() => loadContentDownloadSourceOptions(item)}
                      onSelectSource={async (option) => {
                        const resolved = await resolveDownloadSourceOption(
                          option,
                          config,
                        );
                        await downloadContent(
                          item,
                          "source",
                          undefined,
                          resolved,
                        );
                      }}
                    />
                  }
                />
                <Action.Push
                  title={downloadMp4Label}
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
                  target={
                    <DownloadSourcePicker
                      title={title || "Video"}
                      mode="mp4"
                      loadOptions={() => loadContentDownloadSourceOptions(item)}
                      onSelectSource={async (option) => {
                        const resolved = await resolveDownloadSourceOption(
                          option,
                          config,
                        );
                        await downloadContent(item, "mp4", undefined, resolved);
                      }}
                    />
                  }
                />
                <Action.CopyToClipboard
                  title="Copy TMDB ID"
                  content={`tmdb:${mediaType}:${item.id}`}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

function EpisodePicker({ show, config }: EpisodePickerProps) {
  const showTitle = getTmdbContentTitle(show) || "Show";
  const [episodes, setEpisodes] = useState<TvEpisodeChoice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [playingEpisodeKey, setPlayingEpisodeKey] = useState<string | null>(
    null,
  );
  const [downloadingEpisodeKey, setDownloadingEpisodeKey] = useState<
    string | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!config.tmdbApiKey) {
        setLoadError(
          "Missing TMDB API key. Set preferences or TMDB_API_KEY in .env.",
        );
        setEpisodes([]);
        return;
      }

      setIsLoading(true);
      setLoadError("");

      try {
        const details = await fetchTmdbTvDetails(show.id, config);
        const seasonCount = Number(details.number_of_seasons || 1);
        const availableEpisodes = await fetchTmdbEpisodeChoices(
          show.id,
          seasonCount,
          config,
        );

        if (!cancelled) {
          setEpisodes(availableEpisodes);
          setLoadError("");
        }
      } catch (error) {
        if (!cancelled) {
          setEpisodes([]);
          setLoadError(toErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [show.id, config]);

  async function resolveEpisodeSource(
    episode: TvEpisodeChoice,
    toast: Toast,
  ): Promise<{ resolved: ResolvedSource; usedCache: boolean }> {
    const resolvedCacheKey = getResolvedCacheKey(show, episode);
    let resolved: ResolvedSource | null = null;
    let usedCache = false;

    if (config.enableResolvedCache) {
      const cached = await getCachedResolvedSource(resolvedCacheKey);
      if (cached) {
        toast.message = "Trying cached stream...";
        const playableFromCache =
          await pickPlayableFromCachedResolvedSource(cached);
        if (playableFromCache) {
          resolved = playableFromCache;
          usedCache = true;
          if (playableFromCache.playableUrl !== cached.playableUrl) {
            await setCachedResolvedSource(resolvedCacheKey, playableFromCache);
          }
        } else {
          toast.message = "Cached stream expired. Resolving fresh stream...";
        }
      }
    }

    if (!resolved) {
      resolved = await resolveTmdbTvEpisodeViaRealDebrid(show, episode, config);
      if (config.enableResolvedCache) {
        await setCachedResolvedSource(resolvedCacheKey, resolved);
      }
    }

    return { resolved, usedCache };
  }

  async function loadEpisodeDownloadSourceOptions(
    episode: TvEpisodeChoice,
  ): Promise<DownloadSourceOption[]> {
    return buildEpisodeDownloadSourceOptions(show, episode, config);
  }

  async function playEpisode(episode: TvEpisodeChoice) {
    if (!config.realDebridToken) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Missing Real-Debrid token",
        message: "Set preferences or REAL_DEBRID_TOKEN in .env.",
      });
      return;
    }

    const episodeKey = `${show.id}:${episode.seasonNumber}:${episode.episodeNumber}`;
    const episodeSignature = formatEpisodeSignature(
      episode.seasonNumber,
      episode.episodeNumber,
    );

    setPlayingEpisodeKey(episodeKey);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Resolving ${showTitle} ${episodeSignature}...`,
    });

    try {
      const { resolved, usedCache } = await resolveEpisodeSource(
        episode,
        toast,
      );

      toast.title = usedCache
        ? "Launching Cached Player..."
        : "Launching Player...";
      await launchPlayerPlayback(
        config.playerBinary,
        resolved.playableUrl,
        resolved.playbackTitle || `${showTitle} ${episodeSignature}`,
      );
      toast.style = Toast.Style.Success;
      toast.title = `Playing ${resolved.playbackTitle || `${showTitle} ${episodeSignature}`}`;
      toast.message = resolved.filename || resolved.playableUrl;
      await closeMainWindow();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Playback failed";
      toast.message = toErrorMessage(error);
    } finally {
      setPlayingEpisodeKey((current) =>
        current === episodeKey ? null : current,
      );
    }
  }

  async function downloadEpisode(
    episode: TvEpisodeChoice,
    mode: DownloadMode,
    preferredSourceUrl?: string,
    resolvedOverride?: ResolvedSource,
  ) {
    if (!config.realDebridToken) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Missing Real-Debrid token",
        message: "Set preferences or REAL_DEBRID_TOKEN in .env.",
      });
      return;
    }

    const episodeKey = `${show.id}:${episode.seasonNumber}:${episode.episodeNumber}`;
    const episodeSignature = formatEpisodeSignature(
      episode.seasonNumber,
      episode.episodeNumber,
    );
    const episodeLabel = `${showTitle} ${episodeSignature}`.trim();

    setDownloadingEpisodeKey(episodeKey);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title:
        mode === "mp4"
          ? `Preparing MP4 download for ${episodeLabel}...`
          : `Preparing download for ${episodeLabel}...`,
    });

    try {
      const resolved =
        resolvedOverride ||
        (await resolveEpisodeSource(episode, toast)).resolved;
      const sourceUrl = String(
        preferredSourceUrl || resolved.playableUrl,
      ).trim();
      if (!sourceUrl) {
        throw new Error("No source URL selected for download.");
      }
      const expectedBytes =
        resolved.totalBytes > 0
          ? resolved.totalBytes
          : await estimateRemoteSizeBytes(sourceUrl);
      const { outputPath, pid } = await startBackgroundDownload({
        sourceUrl,
        suggestedFilename: resolved.filename,
        fallbackTitle:
          resolved.playbackTitle ||
          `${showTitle} ${episodeSignature} ${episode.episodeTitle || ""}`.trim(),
        outputDirectory: config.downloadDirectory,
        ffmpegBinary: config.ffmpegBinary,
        mode,
      });
      await addActiveDownload({
        id: `download:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        pid,
        outputPath,
        title:
          resolved.playbackTitle ||
          `${showTitle} ${episodeSignature} ${episode.episodeTitle || ""}`.trim(),
        mode,
        startedAt: Date.now(),
        expectedBytes,
        downloadedBytes: 0,
      });

      toast.style = Toast.Style.Success;
      toast.title =
        mode === "mp4"
          ? "Episode download + MP4 conversion started"
          : "Episode download started";
      toast.message = outputPath;
      await closeMainWindow();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title =
        mode === "mp4"
          ? "Episode MP4 download failed"
          : "Episode download failed";
      toast.message = toErrorMessage(error);
    } finally {
      setDownloadingEpisodeKey((current) =>
        current === episodeKey ? null : current,
      );
    }
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={`Choose episode for ${showTitle}...`}
      throttle
    >
      {loadError ? (
        <List.EmptyView
          icon={Icon.XMarkCircle}
          title="Failed to load episodes"
          description={loadError}
        />
      ) : null}

      {!loadError && !isLoading && episodes.length === 0 ? (
        <List.EmptyView
          icon={Icon.Document}
          title="No episodes"
          description="No aired episodes were found for this show yet."
        />
      ) : null}

      {episodes.map((episode) => {
        const episodeSignature = formatEpisodeSignature(
          episode.seasonNumber,
          episode.episodeNumber,
        );
        const episodeKey = `${show.id}:${episode.seasonNumber}:${episode.episodeNumber}`;
        const isPlaying = playingEpisodeKey === episodeKey;
        const isDownloading = downloadingEpisodeKey === episodeKey;
        const runtimeMinutes =
          episode.runtimeSeconds > 0
            ? `${Math.max(1, Math.round(episode.runtimeSeconds / 60))}m`
            : "";
        const accessories: List.Item.Accessory[] = [];
        if (runtimeMinutes) {
          accessories.push({ text: runtimeMinutes });
        }
        if (isPlaying) {
          accessories.push({ text: "Resolving..." });
        }
        if (isDownloading) {
          accessories.push({ text: "Downloading..." });
        }

        return (
          <List.Item
            key={episodeKey}
            icon={Icon.Video}
            title={`${episodeSignature} ${episode.episodeTitle || "Episode"}`.trim()}
            subtitle={episode.airDate || "Unknown air date"}
            accessories={accessories}
            actions={
              <ActionPanel>
                <Action
                  title="Play Episode"
                  icon={Icon.Play}
                  onAction={() => {
                    void playEpisode(episode);
                  }}
                />
                <Action.Push
                  title="Download Episode"
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                  target={
                    <DownloadSourcePicker
                      title={`${showTitle} ${episodeSignature}`}
                      mode="source"
                      loadOptions={() =>
                        loadEpisodeDownloadSourceOptions(episode)
                      }
                      onSelectSource={async (option) => {
                        const resolved = await resolveDownloadSourceOption(
                          option,
                          config,
                        );
                        await downloadEpisode(
                          episode,
                          "source",
                          undefined,
                          resolved,
                        );
                      }}
                    />
                  }
                />
                <Action.Push
                  title="Download Episode as MP4"
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
                  target={
                    <DownloadSourcePicker
                      title={`${showTitle} ${episodeSignature}`}
                      mode="mp4"
                      loadOptions={() =>
                        loadEpisodeDownloadSourceOptions(episode)
                      }
                      onSelectSource={async (option) => {
                        const resolved = await resolveDownloadSourceOption(
                          option,
                          config,
                        );
                        await downloadEpisode(
                          episode,
                          "mp4",
                          undefined,
                          resolved,
                        );
                      }}
                    />
                  }
                />
                <Action.CopyToClipboard
                  title="Copy Episode ID"
                  content={`tmdb:tv:${show.id}:${episode.seasonNumber}:${episode.episodeNumber}`}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

function getTmdbContentType(item: TmdbContent): TmdbMediaType {
  return item.media_type === "tv" ? "tv" : "movie";
}

function DownloadSourcePicker({
  title,
  mode,
  loadOptions,
  onSelectSource,
}: DownloadSourcePickerProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [options, setOptions] = useState<DownloadSourceOption[]>([]);
  const didResolveRef = useRef(false);

  useEffect(() => {
    if (didResolveRef.current) {
      return;
    }
    didResolveRef.current = true;

    void (async () => {
      setIsLoading(true);
      setLoadError("");
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: `Loading sources for ${title}...`,
      });

      try {
        const sourceOptions = await loadOptions(toast);
        setOptions(sourceOptions);
        toast.style = Toast.Style.Success;
        toast.title = "Sources ready";
        toast.message =
          sourceOptions.length === 1
            ? "1 source available"
            : `${sourceOptions.length} sources available`;
      } catch (error) {
        const message = toErrorMessage(error);
        setLoadError(message);
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to resolve sources";
        toast.message = message;
      } finally {
        setIsLoading(false);
      }
    })();
  }, [loadOptions, title]);

  const selectLabel =
    mode === "mp4"
      ? "Download from This Source as MP4"
      : "Download from This Source";

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={`Choose source for ${title}...`}
      throttle
    >
      {loadError ? (
        <List.EmptyView
          icon={Icon.XMarkCircle}
          title="Failed to load sources"
          description={loadError}
        />
      ) : null}

      {!loadError && !isLoading && options.length === 0 ? (
        <List.EmptyView
          icon={Icon.Document}
          title="No sources found"
          description="No Torrentio sources matched your filters."
        />
      ) : null}

      {options.map((option, index) => {
        const sourceLabel = sanitizeDisplayText(
          formatSourceLabel(option, index),
        );
        const accessories: List.Item.Accessory[] = [];
        if (option.resolution > 0) {
          accessories.push({ text: `${option.resolution}p` });
        }
        if (option.seeders > 0) {
          accessories.push({ text: `S:${option.seeders}` });
        }
        return (
          <List.Item
            key={option.id}
            icon={Icon.Link}
            title={sourceLabel}
            subtitle={truncateMiddle(sanitizeDisplayText(option.subtitle), 86)}
            accessories={accessories}
            actions={
              <ActionPanel>
                <Action
                  title={selectLabel}
                  icon={Icon.Download}
                  onAction={() => {
                    void onSelectSource(option);
                  }}
                />
                <Action.CopyToClipboard
                  title="Copy Source Hash"
                  content={getStreamInfoHash(option.stream)}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

function getTmdbContentTitle(item: TmdbContent): string {
  return (
    item.title || item.name || item.original_title || item.original_name || ""
  );
}

function getTmdbContentYear(item: TmdbContent): string {
  return String(item.release_date || item.first_air_date || "").slice(0, 4);
}

function getTmdbContentKey(item: TmdbContent): string {
  return `${getTmdbContentType(item)}:${item.id}`;
}

function getResolvedCacheKey(
  item: TmdbContent,
  episode?: Pick<TvEpisodeChoice, "seasonNumber" | "episodeNumber">,
): string {
  const mediaType = getTmdbContentType(item);
  if (mediaType === "tv" && episode) {
    return `resolved:tv:${item.id}:${episode.seasonNumber}:${episode.episodeNumber}`;
  }

  return `resolved:${mediaType}:${item.id}`;
}

function formatSourceLabel(
  option: DownloadSourceOption,
  index: number,
): string {
  const stem = option.title || `Source ${index + 1}`;
  if (index === 0) {
    return `${stem} (Top Match)`;
  }
  return stem;
}

function sanitizeDisplayText(value: string): string {
  const input = String(value || "");
  if (!input) {
    return "";
  }

  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode =
        index + 1 < input.length ? input.charCodeAt(index + 1) : 0;
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        output += input[index] + input[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }
    output += input[index];
  }

  return output.split("\0").join("");
}

function getRuntimeConfig(): RuntimeConfig {
  const preferences = getPreferenceValues<Preferences>();
  const preferredQuality = normalizePreferredQuality(
    preferences.preferredQuality || "auto",
  );
  const minSeeders = Math.max(
    0,
    Math.floor(Number(preferences.minSeeders || "0") || 0),
  );
  const enableResolvedCache = parseBooleanPreference(
    preferences.enableResolvedCache,
    true,
  );
  const clearResolvedCacheOnLaunch = parseBooleanPreference(
    preferences.clearResolvedCacheOnLaunch,
    false,
  );
  const configuredFfmpegBinary = firstNonEmpty(
    preferences.ffmpegBinary,
    process.env.FFMPEG_BINARY,
    DOT_ENV_VALUES.FFMPEG_BINARY,
  );

  return {
    tmdbApiKey: firstNonEmpty(
      preferences.tmdbApiKey,
      process.env.TMDB_API_KEY,
      DOT_ENV_VALUES.TMDB_API_KEY,
    ),
    realDebridToken: firstNonEmpty(
      preferences.realDebridToken,
      process.env.REAL_DEBRID_TOKEN,
      DOT_ENV_VALUES.REAL_DEBRID_TOKEN,
    ),
    torrentioBaseUrl: (
      firstNonEmpty(
        preferences.torrentioBaseUrl,
        process.env.TORRENTIO_BASE_URL,
        DOT_ENV_VALUES.TORRENTIO_BASE_URL,
      ) || DEFAULT_TORRENTIO_BASE_URL
    ).replace(/\/+$/, ""),
    playerBinary:
      firstNonEmpty(
        preferences.playerBinary,
        preferences.mpvBinary,
        process.env.PLAYER_BINARY,
        process.env.MPV_BINARY,
        DOT_ENV_VALUES.PLAYER_BINARY,
        DOT_ENV_VALUES.MPV_BINARY,
      ) || "mpv",
    downloadDirectory: normalizeDownloadDirectory(
      firstNonEmpty(
        preferences.downloadDirectory,
        process.env.DOWNLOAD_DIRECTORY,
        DOT_ENV_VALUES.DOWNLOAD_DIRECTORY,
      ) || DEFAULT_DOWNLOAD_DIRECTORY,
    ),
    ffmpegBinary: configuredFfmpegBinary || detectDefaultFfmpegBinary(),
    preferredQuality,
    minSeeders,
    enableResolvedCache,
    clearResolvedCacheOnLaunch,
  };
}

function detectDefaultFfmpegBinary(): string {
  for (const candidatePath of DEFAULT_FFMPEG_CANDIDATE_PATHS) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return "ffmpeg";
}

function loadDotEnvValues(): Record<string, string> {
  const moduleDir =
    typeof __dirname === "string" && __dirname.trim() ? __dirname : "";
  const mainScriptDir = process.argv[1] ? dirname(process.argv[1]) : "";
  const bases = uniqueNonEmptyPaths([
    process.cwd(),
    process.env.PWD,
    moduleDir,
    mainScriptDir,
    environment.assetsPath,
    environment.supportPath,
  ]);
  const attempted = new Set<string>();

  for (const base of bases) {
    let current = resolve(base);
    for (let depth = 0; depth < 16; depth += 1) {
      const candidate = join(current, ".env");
      if (!attempted.has(candidate)) {
        attempted.add(candidate);
        if (existsSync(candidate)) {
          try {
            return parseDotEnv(readFileSync(candidate, "utf8"));
          } catch {
            // Ignore malformed/locked files and keep searching.
          }
        }
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return {};
}

function uniqueNonEmptyPaths(values: Array<string | undefined>): string[] {
  const unique = new Set<string>();
  values.forEach((value) => {
    const normalized = String(value || "").trim();
    if (normalized) {
      unique.add(normalized);
    }
  });
  return [...unique];
}

function parseDotEnv(input: string): Record<string, string> {
  const output: Record<string, string> = {};

  input.split(/\r?\n/g).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      return;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    output[key] = value;
  });

  return output;
}

function normalizePreferredQuality(value: string): PreferredQuality {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "2160p" || normalized === "4k" || normalized === "uhd")
    return "2160p";
  if (normalized === "1080p" || normalized === "1080") return "1080p";
  if (normalized === "720p" || normalized === "720") return "720p";
  return "auto";
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function parseBooleanPreference(
  value: boolean | string | undefined,
  fallback: boolean,
): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeDownloadDirectory(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return DEFAULT_DOWNLOAD_DIRECTORY;
  }

  const expanded = raw.startsWith("~")
    ? join(homedir(), raw.slice(1).replace(/^\/+/, ""))
    : raw;
  return resolve(expanded);
}

function sanitizeResolvedSource(raw: unknown): ResolvedSource | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<ResolvedSource>;
  const playableUrl = String(candidate.playableUrl || "").trim();
  if (!playableUrl) {
    return null;
  }

  const fallbackUrls = Array.isArray(candidate.fallbackUrls)
    ? candidate.fallbackUrls
        .map((url) => String(url || "").trim())
        .filter(Boolean)
    : [];

  return {
    playableUrl,
    fallbackUrls,
    filename: String(candidate.filename || "").trim(),
    totalBytes: Math.max(0, Math.floor(Number(candidate.totalBytes || 0) || 0)),
    sourceHash: String(candidate.sourceHash || "").trim(),
    selectedFile: String(candidate.selectedFile || "").trim(),
    magnet: String(candidate.magnet || "").trim(),
    playbackTitle: String(candidate.playbackTitle || "").trim(),
  };
}

async function loadResolvedSourceCache(): Promise<ResolvedSourceCache> {
  const serialized = await LocalStorage.getItem<string>(
    RESOLVED_SOURCE_CACHE_STORAGE_KEY,
  );
  if (!serialized) {
    return {};
  }

  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const rawCache = parsed as Record<string, unknown>;
    const output: ResolvedSourceCache = {};
    Object.entries(rawCache).forEach(([key, value]) => {
      if (!value || typeof value !== "object") {
        return;
      }

      const entry = value as Partial<CachedResolvedSourceEntry>;
      const resolved = sanitizeResolvedSource(entry.resolved);
      if (!resolved) {
        return;
      }

      output[key] = {
        updatedAt: Math.max(0, Number(entry.updatedAt || 0) || 0),
        resolved,
      };
    });

    return output;
  } catch {
    return {};
  }
}

async function saveResolvedSourceCache(
  cache: ResolvedSourceCache,
): Promise<void> {
  await LocalStorage.setItem(
    RESOLVED_SOURCE_CACHE_STORAGE_KEY,
    JSON.stringify(cache),
  );
}

async function clearResolvedSourceCache(): Promise<void> {
  await LocalStorage.removeItem(RESOLVED_SOURCE_CACHE_STORAGE_KEY);
}

function sanitizeActiveDownloadEntry(raw: unknown): ActiveDownloadEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<ActiveDownloadEntry>;
  const id = String(candidate.id || "").trim();
  const pid = Math.floor(Number(candidate.pid || 0) || 0);
  const outputPath = String(candidate.outputPath || "").trim();
  if (!id || pid <= 0 || !outputPath) {
    return null;
  }

  const mode: DownloadMode = candidate.mode === "mp4" ? "mp4" : "source";
  const title = String(candidate.title || "").trim();
  const startedAt = Math.max(0, Number(candidate.startedAt || 0) || 0);
  const expectedBytes = Math.max(
    0,
    Math.floor(Number(candidate.expectedBytes || 0) || 0),
  );
  const downloadedBytes = Math.max(
    0,
    Math.floor(Number(candidate.downloadedBytes || 0) || 0),
  );

  return {
    id,
    pid,
    outputPath,
    title,
    mode,
    startedAt,
    expectedBytes,
    downloadedBytes,
  };
}

async function loadActiveDownloads(): Promise<ActiveDownloadEntry[]> {
  const serialized = await LocalStorage.getItem<string>(
    ACTIVE_DOWNLOADS_STORAGE_KEY,
  );
  if (!serialized) {
    return [];
  }

  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => sanitizeActiveDownloadEntry(entry))
      .filter((entry): entry is ActiveDownloadEntry => Boolean(entry));
  } catch {
    return [];
  }
}

async function saveActiveDownloads(
  entries: ActiveDownloadEntry[],
): Promise<void> {
  await LocalStorage.setItem(
    ACTIVE_DOWNLOADS_STORAGE_KEY,
    JSON.stringify(entries),
  );
}

function isPidRunning(pid: number): boolean {
  const normalizedPid = Math.floor(Number(pid || 0) || 0);
  if (normalizedPid <= 0) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: string }).code || "")
        : "";
    return code === "EPERM";
  }
}

function readPidCommandLine(pid: number): string {
  const normalizedPid = Math.floor(Number(pid || 0) || 0);
  if (normalizedPid <= 0) {
    return "";
  }

  try {
    const result = spawnSync(
      "ps",
      ["-p", String(normalizedPid), "-o", "command="],
      {
        encoding: "utf8",
      },
    );
    if (result.error || result.status !== 0) {
      return "";
    }
    return String(result.stdout || "").trim();
  } catch {
    return "";
  }
}

function matchesDownloadCommandLine(
  commandLine: string,
  mode: DownloadMode,
): boolean {
  const normalized = String(commandLine || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return true;
  }

  const hasCurl = /\bcurl\b/.test(normalized);
  const hasFfmpeg = /\bffmpeg\b/.test(normalized);
  const hasShell = /\b(?:ba|z|k|c|t)?sh\b/.test(normalized);

  if (mode === "source") {
    return hasCurl;
  }

  return hasCurl || hasFfmpeg || hasShell;
}

function isTrackedDownloadProcess(entry: ActiveDownloadEntry): boolean {
  if (!isPidRunning(entry.pid)) {
    return false;
  }
  const commandLine = readPidCommandLine(entry.pid);
  return matchesDownloadCommandLine(commandLine, entry.mode);
}

async function getRunningActiveDownloads(): Promise<ActiveDownloadEntry[]> {
  const entries = await loadActiveDownloads();
  const running = entries.filter((entry) => isTrackedDownloadProcess(entry));
  const sorted = running.sort(
    (left, right) => right.startedAt - left.startedAt,
  );
  if (sorted.length !== entries.length) {
    await saveActiveDownloads(sorted);
  }
  return sorted.map((entry) => ({
    ...entry,
    downloadedBytes: getPathFileSizeBytes(entry.outputPath),
  }));
}

async function addActiveDownload(entry: ActiveDownloadEntry): Promise<void> {
  const existing = await loadActiveDownloads();
  const combined = [entry, ...existing]
    .filter(
      (candidate, index, all) =>
        all.findIndex((item) => item.id === candidate.id) === index,
    )
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, ACTIVE_DOWNLOADS_MAX_ENTRIES);
  await saveActiveDownloads(combined);
}

async function removeActiveDownloadById(id: string): Promise<void> {
  const existing = await loadActiveDownloads();
  const next = existing.filter((entry) => entry.id !== id);
  await saveActiveDownloads(next);
}

async function getCachedResolvedSource(
  cacheKey: string,
): Promise<ResolvedSource | null> {
  const cache = await loadResolvedSourceCache();
  const entry = cache[cacheKey];
  if (!entry) {
    return null;
  }
  return sanitizeResolvedSource(entry.resolved);
}

async function setCachedResolvedSource(
  cacheKey: string,
  resolved: ResolvedSource,
): Promise<void> {
  const cache = await loadResolvedSourceCache();
  cache[cacheKey] = {
    updatedAt: Date.now(),
    resolved: {
      ...resolved,
      fallbackUrls: Array.isArray(resolved.fallbackUrls)
        ? resolved.fallbackUrls.filter(Boolean)
        : [],
    },
  };

  const entries = Object.entries(cache);
  if (entries.length > RESOLVED_SOURCE_CACHE_MAX_ENTRIES) {
    entries
      .sort(
        (left, right) =>
          Number(left[1].updatedAt || 0) - Number(right[1].updatedAt || 0),
      )
      .slice(0, entries.length - RESOLVED_SOURCE_CACHE_MAX_ENTRIES)
      .forEach(([key]) => {
        delete cache[key];
      });
  }

  await saveResolvedSourceCache(cache);
}

function buildResolvedSourceWithPreferredUrl(
  source: ResolvedSource,
  preferredUrl: string,
): ResolvedSource {
  const normalizedPreferred = String(preferredUrl || "").trim();
  if (!normalizedPreferred) {
    return source;
  }

  const fallbackUrls = [source.playableUrl, ...source.fallbackUrls]
    .map((url) => String(url || "").trim())
    .filter((url) => url && url !== normalizedPreferred);

  return {
    ...source,
    playableUrl: normalizedPreferred,
    fallbackUrls,
  };
}

async function pickPlayableFromCachedResolvedSource(
  source: ResolvedSource,
): Promise<ResolvedSource | null> {
  const candidates = [source.playableUrl, ...source.fallbackUrls]
    .map((url) => String(url || "").trim())
    .filter(Boolean);

  let firstUncertainUrl = "";
  for (const candidateUrl of candidates) {
    try {
      const check = await verifyPlayableUrl(candidateUrl, 5000);
      if (check.ok) {
        return buildResolvedSourceWithPreferredUrl(source, candidateUrl);
      }
      if (check.uncertain && !firstUncertainUrl) {
        firstUncertainUrl = candidateUrl;
      }
    } catch {
      // Ignore stale cached candidate and try the next one.
    }
  }

  if (firstUncertainUrl) {
    return buildResolvedSourceWithPreferredUrl(source, firstUncertainUrl);
  }

  return null;
}

async function searchTmdbContent(
  query: string,
  config: RuntimeConfig,
): Promise<TmdbContent[]> {
  const params = new URLSearchParams({
    api_key: config.tmdbApiKey,
    language: "en-US",
    query,
    include_adult: "false",
    page: "1",
  });
  const payload = await requestJson<TmdbSearchResponse>(
    `${TMDB_BASE_URL}/search/multi?${params.toString()}`,
  );
  if (!Array.isArray(payload.results)) {
    return [];
  }
  return payload.results.filter((item) => {
    const type = String(item.media_type || "").toLowerCase();
    return type === "movie" || type === "tv";
  });
}

async function fetchTmdbMovieDetails(
  tmdbMovieId: number,
  config: RuntimeConfig,
): Promise<TmdbMovieDetails> {
  const params = new URLSearchParams({
    api_key: config.tmdbApiKey,
    language: "en-US",
  });
  return requestJson<TmdbMovieDetails>(
    `${TMDB_BASE_URL}/movie/${tmdbMovieId}?${params.toString()}`,
  );
}

async function fetchTmdbTvDetails(
  tmdbTvId: number,
  config: RuntimeConfig,
): Promise<TmdbTvDetails> {
  const params = new URLSearchParams({
    api_key: config.tmdbApiKey,
    language: "en-US",
    append_to_response: "external_ids",
  });
  return requestJson<TmdbTvDetails>(
    `${TMDB_BASE_URL}/tv/${tmdbTvId}?${params.toString()}`,
  );
}

async function fetchTmdbSeasonDetails(
  tmdbTvId: number,
  seasonNumber: number,
  config: RuntimeConfig,
): Promise<TmdbSeasonDetails> {
  const params = new URLSearchParams({
    api_key: config.tmdbApiKey,
    language: "en-US",
  });
  return requestJson<TmdbSeasonDetails>(
    `${TMDB_BASE_URL}/tv/${tmdbTvId}/season/${seasonNumber}?${params.toString()}`,
  );
}

async function fetchTorrentioMovieStreams(
  imdbId: string,
  config: RuntimeConfig,
): Promise<TorrentioStream[]> {
  const payload = await requestJson<TorrentioPayload>(
    `${config.torrentioBaseUrl}/stream/movie/${encodeURIComponent(imdbId)}.json`,
  );
  return Array.isArray(payload.streams) ? payload.streams : [];
}

async function fetchTorrentioEpisodeStreams(
  imdbId: string,
  seasonNumber: number,
  episodeNumber: number,
  config: RuntimeConfig,
): Promise<TorrentioStream[]> {
  const payload = await requestJson<TorrentioPayload>(
    `${config.torrentioBaseUrl}/stream/series/${encodeURIComponent(imdbId)}:${seasonNumber}:${episodeNumber}.json`,
  );
  return Array.isArray(payload.streams) ? payload.streams : [];
}

async function resolveTmdbMovieViaRealDebrid(
  movie: TmdbContent,
  config: RuntimeConfig,
): Promise<ResolvedSource> {
  const details = await fetchTmdbMovieDetails(movie.id, config);
  const imdbId = String(details.imdb_id || "").trim();
  if (!imdbId) {
    throw new Error("This TMDB movie does not expose an IMDb id.");
  }

  const runtimeMinutes = Number(details.runtime || 0);
  const runtimeSeconds =
    Number.isFinite(runtimeMinutes) && runtimeMinutes > 0
      ? Math.round(runtimeMinutes * 60)
      : 0;
  const metadata: MovieMetadata = {
    imdbId,
    displayTitle: details.title || getTmdbContentTitle(movie) || "Movie",
    displayYear: String(
      details.release_date || movie.release_date || movie.first_air_date || "",
    ).slice(0, 4),
    runtimeSeconds,
  };

  const streams = await fetchTorrentioMovieStreams(metadata.imdbId, config);
  const candidates = selectTopMovieCandidates(
    streams,
    metadata,
    config.preferredQuality,
    config.minSeeders,
    10,
  );
  if (!candidates.length) {
    throw new Error("No playable Torrentio candidates matched your filters.");
  }

  const fallbackName = [metadata.displayTitle, metadata.displayYear]
    .filter(Boolean)
    .join(" ")
    .trim();
  let lastError: unknown = null;
  let fallbackResolvedSource: ResolvedSource | null = null;

  for (const candidate of candidates) {
    try {
      const resolved = await resolveCandidateStream(
        candidate,
        fallbackName,
        config,
      );
      if (
        doesFilenameLikelyMatchMovie(
          resolved.filename,
          metadata.displayTitle,
          metadata.displayYear,
        )
      ) {
        return {
          ...resolved,
          playbackTitle: metadata.displayTitle,
        };
      }
      if (!fallbackResolvedSource) {
        fallbackResolvedSource = {
          ...resolved,
          playbackTitle: metadata.displayTitle,
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (fallbackResolvedSource) {
    return fallbackResolvedSource;
  }

  throw new Error(`Failed to resolve stream. ${toErrorMessage(lastError)}`);
}

async function resolveTmdbTvViaRealDebrid(
  show: TmdbContent,
  config: RuntimeConfig,
): Promise<ResolvedSource> {
  const details = await fetchTmdbTvDetails(show.id, config);
  const pickedEpisode = await pickDefaultTmdbEpisode(
    show.id,
    Number(details.number_of_seasons || 1),
    config,
  );

  return resolveTmdbTvEpisodeViaRealDebrid(
    show,
    pickedEpisode,
    config,
    details,
  );
}

async function resolveTmdbTvEpisodeViaRealDebrid(
  show: TmdbContent,
  episode: TvEpisodeChoice,
  config: RuntimeConfig,
  preloadedDetails?: TmdbTvDetails,
): Promise<ResolvedSource> {
  const details =
    preloadedDetails || (await fetchTmdbTvDetails(show.id, config));
  const imdbId = String(details.external_ids?.imdb_id || "").trim();
  if (!imdbId) {
    throw new Error("This TMDB TV show does not expose an IMDb id.");
  }

  const showTitle = details.name || getTmdbContentTitle(show) || "Show";
  const showYear = String(
    details.first_air_date || show.first_air_date || show.release_date || "",
  ).slice(0, 4);
  const episodeSignature = formatEpisodeSignature(
    episode.seasonNumber,
    episode.episodeNumber,
  );
  const playbackTitle = [showTitle, episodeSignature, episode.episodeTitle]
    .filter(Boolean)
    .join(" ")
    .trim();

  const metadata: EpisodeMetadata = {
    imdbId,
    displayTitle: showTitle,
    displayYear: showYear,
    runtimeSeconds: episode.runtimeSeconds,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    episodeTitle: episode.episodeTitle,
  };
  const streams = await fetchTorrentioEpisodeStreams(
    metadata.imdbId,
    metadata.seasonNumber,
    metadata.episodeNumber,
    config,
  );
  const candidates = selectTopEpisodeCandidates(
    streams,
    metadata,
    config.preferredQuality,
    config.minSeeders,
    10,
  );
  if (!candidates.length) {
    throw new Error("No playable Torrentio candidates matched your filters.");
  }

  const fallbackName = [
    metadata.displayTitle,
    formatEpisodeSignature(metadata.seasonNumber, metadata.episodeNumber),
    metadata.episodeTitle,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  let lastError: unknown = null;
  let fallbackResolvedSource: ResolvedSource | null = null;

  for (const candidate of candidates) {
    try {
      const resolved = await resolveCandidateStream(
        candidate,
        fallbackName,
        config,
      );
      const resolvedWithTitle: ResolvedSource = {
        ...resolved,
        playbackTitle,
      };
      if (doesFilenameLikelyMatchEpisode(resolved.filename, metadata)) {
        return resolvedWithTitle;
      }
      if (!fallbackResolvedSource) {
        fallbackResolvedSource = resolvedWithTitle;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (fallbackResolvedSource) {
    return fallbackResolvedSource;
  }

  throw new Error(`Failed to resolve stream. ${toErrorMessage(lastError)}`);
}

async function resolveDownloadSourceOption(
  option: DownloadSourceOption,
  config: RuntimeConfig,
): Promise<ResolvedSource> {
  const resolved = await resolveCandidateStream(
    option.stream,
    option.fallbackName,
    config,
  );
  return {
    ...resolved,
    playbackTitle: option.playbackTitle,
  };
}

async function buildMovieDownloadSourceOptions(
  movie: TmdbContent,
  config: RuntimeConfig,
): Promise<DownloadSourceOption[]> {
  const details = await fetchTmdbMovieDetails(movie.id, config);
  const imdbId = String(details.imdb_id || "").trim();
  if (!imdbId) {
    throw new Error("This TMDB movie does not expose an IMDb id.");
  }

  const runtimeMinutes = Number(details.runtime || 0);
  const runtimeSeconds =
    Number.isFinite(runtimeMinutes) && runtimeMinutes > 0
      ? Math.round(runtimeMinutes * 60)
      : 0;
  const metadata: MovieMetadata = {
    imdbId,
    displayTitle: details.title || getTmdbContentTitle(movie) || "Movie",
    displayYear: String(
      details.release_date || movie.release_date || movie.first_air_date || "",
    ).slice(0, 4),
    runtimeSeconds,
  };

  const streams = await fetchTorrentioMovieStreams(metadata.imdbId, config);
  const candidates = selectTopMovieCandidates(
    streams,
    metadata,
    config.preferredQuality,
    config.minSeeders,
    10,
  );
  if (!candidates.length) {
    throw new Error("No playable Torrentio candidates matched your filters.");
  }

  const fallbackName = [metadata.displayTitle, metadata.displayYear]
    .filter(Boolean)
    .join(" ")
    .trim();

  return candidates.map((stream, index) =>
    buildDownloadSourceOption({
      stream,
      fallbackName,
      playbackTitle: metadata.displayTitle,
      index,
    }),
  );
}

async function buildEpisodeDownloadSourceOptions(
  show: TmdbContent,
  episode: TvEpisodeChoice,
  config: RuntimeConfig,
  preloadedDetails?: TmdbTvDetails,
): Promise<DownloadSourceOption[]> {
  const details =
    preloadedDetails || (await fetchTmdbTvDetails(show.id, config));
  const imdbId = String(details.external_ids?.imdb_id || "").trim();
  if (!imdbId) {
    throw new Error("This TMDB TV show does not expose an IMDb id.");
  }

  const showTitle = details.name || getTmdbContentTitle(show) || "Show";
  const showYear = String(
    details.first_air_date || show.first_air_date || show.release_date || "",
  ).slice(0, 4);
  const episodeSignature = formatEpisodeSignature(
    episode.seasonNumber,
    episode.episodeNumber,
  );
  const playbackTitle = [showTitle, episodeSignature, episode.episodeTitle]
    .filter(Boolean)
    .join(" ")
    .trim();

  const metadata: EpisodeMetadata = {
    imdbId,
    displayTitle: showTitle,
    displayYear: showYear,
    runtimeSeconds: episode.runtimeSeconds,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    episodeTitle: episode.episodeTitle,
  };
  const streams = await fetchTorrentioEpisodeStreams(
    metadata.imdbId,
    metadata.seasonNumber,
    metadata.episodeNumber,
    config,
  );
  const candidates = selectTopEpisodeCandidates(
    streams,
    metadata,
    config.preferredQuality,
    config.minSeeders,
    10,
  );
  if (!candidates.length) {
    throw new Error("No playable Torrentio candidates matched your filters.");
  }

  const fallbackName = [
    metadata.displayTitle,
    episodeSignature,
    metadata.episodeTitle,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return candidates.map((stream, index) =>
    buildDownloadSourceOption({
      stream,
      fallbackName,
      playbackTitle,
      index,
    }),
  );
}

async function fetchTmdbEpisodeChoices(
  tmdbTvId: number,
  seasonCount: number,
  config: RuntimeConfig,
): Promise<TvEpisodeChoice[]> {
  const safeSeasonCount = Math.max(1, Math.min(40, Math.floor(seasonCount)));
  const now = Date.now();
  const output: TvEpisodeChoice[] = [];

  for (
    let seasonNumber = 1;
    seasonNumber <= safeSeasonCount;
    seasonNumber += 1
  ) {
    let seasonDetails: TmdbSeasonDetails | null = null;
    try {
      seasonDetails = await fetchTmdbSeasonDetails(
        tmdbTvId,
        seasonNumber,
        config,
      );
    } catch {
      seasonDetails = null;
    }

    const episodes = Array.isArray(seasonDetails?.episodes)
      ? seasonDetails.episodes.filter(
          (candidate) => Number(candidate.episode_number || 0) > 0,
        )
      : [];

    episodes.forEach((candidate) => {
      const episodeNumber = Number(candidate.episode_number || 0);
      if (episodeNumber <= 0) {
        return;
      }

      const airDate = String(candidate.air_date || "").trim();
      if (airDate) {
        const parsed = Date.parse(airDate);
        if (Number.isFinite(parsed) && parsed > now) {
          return;
        }
      }

      const runtimeMinutes = Number(candidate.runtime || 0);
      const runtimeSeconds =
        Number.isFinite(runtimeMinutes) && runtimeMinutes > 0
          ? Math.round(runtimeMinutes * 60)
          : 0;

      output.push({
        seasonNumber,
        episodeNumber,
        episodeTitle: String(candidate.name || "").trim(),
        runtimeSeconds,
        airDate,
      });
    });
  }

  return output.sort(
    (left, right) =>
      left.seasonNumber - right.seasonNumber ||
      left.episodeNumber - right.episodeNumber,
  );
}

async function pickDefaultTmdbEpisode(
  tmdbTvId: number,
  seasonCount: number,
  config: RuntimeConfig,
): Promise<TvEpisodeChoice> {
  const choices = await fetchTmdbEpisodeChoices(tmdbTvId, seasonCount, config);
  if (choices.length > 0) {
    return choices[0];
  }

  throw new Error("Unable to identify a TV episode for this show.");
}

function buildDownloadSourceOption(input: {
  stream: TorrentioStream;
  fallbackName: string;
  playbackTitle: string;
  index: number;
}): DownloadSourceOption {
  const { stream, fallbackName, playbackTitle, index } = input;
  const seeders = parseSeedCount(stream.title || stream.name || "");
  const resolution = parseStreamVerticalResolution(stream);
  const infoHash = getStreamInfoHash(stream);
  const rawTitle = String(
    stream.title || stream.name || stream.behaviorHints?.filename || "",
  )
    .replace(/\s+/g, " ")
    .trim();
  const safeTitle = sanitizeDisplayText(rawTitle);
  const safeFallbackName = sanitizeDisplayText(fallbackName);
  const safePlaybackTitle = sanitizeDisplayText(playbackTitle);
  const safeIdSeed = safeTitle || safeFallbackName || `source-${index + 1}`;

  return {
    id: infoHash || `${index}:${safeIdSeed}`,
    title: safeTitle || `Source ${index + 1}`,
    subtitle: safeTitle || safeFallbackName || "Torrentio stream",
    stream,
    fallbackName: safeFallbackName,
    playbackTitle: safePlaybackTitle,
    resolution,
    seeders,
  };
}

function selectTopMovieCandidates(
  streams: TorrentioStream[],
  metadata: MovieMetadata,
  preferredQuality: PreferredQuality,
  minSeeders: number,
  limit = 10,
): TorrentioStream[] {
  const rankedPool = streams.filter(
    (stream) => stream && getStreamInfoHash(stream),
  );
  if (!rankedPool.length) {
    return [];
  }

  const seededPool =
    minSeeders > 0
      ? rankedPool.filter(
          (stream) =>
            parseSeedCount(stream.title || stream.name || "") >= minSeeders,
        )
      : rankedPool;
  const candidatePool = seededPool.length ? seededPool : rankedPool;

  const qualityFiltered = filterStreamsByQualityPreference(
    candidatePool,
    preferredQuality,
  );
  const sorted = [...qualityFiltered].sort((left, right) => {
    const rightScore = scoreStreamQuality(right, metadata, preferredQuality);
    const leftScore = scoreStreamQuality(left, metadata, preferredQuality);
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }
    return (
      parseSeedCount(right.title || right.name || "") -
      parseSeedCount(left.title || left.name || "")
    );
  });

  const top = sorted.slice(0, Math.max(1, limit));
  return top;
}

function selectTopEpisodeCandidates(
  streams: TorrentioStream[],
  metadata: EpisodeMetadata,
  preferredQuality: PreferredQuality,
  minSeeders: number,
  limit = 10,
): TorrentioStream[] {
  const rankedPool = streams.filter(
    (stream) => stream && getStreamInfoHash(stream),
  );
  if (!rankedPool.length) {
    return [];
  }

  const seededPool =
    minSeeders > 0
      ? rankedPool.filter(
          (stream) =>
            parseSeedCount(stream.title || stream.name || "") >= minSeeders,
        )
      : rankedPool;
  const candidatePool = seededPool.length ? seededPool : rankedPool;

  const qualityFiltered = filterStreamsByQualityPreference(
    candidatePool,
    preferredQuality,
  );
  const sorted = [...qualityFiltered].sort((left, right) => {
    const rightScore =
      scoreStreamQuality(right, metadata, preferredQuality) +
      scoreStreamEpisodeSignatureMatch(right, metadata);
    const leftScore =
      scoreStreamQuality(left, metadata, preferredQuality) +
      scoreStreamEpisodeSignatureMatch(left, metadata);
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }
    return (
      parseSeedCount(right.title || right.name || "") -
      parseSeedCount(left.title || left.name || "")
    );
  });

  const top = sorted.slice(0, Math.max(1, limit));
  return top;
}

function filterStreamsByQualityPreference(
  streams: TorrentioStream[],
  preferredQuality: PreferredQuality,
): TorrentioStream[] {
  if (preferredQuality === "auto") {
    const highestDetectedResolution =
      getHighestDetectedStreamResolution(streams);
    if (highestDetectedResolution > 0) {
      const highestQuality = streams.filter(
        (stream) =>
          parseStreamVerticalResolution(stream) === highestDetectedResolution,
      );
      if (highestQuality.length) {
        return highestQuality;
      }
    }

    return streams;
  }

  const targetHeight = STREAM_QUALITY_TARGETS[preferredQuality];
  const exactMatches = streams.filter(
    (stream) => parseStreamVerticalResolution(stream) === targetHeight,
  );
  if (exactMatches.length) {
    return exactMatches;
  }

  const lowerOrEqualMatches = streams.filter((stream) => {
    const height = parseStreamVerticalResolution(stream);
    return height > 0 && height <= targetHeight;
  });
  if (lowerOrEqualMatches.length) {
    return lowerOrEqualMatches;
  }

  const higherMatches = streams.filter(
    (stream) => parseStreamVerticalResolution(stream) > targetHeight,
  );
  if (higherMatches.length) {
    return higherMatches;
  }

  return streams;
}

function scoreStreamQuality(
  stream: TorrentioStream,
  metadata: StreamMatchMetadata,
  preferredQuality: PreferredQuality,
): number {
  return (
    scoreStreamQualityPreference(stream, preferredQuality) +
    scoreStreamTitleYearMatch(stream, metadata) +
    scoreStreamRuntimeMatch(stream, metadata) +
    scoreStreamEnglishPreference(stream) +
    scoreStreamSeeders(stream)
  );
}

function scoreStreamSeeders(stream: TorrentioStream): number {
  const seedCount = parseSeedCount(stream.title || stream.name || "");
  if (seedCount <= 0) {
    return 0;
  }
  return Math.min(900, Math.round(Math.log10(seedCount + 1) * 320));
}

function scoreStreamEnglishPreference(stream: TorrentioStream): number {
  const streamText = [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
    ...(Array.isArray(stream.sources) ? stream.sources : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!streamText) {
    return 0;
  }

  const hasExplicitEnglish = ENGLISH_STREAM_MARKERS.some((pattern) =>
    pattern.test(streamText),
  );
  const hasExplicitNonEnglish = NON_ENGLISH_STREAM_MARKERS.some((pattern) =>
    pattern.test(streamText),
  );
  const hasMultiAudioMarker = MULTI_AUDIO_STREAM_MARKER.test(streamText);

  if (hasExplicitEnglish && hasExplicitNonEnglish) {
    return 180;
  }
  if (hasExplicitEnglish) {
    return 420;
  }
  if (hasExplicitNonEnglish) {
    return -420;
  }
  if (hasMultiAudioMarker) {
    return 90;
  }
  return 0;
}

function scoreStreamQualityPreference(
  stream: TorrentioStream,
  preferredQuality: PreferredQuality,
): number {
  const candidateHeight = parseStreamVerticalResolution(stream);

  if (preferredQuality === "auto") {
    if (!candidateHeight) {
      return 0;
    }
    return Math.round(candidateHeight * 0.7);
  }

  const targetHeight = STREAM_QUALITY_TARGETS[preferredQuality] || 0;
  if (!targetHeight || !candidateHeight) {
    return 0;
  }
  if (candidateHeight === targetHeight) {
    return 1400;
  }
  if (candidateHeight > targetHeight) {
    return -700 - Math.min(900, candidateHeight - targetHeight);
  }
  return -300 - Math.min(700, targetHeight - candidateHeight);
}

function scoreStreamTitleYearMatch(
  stream: TorrentioStream,
  metadata: StreamMatchMetadata,
): number {
  const streamText = [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!streamText) {
    return 0;
  }

  const titleTokens = tokenizeTitleForMatch(metadata.displayTitle);
  if (!titleTokens.length) {
    return 0;
  }

  const matchedTokenCount = titleTokens.reduce(
    (count, token) => count + (streamText.includes(token) ? 1 : 0),
    0,
  );
  const hasYear = metadata.displayYear
    ? streamText.includes(metadata.displayYear)
    : false;
  const requiredMatches = Math.min(2, titleTokens.length);

  if (matchedTokenCount >= requiredMatches && hasYear) return 1800;
  if (matchedTokenCount >= requiredMatches) return 1100;
  if (matchedTokenCount >= 1 && hasYear) return 420;
  if (matchedTokenCount === 0 && hasYear) return -900;
  return -600;
}

function scoreStreamRuntimeMatch(
  stream: TorrentioStream,
  metadata: StreamMatchMetadata,
): number {
  if (metadata.runtimeSeconds < 1800) {
    return 0;
  }

  const streamText = [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
  ]
    .filter(Boolean)
    .join(" ");
  const candidateRuntimeSeconds = parseRuntimeFromLabelSeconds(streamText);
  if (candidateRuntimeSeconds <= 0) {
    return 0;
  }

  const deltaRatio =
    Math.abs(candidateRuntimeSeconds - metadata.runtimeSeconds) /
    metadata.runtimeSeconds;
  if (deltaRatio <= 0.06) return 420;
  if (deltaRatio <= 0.12) return 220;
  if (deltaRatio <= 0.2) return 60;
  return -360;
}

function scoreStreamEpisodeSignatureMatch(
  stream: TorrentioStream,
  metadata: EpisodeMetadata,
): number {
  const text = [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) {
    return 0;
  }

  const expectedSeason = metadata.seasonNumber;
  const expectedEpisode = metadata.episodeNumber;
  const expectedSignature = formatEpisodeSignature(
    expectedSeason,
    expectedEpisode,
  ).toLowerCase();
  if (text.includes(expectedSignature)) {
    return 2600;
  }

  const fullTextPattern = new RegExp(
    `season\\s*0*${expectedSeason}\\b.*episode\\s*0*${expectedEpisode}\\b|episode\\s*0*${expectedEpisode}\\b.*season\\s*0*${expectedSeason}\\b`,
  );
  if (fullTextPattern.test(text)) {
    return 2100;
  }

  const allEpisodeTokens = Array.from(
    text.matchAll(/\bs(\d{1,2})e(\d{1,3})\b/g),
  ).map((match) => ({
    season: Number(match[1] || 0),
    episode: Number(match[2] || 0),
  }));
  if (!allEpisodeTokens.length) {
    return 0;
  }

  const hasExact = allEpisodeTokens.some(
    (token) =>
      token.season === expectedSeason && token.episode === expectedEpisode,
  );
  if (hasExact) {
    return 2200;
  }

  const sameSeasonDifferentEpisode = allEpisodeTokens.some(
    (token) =>
      token.season === expectedSeason && token.episode !== expectedEpisode,
  );
  if (sameSeasonDifferentEpisode) {
    return -1800;
  }

  return -1200;
}

function parseRuntimeFromLabelSeconds(value: string): number {
  const text = String(value || "").toLowerCase();
  if (!text) {
    return 0;
  }

  const hmsMatch = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (!hmsMatch) {
    return 0;
  }

  const first = Number(hmsMatch[1] || 0);
  const second = Number(hmsMatch[2] || 0);
  const third = Number(hmsMatch[3] || 0);
  if (hmsMatch[3]) {
    return first * 3600 + second * 60 + third;
  }
  return first * 60 + second;
}

function parseSeedCount(streamTitle: string): number {
  const match = String(streamTitle || "").match(
    /(?:\u{1F464}|\u{1F465}|seeders?|seeds?)\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?\s*[kKmM]?)/u,
  );
  if (!match) {
    return 0;
  }
  const rawCount = String(match[1] || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!rawCount) {
    return 0;
  }

  const suffix = rawCount.slice(-1);
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  const numericPart = multiplier === 1 ? rawCount : rawCount.slice(0, -1);
  const normalizedNumber = numericPart.replace(/,/g, "");
  const parsed = Number(normalizedNumber);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.round(parsed * multiplier);
}

function parseStreamVerticalResolution(stream: TorrentioStream): number {
  const streamText = [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!streamText) {
    return 0;
  }
  if (/\b(2160p|4k|uhd)\b/.test(streamText)) return 2160;
  if (/\b(1080p|full\s*hd)\b/.test(streamText)) return 1080;
  if (/\b720p\b/.test(streamText)) return 720;
  if (/\b(480p|sd)\b/.test(streamText)) return 480;
  return 0;
}

function getHighestDetectedStreamResolution(
  streams: TorrentioStream[],
): number {
  return streams.reduce((highest, stream) => {
    const height = parseStreamVerticalResolution(stream);
    return height > highest ? height : highest;
  }, 0);
}

function normalizeSourceHash(value: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : "";
}

function getStreamInfoHash(stream: TorrentioStream): string {
  return normalizeSourceHash(stream.infoHash || "");
}

async function resolveCandidateStream(
  stream: TorrentioStream,
  fallbackName: string,
  config: RuntimeConfig,
): Promise<ResolvedSource> {
  const sourceHash = getStreamInfoHash(stream);
  if (!sourceHash) {
    throw new Error("Missing torrent info hash.");
  }

  const magnet = buildMagnetUri(stream, fallbackName);
  const preferredFilename = String(stream.behaviorHints?.filename || "").trim();
  let createdTorrentId = "";

  const resolveFromTorrentId = async (
    torrentId: string,
  ): Promise<ResolvedSource> => {
    const info = await rdFetch<RdTorrentInfo>(
      config,
      `/torrents/info/${torrentId}`,
    );
    const fileIds = pickVideoFileIds(
      info.files || [],
      preferredFilename,
      fallbackName,
    );
    const selectedFile = fileIds.length ? String(fileIds[0]) : "";
    const selectedFileBytes = getSelectedTorrentFileBytes(
      info.files || [],
      fileIds,
    );

    await rdFetch(config, `/torrents/selectFiles/${torrentId}`, {
      method: "POST",
      form: { files: fileIds.length ? fileIds.join(",") : "all" },
    });

    const readyInfo = await waitForTorrentToBeReady(config, torrentId);
    const links = Array.isArray(readyInfo.links)
      ? readyInfo.links.filter(Boolean)
      : [];
    if (!links.length) {
      throw new Error("No Real-Debrid download links were produced.");
    }

    const verifiedCandidates: string[] = [];
    const uncertainCandidates: string[] = [];
    let filename = "";
    let lastError: unknown = null;

    for (const link of links) {
      try {
        const resolved = await resolvePlayableUrlFromRdLink(config, link);
        if (!filename && resolved.filename) {
          filename = resolved.filename;
        }

        const check = await verifyPlayableUrl(resolved.download);
        if (check.ok) {
          pushUniqueUrl(verifiedCandidates, resolved.download);
        } else if (check.uncertain) {
          pushUniqueUrl(uncertainCandidates, resolved.download);
        }
      } catch (error) {
        lastError = error;
      }
    }

    const candidates = [...verifiedCandidates, ...uncertainCandidates];
    if (!candidates.length) {
      throw new Error(
        toErrorMessage(lastError) ||
          "No playable URL was available from Real-Debrid.",
      );
    }

    return {
      playableUrl: candidates[0],
      fallbackUrls: candidates.slice(1),
      filename: filename || preferredFilename || fallbackName,
      totalBytes: selectedFileBytes,
      sourceHash,
      selectedFile,
      magnet,
      playbackTitle: "",
    };
  };

  try {
    const reusable = await findReusableRdTorrentByHash(
      config,
      sourceHash,
    ).catch(() => null);
    if (reusable?.id) {
      try {
        return await resolveFromTorrentId(String(reusable.id));
      } catch {
        // Fall back to addMagnet below.
      }
    }

    const added = await rdFetch<{ id?: string }>(
      config,
      "/torrents/addMagnet",
      {
        method: "POST",
        form: { magnet },
      },
    );

    const torrentId = String(added.id || "").trim();
    if (!torrentId) {
      throw new Error("Real-Debrid did not return a torrent id.");
    }

    createdTorrentId = torrentId;
    return await resolveFromTorrentId(torrentId);
  } catch (error) {
    if (createdTorrentId) {
      void rdFetch(config, `/torrents/delete/${createdTorrentId}`, {
        method: "DELETE",
        timeoutMs: 5000,
      }).catch(() => undefined);
    }
    throw error;
  }
}

function getSelectedTorrentFileBytes(
  files: RdTorrentFile[],
  selectedIds: number[],
): number {
  if (
    !Array.isArray(files) ||
    !Array.isArray(selectedIds) ||
    !selectedIds.length
  ) {
    return 0;
  }
  const selectedSet = new Set(selectedIds);
  let largest = 0;
  for (const file of files) {
    const fileId = Number(file.id || 0);
    if (!selectedSet.has(fileId)) {
      continue;
    }
    const bytes = Math.max(0, Math.floor(Number(file.bytes || 0) || 0));
    if (bytes > largest) {
      largest = bytes;
    }
  }
  return largest;
}

async function findReusableRdTorrentByHash(
  config: RuntimeConfig,
  infoHash: string,
  maxPages = 4,
): Promise<RdTorrentListItem | null> {
  const normalizedHash = normalizeSourceHash(infoHash);
  if (!normalizedHash) {
    return null;
  }

  for (let page = 1; page <= maxPages; page += 1) {
    const list = await rdFetch<RdTorrentListItem[]>(
      config,
      `/torrents?page=${page}`,
      {
        timeoutMs: 10000,
      },
    );
    if (!Array.isArray(list) || !list.length) {
      break;
    }
    const found =
      list.find(
        (item) =>
          String(item.hash || "")
            .trim()
            .toLowerCase() === normalizedHash,
      ) || null;
    if (found) {
      return found;
    }
  }

  return null;
}

function buildMagnetUri(stream: TorrentioStream, fallbackName: string): string {
  const infoHash = getStreamInfoHash(stream);
  if (!infoHash) {
    throw new Error("Missing torrent info hash.");
  }

  const sourceTrackers = Array.isArray(stream.sources)
    ? stream.sources
        .filter(
          (source) =>
            typeof source === "string" && source.startsWith("tracker:"),
        )
        .map((source) => source.slice("tracker:".length))
        .filter(Boolean)
    : [];

  const trackers = [...new Set([...sourceTrackers, ...DEFAULT_TRACKERS])];
  const parts = [`xt=urn:btih:${infoHash}`];
  if (fallbackName) {
    parts.push(`dn=${encodeURIComponent(fallbackName)}`);
  }
  trackers.forEach((tracker) => {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  });

  return `magnet:?${parts.join("&")}`;
}

function pickVideoFileIds(
  files: RdTorrentFile[],
  preferredFilename: string,
  fallbackName: string,
): number[] {
  const list = Array.isArray(files)
    ? files.filter((file) => Number.isInteger(file.id))
    : [];
  if (!list.length) {
    return [];
  }

  const videoFiles = list.filter((file) =>
    VIDEO_FILE_REGEX.test(String(file.path || "")),
  );
  if (!videoFiles.length) {
    const largestAny = list.reduce<RdTorrentFile | null>((largest, file) => {
      if (!largest) return file;
      return Number(file.bytes || 0) > Number(largest.bytes || 0)
        ? file
        : largest;
    }, null);
    return largestAny?.id !== undefined ? [largestAny.id] : [];
  }

  const preferredNeedle = String(preferredFilename || "")
    .trim()
    .toLowerCase();
  const fallbackNeedle = normalizeTextForMatch(fallbackName);
  const preferredEpisodeTag = extractEpisodeTag(
    `${preferredFilename} ${fallbackName}`,
  );
  const fallbackTokens = tokenizeTitleForMatch(fallbackName);

  const ranked = videoFiles
    .map((file) => {
      const path = String(file.path || "");
      const loweredPath = path.toLowerCase();
      const normalizedPath = normalizeTextForMatch(path);
      const fileEpisodeTag = extractEpisodeTag(path);
      const bytes = Math.max(0, Number(file.bytes || 0));
      let score = 0;

      if (preferredNeedle && loweredPath.includes(preferredNeedle)) {
        score += 5000;
      }
      if (fallbackNeedle && normalizedPath.includes(fallbackNeedle)) {
        score += 2200;
      }

      if (preferredEpisodeTag && fileEpisodeTag) {
        if (
          preferredEpisodeTag.season === fileEpisodeTag.season &&
          preferredEpisodeTag.episode === fileEpisodeTag.episode
        ) {
          score += 4500;
        } else if (preferredEpisodeTag.season === fileEpisodeTag.season) {
          score -= 2200;
        } else {
          score -= 800;
        }
      }

      if (fallbackTokens.length && normalizedPath) {
        const tokenHits = fallbackTokens.reduce(
          (count, token) => count + (normalizedPath.includes(token) ? 1 : 0),
          0,
        );
        score += tokenHits * 180;
      }

      // Keep size as a tiebreaker, not the primary selector.
      score += Math.floor(bytes / (1024 * 1024 * 1024));

      return { file, score, bytes };
    })
    .sort(
      (left, right) => right.score - left.score || right.bytes - left.bytes,
    );

  const best = ranked[0]?.file;
  return best?.id !== undefined ? [best.id] : [];
}

function extractEpisodeTag(
  value: string,
): { season: number; episode: number } | null {
  const text = String(value || "").toLowerCase();
  if (!text) {
    return null;
  }

  const compactMatch = text.match(/\bs(\d{1,2})e(\d{1,3})\b/);
  if (compactMatch) {
    return {
      season: Number(compactMatch[1] || 0),
      episode: Number(compactMatch[2] || 0),
    };
  }

  const verboseMatch = text.match(
    /season\s*0*(\d{1,2})\b.*episode\s*0*(\d{1,3})\b|episode\s*0*(\d{1,3})\b.*season\s*0*(\d{1,2})\b/,
  );
  if (!verboseMatch) {
    return null;
  }

  const firstSeason = Number(verboseMatch[1] || 0);
  const firstEpisode = Number(verboseMatch[2] || 0);
  if (firstSeason > 0 && firstEpisode > 0) {
    return { season: firstSeason, episode: firstEpisode };
  }

  const secondEpisode = Number(verboseMatch[3] || 0);
  const secondSeason = Number(verboseMatch[4] || 0);
  if (secondSeason > 0 && secondEpisode > 0) {
    return { season: secondSeason, episode: secondEpisode };
  }

  return null;
}

async function waitForTorrentToBeReady(
  config: RuntimeConfig,
  torrentId: string,
  timeoutMs = 120000,
): Promise<RdTorrentInfo> {
  const start = Date.now();
  let lastStatus = "pending";

  while (Date.now() - start < timeoutMs) {
    const info = await rdFetch<RdTorrentInfo>(
      config,
      `/torrents/info/${torrentId}`,
    );
    const status = String(info.status || "").toLowerCase();
    if (status) {
      lastStatus = status;
    }

    if (
      status === "downloaded" &&
      Array.isArray(info.links) &&
      info.links.length
    ) {
      return info;
    }
    if (TORRENT_FATAL_STATUSES.has(status)) {
      throw new Error(`Real-Debrid torrent failed (${status}).`);
    }

    await sleep(1200);
  }

  throw new Error(`Timed out waiting for Real-Debrid torrent (${lastStatus}).`);
}

async function resolvePlayableUrlFromRdLink(
  config: RuntimeConfig,
  rdLink: string,
): Promise<{ download: string; filename: string }> {
  const unrestricted = await rdFetch<UnrestrictedLink>(
    config,
    "/unrestrict/link",
    {
      method: "POST",
      form: { link: rdLink },
      timeoutMs: 12000,
    },
  );

  const download = String(unrestricted.download || "").trim();
  if (!download) {
    throw new Error("Real-Debrid returned no downloadable link.");
  }

  return {
    download,
    filename: String(unrestricted.filename || "").trim(),
  };
}

async function verifyPlayableUrl(
  playableUrl: string,
  timeoutMs = 8000,
): Promise<{ ok: boolean; uncertain: boolean }> {
  if (!playableUrl) {
    throw new Error("Resolved stream URL is empty.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(playableUrl, {
      method: "HEAD",
      signal: controller.signal,
    });

    if (response.ok) {
      return { ok: true, uncertain: false };
    }

    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status >= 500
    ) {
      throw new Error(`Resolved stream is unavailable (${response.status}).`);
    }

    return { ok: false, uncertain: true };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      return { ok: false, uncertain: true };
    }
    const message = toErrorMessage(error);
    if (message.includes("unavailable")) {
      throw error;
    }
    return { ok: false, uncertain: true };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function estimateRemoteSizeBytes(url: string): Promise<number> {
  const headLength = await readContentLengthHeader(url, "HEAD");
  if (headLength > 0) {
    return headLength;
  }

  const rangeLength = await readContentRangeTotal(url);
  if (rangeLength > 0) {
    return rangeLength;
  }

  return 0;
}

async function readContentLengthHeader(
  url: string,
  method: "HEAD" | "GET",
): Promise<number> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(url, {
      method,
      headers:
        method === "GET"
          ? {
              Range: "bytes=0-0",
            }
          : undefined,
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 206) {
      return 0;
    }
    const raw = response.headers.get("content-length");
    const parsed = Math.floor(Number(raw || 0) || 0);
    return parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readContentRangeTotal(url: string): Promise<number> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-0",
      },
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 206) {
      return 0;
    }
    const contentRange = String(response.headers.get("content-range") || "");
    const match = contentRange.match(/\/(\d+)\s*$/);
    if (!match) {
      return 0;
    }
    const parsed = Math.floor(Number(match[1]) || 0);
    return parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function rdFetch<T>(
  config: RuntimeConfig,
  path: string,
  {
    method = "GET",
    form = null,
    timeoutMs = 20000,
  }: {
    method?: string;
    form?: Record<string, string> | null;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.realDebridToken}`,
  };

  let body: string | undefined;
  if (form) {
    const payload = new URLSearchParams();
    Object.entries(form).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        payload.append(key, String(value));
      }
    });
    body = payload.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  }

  const requestUrl = `${REAL_DEBRID_API_BASE}${path}`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RD_TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await requestJson<T>(
        requestUrl,
        {
          method,
          headers,
          body,
        },
        timeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (
        attempt >= RD_TRANSIENT_RETRY_ATTEMPTS ||
        !isTransientProviderError(error)
      ) {
        throw error;
      }

      await sleep(300 * attempt);
    }
  }

  throw new Error(toErrorMessage(lastError));
}

async function requestJson<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs = 20000,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (response.status === 204) {
      return null as T;
    }

    const rawText = await response.text();
    let payload: unknown = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { message: rawText };
      }
    }

    if (!response.ok) {
      const message =
        (payload as { error?: string; message?: string } | null)?.error ||
        (payload as { error?: string; message?: string } | null)?.message ||
        `Request failed (${response.status})`;
      throw new Error(message);
    }

    return payload as T;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeTextForMatch(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeTitleForMatch(title: string): string[] {
  const normalized = normalizeTextForMatch(title);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !TITLE_MATCH_STOPWORDS.has(token));
}

function formatEpisodeSignature(
  seasonNumber: number,
  episodeNumber: number,
): string {
  return `S${String(Math.max(1, seasonNumber)).padStart(2, "0")}E${String(Math.max(1, episodeNumber)).padStart(2, "0")}`;
}

function doesFilenameLikelyMatchMovie(
  filename: string,
  movieTitle: string,
  movieYear: string,
): boolean {
  const normalizedFilename = normalizeTextForMatch(filename);
  if (!normalizedFilename) {
    return true;
  }

  const titleTokens = tokenizeTitleForMatch(movieTitle);
  if (!titleTokens.length) {
    return true;
  }

  const expectedYear = String(movieYear || "").trim();
  const yearMatchesInFilename: string[] =
    normalizedFilename.match(/\b(?:19|20)\d{2}\b/g) || [];
  const hasExpectedYear =
    expectedYear && yearMatchesInFilename.includes(expectedYear);
  const hasConflictingYear = Boolean(
    expectedYear && yearMatchesInFilename.length && !hasExpectedYear,
  );

  const matchedTokenCount = titleTokens.reduce(
    (count, token) => count + (normalizedFilename.includes(token) ? 1 : 0),
    0,
  );
  const requiredTokenMatches =
    titleTokens.length === 1 ? 1 : Math.min(2, titleTokens.length);

  if (matchedTokenCount >= requiredTokenMatches) {
    if (!expectedYear) return true;
    if (hasExpectedYear) return true;
    return !hasConflictingYear;
  }

  if (matchedTokenCount >= 1 && hasExpectedYear) {
    return true;
  }

  return false;
}

function doesFilenameLikelyMatchEpisode(
  filename: string,
  metadata: EpisodeMetadata,
): boolean {
  const normalizedFilename = normalizeTextForMatch(filename);
  if (!normalizedFilename) {
    return true;
  }

  const expectedSignature = formatEpisodeSignature(
    metadata.seasonNumber,
    metadata.episodeNumber,
  ).toLowerCase();
  if (normalizedFilename.includes(expectedSignature.toLowerCase())) {
    return true;
  }

  const episodeTags = Array.from(
    normalizedFilename.matchAll(/\bs(\d{1,2})e(\d{1,3})\b/g),
  ).map((match) => ({
    season: Number(match[1] || 0),
    episode: Number(match[2] || 0),
  }));
  if (episodeTags.length) {
    const exactEpisode = episodeTags.some(
      (tag) =>
        tag.season === metadata.seasonNumber &&
        tag.episode === metadata.episodeNumber,
    );
    if (!exactEpisode) {
      return false;
    }
  }

  const titleTokens = tokenizeTitleForMatch(metadata.displayTitle);
  if (!titleTokens.length) {
    return true;
  }

  const matchedTokenCount = titleTokens.reduce(
    (count, token) => count + (normalizedFilename.includes(token) ? 1 : 0),
    0,
  );
  const requiredTokenMatches =
    titleTokens.length === 1 ? 1 : Math.min(2, titleTokens.length);
  return matchedTokenCount >= requiredTokenMatches;
}

function pushUniqueUrl(target: string[], value: string) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return;
  }
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, durationMs);
  });
}

function getPathFileSizeBytes(path: string): number {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return 0;
    }
    return Math.max(0, Math.floor(Number(stats.size || 0) || 0));
  } catch {
    return 0;
  }
}

function formatDownloadProgress(entry: ActiveDownloadEntry): string {
  const expectedBytes = Math.max(0, Number(entry.expectedBytes || 0) || 0);
  if (expectedBytes <= 0) {
    return "--";
  }
  const downloadedBytes = Math.max(
    0,
    Math.floor(Number(entry.downloadedBytes || 0) || 0),
  );
  const progress = Math.min(
    100,
    Math.max(0, Math.floor((downloadedBytes / expectedBytes) * 100)),
  );
  return `${progress}%`;
}

function formatDownloadStatus(entry: ActiveDownloadEntry): string {
  const progress = formatDownloadProgress(entry);
  if (isDownloadComplete(entry)) {
    return `${progress} done`;
  }
  const eta = formatDownloadEta(entry);
  return `${progress} • ${eta}`;
}

function isDownloadComplete(entry: ActiveDownloadEntry): boolean {
  const expectedBytes = Math.max(0, Number(entry.expectedBytes || 0) || 0);
  const downloadedBytes = Math.max(
    0,
    Math.floor(Number(entry.downloadedBytes || 0) || 0),
  );
  return expectedBytes > 0 && downloadedBytes >= expectedBytes;
}

function formatDownloadEta(entry: ActiveDownloadEntry): string {
  const expectedBytes = Math.max(0, Number(entry.expectedBytes || 0) || 0);
  const downloadedBytes = Math.max(
    0,
    Math.floor(Number(entry.downloadedBytes || 0) || 0),
  );
  const elapsedSeconds = Math.max(
    0,
    Math.floor(
      (Date.now() - Math.max(0, Number(entry.startedAt || 0) || 0)) / 1000,
    ),
  );

  if (expectedBytes <= 0 || downloadedBytes <= 0 || elapsedSeconds < 5) {
    return "ETA --";
  }

  const remainingBytes = Math.max(0, expectedBytes - downloadedBytes);
  if (remainingBytes <= 0) {
    return "ETA done";
  }

  const bytesPerSecond = downloadedBytes / elapsedSeconds;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "ETA --";
  }

  const etaSeconds = Math.ceil(remainingBytes / bytesPerSecond);
  return `ETA ${formatEtaDuration(etaSeconds)}`;
}

function formatEtaDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds || 0) || 0));
  if (safeSeconds < 60) {
    return "<1m";
  }
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
}

function truncateMiddle(value: string, maxLength: number): string {
  const normalized = String(value || "").trim();
  const safeLength = Math.max(8, Math.floor(Number(maxLength || 0) || 0));
  const graphemes = Array.from(normalized);
  if (graphemes.length <= safeLength) {
    return normalized;
  }
  const headLength = Math.max(3, Math.floor((safeLength - 1) / 2));
  const tailLength = Math.max(3, safeLength - headLength - 1);
  const head = graphemes.slice(0, headLength).join("");
  const tail = graphemes.slice(-tailLength).join("");
  return `${head}…${tail}`;
}

function areActiveDownloadsEqual(
  left: ActiveDownloadEntry[],
  right: ActiveDownloadEntry[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (
      leftEntry.id !== rightEntry.id ||
      leftEntry.pid !== rightEntry.pid ||
      leftEntry.outputPath !== rightEntry.outputPath ||
      leftEntry.title !== rightEntry.title ||
      leftEntry.mode !== rightEntry.mode ||
      leftEntry.startedAt !== rightEntry.startedAt ||
      leftEntry.expectedBytes !== rightEntry.expectedBytes ||
      leftEntry.downloadedBytes !== rightEntry.downloadedBytes
    ) {
      return false;
    }
  }

  return true;
}

async function startBackgroundDownload(
  job: DownloadJob,
): Promise<{ outputPath: string; pid: number }> {
  const outputDirectory = normalizeDownloadDirectory(job.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });

  const outputPath = reserveDownloadOutputPath(
    outputDirectory,
    job.suggestedFilename,
    job.fallbackTitle,
    job.sourceUrl,
    job.mode,
  );

  if (job.mode === "mp4") {
    if (isLikelyMp4Source(job.sourceUrl, job.suggestedFilename)) {
      const pid = await spawnDetached(
        "curl",
        buildCurlDownloadArgs(job.sourceUrl, outputPath),
      );
      return { outputPath, pid };
    }

    await assertCommandAvailable(
      job.ffmpegBinary,
      ["-version"],
      "Unable to run ffmpeg. Set the FFMPEG Binary preference if needed.",
    );
    const pid = await spawnDetached("sh", [
      "-c",
      buildFfmpegBestQualityCommand(
        job.ffmpegBinary,
        job.sourceUrl,
        outputPath,
      ),
    ]);
    return { outputPath, pid };
  }

  const pid = await spawnDetached(
    "curl",
    buildCurlDownloadArgs(job.sourceUrl, outputPath),
  );
  return { outputPath, pid };
}

function reserveDownloadOutputPath(
  outputDirectory: string,
  suggestedFilename: string,
  fallbackTitle: string,
  sourceUrl: string,
  mode: DownloadMode,
): string {
  const desiredFilename = buildDownloadFilename(
    suggestedFilename,
    fallbackTitle,
    sourceUrl,
    mode,
  );
  const extension = extname(desiredFilename);
  const stem = extension
    ? desiredFilename.slice(0, -extension.length)
    : desiredFilename;

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? "" : ` (${attempt})`;
    const candidate = join(outputDirectory, `${stem}${suffix}${extension}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }

  return join(
    outputDirectory,
    `${stem}-${Date.now()}${extension || inferDownloadExtensionFromSourceUrl(sourceUrl) || ".mkv"}`,
  );
}

function buildDownloadFilename(
  suggestedFilename: string,
  fallbackTitle: string,
  sourceUrl: string,
  mode: DownloadMode,
): string {
  const cleanSuggested = sanitizeDownloadFilename(
    basename(String(suggestedFilename || "").trim()),
  );
  const cleanFallback = sanitizeDownloadFilename(fallbackTitle);
  const fallbackStem = stripFilenameExtension(cleanFallback);
  const suggestedStem = stripFilenameExtension(cleanSuggested);
  const suggestedExtension = extname(cleanSuggested).toLowerCase();

  if (mode === "mp4") {
    return `${suggestedStem || fallbackStem || DEFAULT_DOWNLOAD_BASENAME}.mp4`;
  }

  const extension =
    suggestedExtension ||
    inferDownloadExtensionFromSourceUrl(sourceUrl) ||
    ".mkv";
  return `${suggestedStem || fallbackStem || DEFAULT_DOWNLOAD_BASENAME}${extension}`;
}

function isLikelyMp4Source(
  sourceUrl: string,
  suggestedFilename: string,
): boolean {
  const suggestedExtension = extname(
    basename(String(suggestedFilename || "").trim()),
  ).toLowerCase();
  if (suggestedExtension === ".mp4") {
    return true;
  }

  return inferDownloadExtensionFromSourceUrl(sourceUrl) === ".mp4";
}

function sanitizeDownloadFilename(value: string): string {
  return String(value || "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFilenameExtension(value: string): string {
  const cleanValue = String(value || "").trim();
  const extension = extname(cleanValue);
  if (!extension) {
    return cleanValue;
  }
  return cleanValue.slice(0, -extension.length);
}

function inferDownloadExtensionFromSourceUrl(sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl);
    const extension = extname(parsed.pathname || "").toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/.test(extension)) {
      return extension;
    }
  } catch {
    // Ignore invalid URLs and fall back to defaults.
  }
  return "";
}

function buildCurlDownloadArgs(
  sourceUrl: string,
  outputPath: string,
): string[] {
  return [
    "-L",
    "--fail",
    "--retry",
    "3",
    "--retry-delay",
    "2",
    "--output",
    outputPath,
    sourceUrl,
  ];
}

function buildFfmpegDownloadArgs(
  sourceUrl: string,
  outputPath: string,
  audioMode: "copy" | "aac",
): string[] {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourceUrl,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:v",
    "copy",
  ];

  if (audioMode === "copy") {
    args.push("-c:a", "copy");
  } else {
    args.push("-c:a", "aac", "-b:a", DOWNLOAD_FFMPEG_AUDIO_BITRATE);
  }

  args.push("-movflags", "+faststart", outputPath);
  return args;
}

function buildFfmpegBestQualityCommand(
  ffmpegBinary: string,
  sourceUrl: string,
  outputPath: string,
): string {
  const copyArgs = buildFfmpegDownloadArgs(sourceUrl, outputPath, "copy")
    .map(shellQuote)
    .join(" ");
  const aacArgs = buildFfmpegDownloadArgs(sourceUrl, outputPath, "aac")
    .map(shellQuote)
    .join(" ");
  const ffmpeg = shellQuote(ffmpegBinary);
  return `${ffmpeg} ${copyArgs} || ${ffmpeg} ${aacArgs}`;
}

function shellQuote(value: string): string {
  const raw = String(value || "");
  if (!raw) {
    return "''";
  }
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function assertCommandAvailable(
  command: string,
  args: string[],
  notFoundMessage: string,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: "ignore",
    });

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        rejectPromise(new Error(`${command} check timed out.`));
      }
    }, 4000);

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        rejectPromise(
          new Error(`${notFoundMessage} (${toErrorMessage(error)})`),
        );
      }
    });

    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        if (code === 0) {
          resolvePromise();
        } else {
          rejectPromise(new Error(notFoundMessage));
        }
      }
    });
  });
}

async function launchPlayerPlayback(
  playerBinary: string,
  sourceUrl: string,
  title: string,
): Promise<void> {
  const args = buildPlayerLaunchArgs(playerBinary, sourceUrl, title);
  const fallbackApp = resolveMacAppFallbackName(playerBinary);

  try {
    await spawnDetached(playerBinary, args);
  } catch (primaryError) {
    try {
      await spawnDetached("open", ["-a", fallbackApp, sourceUrl]);
    } catch (fallbackError) {
      throw new Error(
        `Unable to launch ${playerBinary} (${toErrorMessage(primaryError)}). macOS open fallback failed (${toErrorMessage(
          fallbackError,
        )}).`,
      );
    }
  }
}

function buildPlayerLaunchArgs(
  playerBinary: string,
  sourceUrl: string,
  title: string,
): string[] {
  const lowerBinary = String(playerBinary || "").toLowerCase();
  if (lowerBinary.includes("vlc")) {
    const args = ["--play-and-exit"];
    if (title) {
      args.push(`--meta-title=${title}`);
    }
    args.push(sourceUrl);
    return args;
  }

  const args = ["--force-window=yes", "--idle=no", "--keep-open=no"];
  if (title) {
    args.push(`--title=${title}`);
  }
  args.push(sourceUrl);
  return args;
}

function resolveMacAppFallbackName(playerBinary: string): string {
  const lowerBinary = String(playerBinary || "").toLowerCase();
  if (lowerBinary.includes("vlc")) {
    return "VLC";
  }
  return "mpv";
}

function spawnDetached(command: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    const pid = Number(child.pid || 0);

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });

    child.once("exit", (code) => {
      if (!settled && typeof code === "number" && code !== 0) {
        settled = true;
        rejectPromise(new Error(`Process exited early with code ${code}.`));
      }
    });

    child.unref();
    setTimeout(() => {
      if (!settled) {
        settled = true;
        if (pid > 0) {
          resolvePromise(pid);
        } else {
          rejectPromise(new Error("Failed to start detached process."));
        }
      }
    }, 120);
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = String(error.message || "").trim();
    if (/service_unavailable/i.test(message)) {
      return "Real-Debrid is temporarily unavailable (service_unavailable). Please retry in a moment.";
    }
    return message;
  }
  return String(error || "Unknown error");
}

function isTransientProviderError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes("service_unavailable") ||
    message.includes("temporarily unavailable") ||
    message.includes("request timed out") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("too many requests") ||
    message.includes("request failed (429)") ||
    message.includes("request failed (502)") ||
    message.includes("request failed (503)") ||
    message.includes("request failed (504)")
  );
}
