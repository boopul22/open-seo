import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { formatRelativeTime } from "@/client/lib/relative-time";
import {
  addYoutubeResearchChannel,
  listYoutubeResearchChannels,
  refreshYoutubeResearchChannels,
  removeYoutubeResearchChannel,
} from "@/serverFunctions/youtubeResearch";

// Mirrors MAX_RESEARCH_CHANNELS in YoutubeResearchService; the server rejects
// anything past the cap, this copy just sets expectations beforehand.
const MAX_RESEARCH_CHANNELS = 20;

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

/** Tracked channels for competitor research: add by URL, @handle, or UC id. */
export function YoutubeResearchChannels({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [channelInput, setChannelInput] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const channelsQuery = useQuery({
    queryKey: ["youtubeResearchChannels", projectId],
    queryFn: () => listYoutubeResearchChannels({ data: { projectId } }),
    enabled: open,
  });
  const channels = channelsQuery.data?.channels ?? [];
  const atCap = channels.length >= MAX_RESEARCH_CHANNELS;

  const invalidateChannels = () => {
    void queryClient.invalidateQueries({
      queryKey: ["youtubeResearchChannels", projectId],
    });
  };
  const invalidateResults = () => {
    void queryClient.invalidateQueries({
      queryKey: ["youtubeOutliers", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["youtubeChannelVideos", projectId],
    });
  };

  const addMutation = useMutation({
    mutationFn: (channel: string) =>
      addYoutubeResearchChannel({ data: { projectId, channel } }),
    onSuccess: (result) => {
      toast.success(`Now tracking ${result.channel.channelTitle}`);
      setChannelInput("");
      invalidateChannels();
      invalidateResults();
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Could not add channel"));
    },
  });
  const removeMutation = useMutation({
    mutationFn: (channelId: string) =>
      removeYoutubeResearchChannel({ data: { projectId, channelId } }),
    onSuccess: () => {
      toast.success("Channel removed");
      invalidateChannels();
      invalidateResults();
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Could not remove channel"));
    },
  });
  const refreshMutation = useMutation({
    mutationFn: () => refreshYoutubeResearchChannels({ data: { projectId } }),
    onSuccess: (result) => {
      // The refresh already returned fresh rows, so seed the list instead of
      // paying for another fetch.
      queryClient.setQueryData(["youtubeResearchChannels", projectId], {
        channels: result.channels,
      });
      invalidateResults();
      toast.success(
        `Refreshed ${result.channels.length} ${
          result.channels.length === 1 ? "channel" : "channels"
        }`,
      );
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Could not refresh channels"));
    },
  });

  if (!open) return null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const channel = channelInput.trim();
    if (!channel || addMutation.isPending) return;
    addMutation.mutate(channel);
  };

  const addError = addMutation.isError
    ? getStandardErrorMessage(addMutation.error, "Could not add channel")
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="youtube-research-channels-title"
        className="mt-10 w-full max-w-2xl rounded-xl border border-base-300 bg-base-100 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-base-300 px-5 py-4">
          <div>
            <h2
              id="youtube-research-channels-title"
              className="text-base font-semibold"
            >
              Research channels
            </h2>
            <p className="text-xs text-base-content/60">
              Track up to {MAX_RESEARCH_CHANNELS} channels to find their
              breakout videos. Videos from your own channel are always scored
              too.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending || channels.length === 0}
            >
              {refreshMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Refresh
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-square btn-sm"
              onClick={onClose}
              aria-label="Close research channels"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="space-y-4 p-5">
          <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={channelInput}
              onChange={(event) => setChannelInput(event.target.value)}
              placeholder="youtube.com/@handle, @handle, or UC… channel ID"
              aria-label="Channel to track"
              className="input input-bordered input-sm w-full"
              disabled={atCap || addMutation.isPending}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm shrink-0"
              disabled={atCap || addMutation.isPending || !channelInput.trim()}
            >
              <Plus className="size-4" />
              Add channel
            </button>
          </form>
          {atCap ? (
            <p className="text-xs text-warning">
              You&rsquo;ve reached the {MAX_RESEARCH_CHANNELS}-channel limit.
              Remove one to add another.
            </p>
          ) : null}
          {addError ? (
            <p role="alert" className="text-sm text-error">
              {addError}
            </p>
          ) : null}

          {channelsQuery.isPending ? (
            <div aria-busy className="space-y-2">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="skeleton h-12 rounded-lg" />
              ))}
            </div>
          ) : channelsQuery.isError ? (
            <div role="alert" className="space-y-2 text-sm">
              <p className="text-error">
                {getStandardErrorMessage(channelsQuery.error)}
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void channelsQuery.refetch()}
              >
                Try again
              </button>
            </div>
          ) : channels.length === 0 ? (
            <p className="text-sm text-base-content/70">
              No research channels yet. Add a channel to discover its outlier
              videos.
            </p>
          ) : (
            <ul className="divide-y divide-base-300 rounded-lg border border-base-300">
              {channels.map((channel) => (
                <li
                  key={channel.channelId}
                  className="flex items-center gap-3 p-3"
                >
                  {channel.channelThumbnailUrl ? (
                    <img
                      src={channel.channelThumbnailUrl}
                      alt=""
                      loading="lazy"
                      className="size-9 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <div className="size-9 shrink-0 rounded-full bg-base-200" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {channel.channelTitle}
                    </p>
                    <p className="truncate text-xs text-base-content/60">
                      {[
                        channel.channelHandle,
                        channel.subscriberCount === null
                          ? null
                          : `${compact.format(channel.subscriberCount)} subscribers`,
                        channel.lastRefreshedAt
                          ? `refreshed ${formatRelativeTime(channel.lastRefreshedAt)}`
                          : "not refreshed yet",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-square btn-sm text-base-content/60"
                    aria-label={`Remove ${channel.channelTitle}`}
                    onClick={() => removeMutation.mutate(channel.channelId)}
                    disabled={
                      removeMutation.isPending &&
                      removeMutation.variables === channel.channelId
                    }
                  >
                    {removeMutation.isPending &&
                    removeMutation.variables === channel.channelId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
