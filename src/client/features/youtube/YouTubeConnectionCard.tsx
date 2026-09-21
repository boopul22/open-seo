import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { youtubeConnectionOptions } from "@/client/features/integrations/googleConnectionQueries";
import { GoogleConnectedState } from "@/client/features/integrations/GoogleConnectedState";
import { useGooglePickerResume } from "@/client/features/integrations/useGooglePickerResume";
import { GoogleProjectEmptyState } from "@/client/features/integrations/GoogleProjectEmptyState";
import { GoogleLinkErrorAlert } from "@/client/features/integrations/GoogleLinkErrorAlert";
import { GoogleOAuthSetupWarning } from "@/client/features/integrations/GoogleOAuthSetupWarning";
import { IntegrationConnectionCard } from "@/client/features/integrations/IntegrationConnectionCard";
import { YouTubeLogo } from "@/client/features/integrations/GoogleProductLogos";
import { YoutubeAnalyticsPanel } from "@/client/features/youtube/YoutubeAnalyticsPanel";
import {
  YoutubeChannelPicker,
  type YoutubeChannelSelection,
} from "@/client/features/youtube/YoutubeChannelPicker";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { captureClientEvent } from "@/client/lib/posthog";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import {
  disconnectYoutube,
  listYoutubeChannels,
  setYoutubeChannel,
} from "@/serverFunctions/youtube";
import { YOUTUBE_SELF_HOSTED_SETUP_DOCS_URL } from "@/shared/youtube";

