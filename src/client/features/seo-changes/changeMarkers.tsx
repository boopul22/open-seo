import { ReferenceLine } from "recharts";
import type { SeoChangeStatus, SeoChangeType } from "@/shared/seo-changes";
import { SEO_CHANGE_TYPE_LABELS } from "@/shared/seo-changes";

type ChangeMarker = {
  id: string;
  shipDate: string;
  type: SeoChangeType;
  summary: string;
  status: SeoChangeStatus;
};

/** A dot on the top edge of the plot; hovering it names the change. */
function MarkerDot({
  viewBox,
  marker,
}: {
  viewBox?: { x?: number; y?: number };
  marker: ChangeMarker;
}) {
  if (viewBox?.x === undefined || viewBox.y === undefined) return null;
  return (
    <g>
      <title>
        {`${marker.shipDate} · ${SEO_CHANGE_TYPE_LABELS[marker.type]}${
          marker.status === "reverted" ? " (reverted)" : ""
        }\n${marker.summary}`}
      </title>
      <circle
        cx={viewBox.x}
        cy={viewBox.y + 4}
        r={4}
        fill="var(--color-secondary)"
        stroke="var(--color-base-100)"
        strokeWidth={1.5}
      />
    </g>
  );
}

/**
 * Change-log markers for a trend chart whose x-axis is the `date` category
 * (YYYY-MM-DD). Rendered as an array of children so any recharts chart can
 * spread them in: `{renderChangeMarkers(markers)}`. Charts with more than one
 * y-axis must name the axis the lines attach to.
 */
export function renderChangeMarkers(
  markers: ChangeMarker[] | undefined,
  yAxisId?: string,
) {
  return (markers ?? []).map((marker) => (
    <ReferenceLine
      key={marker.id}
      x={marker.shipDate}
      yAxisId={yAxisId}
      stroke="var(--color-secondary)"
      strokeDasharray="3 3"
      strokeOpacity={marker.status === "reverted" ? 0.35 : 0.8}
      ifOverflow="hidden"
      label={<MarkerDot marker={marker} />}
    />
  ));
}
