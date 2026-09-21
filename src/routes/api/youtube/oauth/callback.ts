import { createFileRoute } from "@tanstack/react-router";
import {
  handleSelfHostedGoogleOAuthCallbackRequest,
  YOUTUBE_INTEGRATION,
} from "@/server/features/google/selfHostedOAuth";

export const Route = createFileRoute("/api/youtube/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) =>
        handleSelfHostedGoogleOAuthCallbackRequest(
          request,
          YOUTUBE_INTEGRATION,
        ),
    },
  },
});
