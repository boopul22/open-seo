import { createFileRoute, useParams } from "@tanstack/react-router";
import { YoutubeVideosPage } from "@/client/features/youtube/YoutubeVideosPage";

export const Route = createFileRoute("/_project/p/$projectId/videos")({
  component: YoutubeVideosRoute,
});

function YoutubeVideosRoute() {
  // Read the param from the project layout rather than this route: the
  // generated route tree types the child only after it is regenerated.
  const { projectId } = useParams({ from: "/_project/p/$projectId" });
  return <YoutubeVideosPage projectId={projectId} />;
}