export function YouTubeConnectionCard({
  projectId,
  onDismiss,
  dismissing = false,
  heading,
}: {
  projectId: string;
  onDismiss?: () => void;
  dismissing?: boolean;
  heading?: React.ReactNode;
}) {
  const hosted = isHostedClientAuthMode();
  const queryClient = useQueryClient();
  const { picking, setPicking, linkAccount, linking } = useGooglePickerResume(
    "youtube",
    projectId,
  );
  const [selection, setSelection] =
    React.useState<YoutubeChannelSelection | null>(null);
  const connectionOptions = youtubeConnectionOptions(projectId);
  const connectionKey = connectionOptions.queryKey;
  const connectionQuery = useQuery(connectionOptions);
  const connection = connectionQuery.data;
  const connectionUnavailable = connectionQuery.isError && !connection;
  const connected = Boolean(connection?.connected);
  const hasGrant = Boolean(connection?.currentUserHasGrant);
  const canManage = connection?.canManage === true;
  const selfHostedNeedsSetup =
    !hosted && connectionQuery.isSuccess && !connection?.googleOAuthConfigured;
  const showPicker = picking ?? (!connected && hasGrant && canManage);
  const channelsQuery = useQuery({
    queryKey: ["youtubeChannels", projectId],
    queryFn: () => listYoutubeChannels({ data: { projectId } }),
    enabled: Boolean(showPicker && !selfHostedNeedsSetup),
  });
  const accounts = React.useMemo(
    () => channelsQuery.data?.accounts ?? [],
    [channelsQuery.data?.accounts],
  );

  React.useEffect(() => {
    if (!picking || !connected || selection) return;
    for (const account of accounts) {
      const selectedChannel = account.channels.find(
        (channel) => channel.isSelected,
      );
      if (selectedChannel) {
        setSelection({
          accountId: account.accountId,
          channelId: selectedChannel.channelId,
        });
        return;
      }
    }
  }, [accounts, selection, picking, connected]);

  const invalidateReports = () => {
    void queryClient.invalidateQueries({
      queryKey: ["dashboardActivation", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["youtubeChannelOverview", projectId],
    });
  };
  const setChannelMutation = useMutation({
    mutationFn: (selected: YoutubeChannelSelection) =>
      setYoutubeChannel({ data: { projectId, ...selected } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(connectionKey, (current: typeof connection) =>
        current ? { ...current, ...saved } : current,
      );
      captureClientEvent("youtube:channel_select");
      toast.success("YouTube channel connected");
      queryClient.removeQueries({ queryKey: ["youtubeChannels", projectId] });
      void queryClient.invalidateQueries({ queryKey: connectionKey });
      setPicking(false);
      invalidateReports();
    },
  });
  const disconnectMutation = useMutation({
    mutationFn: () => disconnectYoutube({ data: { projectId } }),
    onSuccess: () => {
      toast.success("YouTube disconnected from this project");
      queryClient.setQueryData(connectionKey, (current: typeof connection) =>
        current ? { ...current, connected: false } : current,
      );
      queryClient.removeQueries({ queryKey: ["youtubeChannels", projectId] });
      setPicking(false);
      setSelection(null);
      void queryClient.invalidateQueries({ queryKey: connectionKey });
      invalidateReports();
    },
  });
  const changingConnection =
    setChannelMutation.isPending || disconnectMutation.isPending || linking;
  const dismissDisabled = dismissing || changingConnection;
  const handleConnect = () => void linkAccount(window.location.href);

  return (
    <>
      {heading}
      <IntegrationConnectionCard
        title="YouTube"
        icon={<YouTubeLogo className="size-5" />}
        status={
          connectionQuery.isPending || connectionUnavailable
            ? undefined
            : selfHostedNeedsSetup
              ? "setup_required"
              : connected
                ? "connected"
                : "disconnected"
        }
      >
        <GoogleLinkErrorAlert provider="youtube" className="mb-4" />
        {connectionQuery.isPending ? (
          <div
            role="status"
            aria-label="Loading connection"
            className="space-y-3 animate-pulse"
          >
            <div className="h-4 w-2/3 rounded bg-base-200" />
            <div className="h-9 w-24 rounded bg-base-200" />
          </div>
        ) : connectionUnavailable ? (
          <div role="alert" className="space-y-3 text-sm">
            <p className="text-error">
              Couldn't check this project's connection.
            </p>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void connectionQuery.refetch()}
            >
              Try again
            </button>
          </div>
        ) : selfHostedNeedsSetup ? (
          <div className="space-y-3">
            <GoogleOAuthSetupWarning
              integrationName="YouTube"
              docsUrl={YOUTUBE_SELF_HOSTED_SETUP_DOCS_URL}
            />
            <DismissButton onClick={onDismiss} disabled={dismissDisabled} />
          </div>
        ) : connected && !picking ? (
          <>
            <GoogleConnectedState
              property={connection?.channelTitle ?? ""}
              detail={connection?.channelId}
              email={connection?.connectedByEmail}
              changeLabel="Change channel or account"
              canManageAccounts={hasGrant}
              onChange={() => {
                setChannelMutation.reset();
                disconnectMutation.reset();
                setSelection(null);
                setPicking(true);
              }}
              onDisconnect={() => {
                setChannelMutation.reset();
                disconnectMutation.mutate();
              }}
              disconnecting={disconnectMutation.isPending}
              disabled={linking}
              canManage={canManage}
            />
            <div className="mt-4 border-t border-base-300 pt-4">
              <YoutubeAnalyticsPanel projectId={projectId} />
            </div>
          </>
        ) : showPicker ? (
          <fieldset disabled={changingConnection}>
            <YoutubeChannelPicker
              readOnly={!canManage}
              linking={linking}
              loading={channelsQuery.isLoading}
              error={channelsQuery.isError}
              accounts={accounts}
              selection={selection}
              onSelect={setSelection}
              onSave={() => selection && setChannelMutation.mutate(selection)}
              saving={setChannelMutation.isPending}
              secondaryAction={{
                label: "Cancel",
                disabled: setChannelMutation.isPending,
                onClick: () => {
                  setPicking(false);
                  setSelection(null);
                  setChannelMutation.reset();
                },
              }}
              onRetry={() => void channelsQuery.refetch()}
              onReconnect={handleConnect}
            />
          </fieldset>
        ) : (
          <GoogleProjectEmptyState
            name="YouTube"
            noun="channel"
            hasGrant={hasGrant}
            canManage={canManage}
            disabled={linking}
            onLink={handleConnect}
            onChoose={() => {
              setChannelMutation.reset();
              disconnectMutation.reset();
              setSelection(null);
              setPicking(true);
            }}
          >
            <DismissButton onClick={onDismiss} disabled={dismissDisabled} />
          </GoogleProjectEmptyState>
        )}
        {showPicker && onDismiss && !connected ? (
          <DismissButton onClick={onDismiss} disabled={dismissDisabled} />
        ) : null}
        {setChannelMutation.isError || disconnectMutation.isError ? (
          <p role="alert" className="mt-3 text-sm text-error">
            {getStandardErrorMessage(
              setChannelMutation.error ?? disconnectMutation.error,
            )}
          </p>
        ) : null}
        {connectionQuery.isSuccess && !selfHostedNeedsSetup && !canManage ? (
          <p className="mt-3 text-sm text-base-content/60">
            Ask an organization owner or admin to change this project's
            connection.
          </p>
        ) : null}
      </IntegrationConnectionCard>
    </>
  );
}

function DismissButton({
  onClick,
  disabled,
}: {
  onClick?: () => void;
  disabled: boolean;
}) {
  if (!onClick) return null;
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm text-base-content/60"
      onClick={onClick}
      disabled={disabled}
    >
      Dismiss
    </button>
  );
}
