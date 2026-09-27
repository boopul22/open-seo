export class GscApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "GscApiError";
  }
}

export class GscTokenError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GscTokenError";
  }
}

export class GscNotConnectedError extends Error {
  constructor(public readonly projectId: string) {
    super("Search Console is not connected for this project");
    this.name = "GscNotConnectedError";
  }
}

/** Google answers an exhausted per-day quota with a 429 whose message names
 *  the daily limit ("Queries per day"). Per-minute 429s clear in seconds and
 *  are retried; a daily one lasts until midnight Pacific Time. */
export function isGscDailyQuotaError(status: number, body = ""): boolean {
  return status === 429 && /per ?day|daily/i.test(body);
}
