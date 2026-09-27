import { createFileRoute } from "@tanstack/react-router";
import { PageSpeedPage } from "@/client/features/pagespeed/PageSpeedPage";

export const Route = createFileRoute("/_project/p/$projectId/pagespeed")({
  component: PageSpeedRoute,
});

function PageSpeedRoute() {
  const { projectId } = Route.useParams();
  return <PageSpeedPage projectId={projectId} />;
}
