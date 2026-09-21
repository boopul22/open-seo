import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Globe, Plus, Youtube } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/client/components/Modal";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { setLastProjectId } from "@/client/lib/active-project";
import {
  DEFAULT_LOCATION_CODE,
  getLanguageCode,
} from "@/client/features/keywords/locations";
import { GoogleLinkErrorAlert } from "@/client/features/integrations/GoogleLinkErrorAlert";
import { useGooglePickerResume } from "@/client/features/integrations/useGooglePickerResume";
import { ProjectMarketFields } from "@/client/features/projects/ProjectMarketFields";
import { createProject } from "@/serverFunctions/projects";
import { listYoutubeChannelsForUser } from "@/serverFunctions/youtube";
import type { ProjectType } from "@/shared/project-type";

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

type ChannelSelection = { accountId: string; channelId: string };

export function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { picking, linkAccount, linking } = useGooglePickerResume(
    "youtube",
    "new-project",
  );
  const [projectType, setProjectType] = React.useState<ProjectType>(
    picking ? "youtube" : "website",
  );
  const [name, setName] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [selection, setSelection] = React.useState<ChannelSelection | null>(
    null,
  );
  const [market, setMarket] = React.useState({
    locationCode: DEFAULT_LOCATION_CODE,
    languageCode: getLanguageCode(DEFAULT_LOCATION_CODE),
  });

  const channelsQuery = useQuery({
    queryKey: ["youtubeChannels", "new-project"],
    queryFn: () => listYoutubeChannelsForUser(),
    enabled: projectType === "youtube",
  });
  const accounts = React.useMemo(
    () => channelsQuery.data?.accounts ?? [],
    [channelsQuery.data?.accounts],
  );
  const hasGrant = accounts.length > 0;

  const selectChannel = (
    accountId: string,
    channelId: string,
    title: string,
  ) => {
    setSelection({ accountId, channelId });
    // The channel title is the best default project name; leave a name the
    // user already typed alone.
    setName((current) => (current.trim() ? current : title));
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createProject({
        data: {
          name: name.trim(),
          domain:
            projectType === "website" ? domain.trim() || undefined : undefined,
          projectType,
          youtube:
            projectType === "youtube" && selection ? selection : undefined,
          ...market,
        },
      }),
    onSuccess: async (created) => {
      setLastProjectId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({
        queryKey: ["dashboardActivation"],
      });
      onClose();
      toast.success(
        projectType === "youtube"
          ? "YouTube project created"
          : "Project created",
      );
      // Continue setup through the new project’s dashboard.
      void navigate({
        to: "/p/$projectId",
        params: { projectId: created.id },
      });
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Failed to create project")),
  });

  const isPending = createMutation.isPending;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (isPending) return;
    if (!name.trim()) {
      toast.error("Project name is required");
      return;
    }
    if (projectType === "youtube" && !selection) {
      toast.error("Choose a YouTube channel");
      return;
    }
    createMutation.mutate();
  };

  return (
    <Modal
      maxWidth="max-w-md"
      onClose={isPending ? undefined : onClose}
      labelledBy="create-project-title"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <h2 id="create-project-title" className="text-lg font-semibold">
          New project
        </h2>

        <div
          role="tablist"
          aria-label="Project type"
          className="grid grid-cols-2 gap-1 rounded-lg bg-base-200 p-1"
        >
          <TypeTab
            active={projectType === "website"}
            icon={<Globe className="size-4" />}
            label="Website"
            onClick={() => setProjectType("website")}
          />
          <TypeTab
            active={projectType === "youtube"}
            icon={<Youtube className="size-4" />}
            label="YouTube"
            onClick={() => setProjectType("youtube")}
          />
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={projectType === "youtube" ? "My channel" : "Acme Inc."}
            maxLength={120}
            autoFocus
            className="input input-bordered w-full"
          />
        </label>

        {projectType === "website" ? (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">
              Domain <span className="text-base-content/50">(optional)</span>
            </span>
            <input
              type="text"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="example.com"
              maxLength={255}
              className="input input-bordered w-full"
            />
            <span className="text-xs text-base-content/50">
              You can connect Search Console and set up rank tracking after
              creating the project.
            </span>
          </label>
        ) : (
          <div className="space-y-2">
            <span className="text-sm font-medium">Channel</span>
            <GoogleLinkErrorAlert provider="youtube" />
            {channelsQuery.isPending ? (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-base-content/60"
              >
                <span className="loading loading-spinner loading-xs" />
                Loading channels…
              </p>
            ) : channelsQuery.isError ? (
              <div role="alert" className="text-sm">
                <p className="text-error">Couldn't load your channels.</p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mt-1"
                  onClick={() => void channelsQuery.refetch()}
                >
                  Try again
                </button>
              </div>
            ) : (
              <div className="max-h-56 space-y-2 overflow-y-auto overscroll-contain rounded-lg border border-base-300 p-2">
                {accounts.map((account) => (
                  <div key={account.accountId}>
                    <p className="px-1.5 py-1 text-xs font-medium text-base-content/55">
                      {account.email ??
                        `Google account · ${account.accountId.slice(-6)}`}
                    </p>
                    {account.requiresReconnect ? (
                      <p className="px-1.5 pb-1 text-sm text-base-content/60">
                        Connection expired — reconnect below.
                      </p>
                    ) : account.channelsUnavailable ? (
                      <p className="px-1.5 pb-1 text-sm text-base-content/60">
                        Couldn't load channels for this account.
                      </p>
                    ) : account.channels.length === 0 ? (
                      <p className="px-1.5 pb-1 text-sm text-base-content/50">
                        No channels on this account
                      </p>
                    ) : (
                      account.channels.map((channel) => {
                        const chosen =
                          selection?.accountId === account.accountId &&
                          selection.channelId === channel.channelId;
                        return (
                          <button
                            key={channel.channelId}
                            type="button"
                            aria-pressed={chosen}
                            className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-base-200 ${chosen ? "bg-base-200" : ""}`}
                            onClick={() =>
                              selectChannel(
                                account.accountId,
                                channel.channelId,
                                channel.title || channel.channelId,
                              )
                            }
                          >
                            <span className="min-w-0">
                              <span className="block truncate">
                                {channel.title || channel.channelId}
                              </span>
                              <span className="mt-0.5 block truncate text-xs text-base-content/50">
                                {[
                                  channel.handle,
                                  channel.subscriberCount !== null
                                    ? `${compact.format(channel.subscriberCount)} subscribers`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || channel.channelId}
                              </span>
                            </span>
                            {chosen ? (
                              <Check className="size-4 shrink-0" />
                            ) : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-base-200"
                  onClick={() => void linkAccount(window.location.href)}
                  disabled={linking}
                  aria-busy={linking}
                >
                  {linking ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {linking
                    ? "Opening Google…"
                    : hasGrant
                      ? "Add another Google account"
                      : "Connect with Google"}
                </button>
              </div>
            )}
            <span className="block text-xs text-base-content/50">
              YouTube Analytics for the channel shows on this project’s
              dashboard, and your AI agent can read it through the YouTube MCP
              tools.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <ProjectMarketFields value={market} onChange={setMarket} />
          <span className="text-xs text-base-content/50">
            Keyword, SERP, and domain data uses this country and language unless
            a call asks for a different one. Change it later in project
            settings.
          </span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={isPending}
          >
            Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TypeTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
        active
          ? "bg-base-100 shadow-sm"
          : "text-base-content/60 hover:text-base-content"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
