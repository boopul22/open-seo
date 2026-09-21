# Self-hosted YouTube

Connecting YouTube binds a channel to an OpenSEO project. The connection is
read-only: channel metadata, video lists, and YouTube Analytics reports. It
never posts, edits, or uploads.

Each Google account that owns a channel connects as its own grant, so one
OpenSEO workspace can manage several channels across several Google accounts —
for example a personal channel and a brand-account channel.

## What you'll need

- A Google account that manages the channel (owner or manager access).
- A Google Cloud project with OAuth credentials.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BETTER_AUTH_SECRET` set on
  the OpenSEO deployment.

If Search Console or Google Analytics is already connected, reuse the same
Google Cloud project and OAuth client. YouTube still asks for a separate
consent grant because it requests different scopes.

## 1) Enable the APIs

In the [Google Cloud Console](https://console.cloud.google.com/), enable both:

- [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
- [YouTube Analytics API](https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com)

The Data API lists channels and video metadata. The Analytics API powers the
views/watch-time/subscriber reports.

## 2) Configure the OAuth consent screen

Under **APIs & Services → OAuth consent screen**, configure the app. While the
app is in Testing, add every Google account that will connect as a test user —
including each brand account's owner account.

YouTube scopes are sensitive, so a published (External, non-testing) app needs
Google's verification for these scopes. Test users work without verification.

## 3) Register the callback URL

Open **APIs & Services → Credentials**, edit the Web application OAuth client,
and add an authorized redirect URI matching the deployment origin plus
`/api/youtube/oauth/callback`.

| Deployment   | Redirect URI                                                 |
| ------------ | ------------------------------------------------------------ |
| Deployed     | `https://your-openseo-domain.com/api/youtube/oauth/callback` |
| Local Docker | `http://localhost:3001/api/youtube/oauth/callback`           |

Keep the existing `/api/gsc/oauth/callback` and `/api/ga4/oauth/callback` URIs
if those integrations use the same client.

## 4) Set environment variables

The same three variables as the other Google integrations; nothing
YouTube-specific:

| Variable               | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Web application client ID.                                |
| `GOOGLE_CLIENT_SECRET` | Web application client secret.                            |
| `BETTER_AUTH_SECRET`   | Random string of at least 32 characters for token crypto. |

Generate the encryption secret with:

```sh
openssl rand -base64 32
```

## 5) Connect a channel

Open **Project settings → Integrations → YouTube**, click **Connect**, approve
read-only YouTube access, and choose a channel. To add a channel on another
Google account, click **Add Google account** in the picker and repeat the flow —
each account's channels appear under its own heading.

OpenSEO stores the OAuth tokens encrypted in Better Auth's account table under
the `google-youtube` provider. The project mapping stores only the selected
channel metadata and connector account. Disconnecting YouTube does not
disconnect Search Console or Google Analytics.

## Troubleshooting

**`redirect_uri_mismatch`** — make sure the registered URI exactly matches the
scheme, host, port, and `/api/youtube/oauth/callback` path used by the
deployment.

**No channels appear** — confirm that the YouTube Data API is enabled and the
connected Google account actually manages a channel. A Google account with no
channel returns an empty list.

**Wrong channel for a brand account** — Google chooses the channel on its own
consent screen. Reconnect with **Add Google account** and pick the brand
account, then select its channel in the picker.

**Connection expired** — reconnect the Google account. OAuth apps left in
Google's Testing status can receive short-lived refresh grants.

**`quotaExceeded`** — YouTube Data API quotas are per Google Cloud project
(10,000 units/day by default). Channel and video reads cost 1 unit each;
Analytics reports cost about 1–2. Raise the quota in the Cloud Console if
agents poll many channels heavily.
