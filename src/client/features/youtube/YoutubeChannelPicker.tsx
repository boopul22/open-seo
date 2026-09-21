import { GooglePropertyPicker } from "@/client/features/integrations/GooglePropertyPicker";

type ChannelOption = {
  channelId: string;
  title: string;
  handle: string | null;
  subscriberCount: number | null;
};

type AccountOption = {
  accountId: string;
  email: string | null;
  requiresReconnect: boolean;
  channelsUnavailable: boolean;
  channels: ChannelOption[];
};

export type YoutubeChannelSelection = {
  accountId: string;
  channelId: string;
};

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

function channelDetail(channel: ChannelOption): string {
  const parts: string[] = [];
  if (channel.handle) parts.push(channel.handle);
  if (channel.subscriberCount !== null) {
    parts.push(`${compact.format(channel.subscriberCount)} subscribers`);
  }
  parts.push(channel.channelId);
  return parts.join(" · ");
}

export function YoutubeChannelPicker(props: {
  readOnly?: boolean;
  loading: boolean;
  linking?: boolean;
  error: boolean;
  accounts: AccountOption[];
  selection: YoutubeChannelSelection | null;
  onSelect: (selection: YoutubeChannelSelection | null) => void;
  onSave: () => void;
  saving: boolean;
  onRetry: () => void;
  onReconnect: () => void;
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  // The shared picker is keyed on "property"; adapt channel selections to it
  // so the picker itself stays provider-agnostic.
  return (
    <GooglePropertyPicker
      {...props}
      provider="youtube"
      itemNoun="channel"
      saveLabel="Save channel"
      selection={
        props.selection
          ? {
              accountId: props.selection.accountId,
              propertyId: props.selection.channelId,
            }
          : null
      }
      onSelect={(selection) =>
        props.onSelect(
          selection
            ? {
                accountId: selection.accountId,
                channelId: selection.propertyId,
              }
            : null,
        )
      }
      accounts={props.accounts.map((account) => ({
        ...account,
        unavailable: account.channelsUnavailable,
        properties: account.channels.map((channel) => ({
          id: channel.channelId,
          name: channel.title || channel.channelId,
          detail: channelDetail(channel),
          selectable: true,
        })),
      }))}
    />
  );
}
