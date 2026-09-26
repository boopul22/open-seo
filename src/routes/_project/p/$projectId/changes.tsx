import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ChangeLogPage } from "@/client/features/seo-changes/ChangeLogPage";

const searchSchema = z.object({
  changeId: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_project/p/$projectId/changes")({
  validateSearch: searchSchema,
  component: ChangeLogRoute,
});

function ChangeLogRoute() {
  const { projectId } = Route.useParams();
  const { changeId } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ChangeLogPage
      projectId={projectId}
      selectedChangeId={changeId}
      onSelect={(next) => void navigate({ search: { changeId: next } })}
    />
  );
}
