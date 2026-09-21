import { Link } from "@tanstack/react-router";
import {
  CardShell,
  moreDetailsClass,
} from "@/client/features/dashboard/cardParts";
import { YoutubeAnalyticsPanel } from "@/client/features/youtube/YoutubeAnalyticsPanel";

export function YouTubeCard({
  projectId,
  channelTitle,
}: {
  projectId: string;
  channelTitle: string | null;
}) {
  return (
    <CardShell
      title="YouTube"
      stamp={channelTitle ? `${channelTitle} · last 28 days` : "Last 28 days"}
      action={
        <Link
          to="/p/$projectId/settings"
          params={{ projectId }}
          hash="youtube"
          className={moreDetailsClass}
        >
          Manage
        </Link>
      }
    >
      <YoutubeAnalyticsPanel projectId={projectId} showRangeLabel={false} />
    </CardShell>
  );
}
