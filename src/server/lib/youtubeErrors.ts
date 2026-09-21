export class YoutubeTokenError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "YoutubeTokenError";
  }
}

export class YoutubeDataApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly upstreamReason: string | null = null,
  ) {
    super(message);
    this.name = "YoutubeDataApiError";
  }
}

export class YoutubeAnalyticsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
    public readonly upstreamReason: string | null = null,
  ) {
    super(message);
    this.name = "YoutubeAnalyticsApiError";
  }
}

export class YoutubeMalformedResponseError extends Error {
  constructor() {
    super("YouTube returned an invalid response.");
    this.name = "YoutubeMalformedResponseError";
  }
}

type YoutubeReportErrorCode =
  | "validation_error"
  | "youtube_not_connected"
  | "youtube_reconnect_required"
  | "youtube_channel_inaccessible"
  | "youtube_quota_exhausted"
  | "youtube_upstream_unavailable"
  | "youtube_malformed_response";

export class YoutubeReportError extends Error {
  constructor(
    public readonly code: YoutubeReportErrorCode,
    message: string,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "YoutubeReportError";
  }
}

/**
 * Normalize the YouTube client failure surface into report errors the server
 * functions and MCP tools can branch on. Validation errors pass through
 * unchanged; unexpected errors are rethrown so real faults still page.
 */
export function asYoutubeReportError(error: unknown): unknown {
  if (error instanceof YoutubeReportError) return error;
  if (error instanceof YoutubeTokenError) {
    return new YoutubeReportError(
      "youtube_reconnect_required",
      "The YouTube connection has expired or was revoked. Reconnect the Google account.",
    );
  }
  if (
    error instanceof YoutubeDataApiError ||
    error instanceof YoutubeAnalyticsApiError
  ) {
    if (error.status === 401) {
      return new YoutubeReportError(
        "youtube_reconnect_required",
        "The YouTube connection has expired or was revoked. Reconnect the Google account.",
      );
    }
    if (error.status === 403) {
      return /quota/i.test(error.upstreamReason ?? "")
        ? new YoutubeReportError(
            "youtube_quota_exhausted",
            "The YouTube API quota for this Google Cloud project is exhausted. Try again after the quota resets.",
          )
        : new YoutubeReportError(
            "youtube_channel_inaccessible",
            "YouTube denied access to this channel. Check that the connected Google account still manages it.",
          );
    }
    if (error.status === 400 || error.status === 404) {
      return new YoutubeReportError("validation_error", error.message);
    }
    return new YoutubeReportError(
      "youtube_upstream_unavailable",
      "YouTube reporting is temporarily unavailable.",
      error instanceof YoutubeAnalyticsApiError
        ? error.retryAfterSeconds
        : null,
    );
  }
  if (error instanceof YoutubeMalformedResponseError) {
    return new YoutubeReportError(
      "youtube_malformed_response",
      "YouTube returned an invalid response.",
    );
  }
  return error;
}
