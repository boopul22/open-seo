import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Trash2, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDeleteModal } from "@/client/components/ConfirmDeleteModal";
import {
  formatCount,
  formatCtr,
  formatPosition,
} from "@/client/features/search-performance/SearchPerformanceColumns";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  deleteSeoChange,
  getSeoChangeImpact,
  updateSeoChange,
} from "@/serverFunctions/seoChanges";
import { SEO_CHANGE_TYPE_LABELS } from "@/shared/seo-changes";
import type {
  SeoChangeCheckpointSummary,
  SeoChangeDelta,
  SeoChangeImpact,
  SeoChangeNoiseFlag,
} from "@/types/schemas/seoChanges";

const CHECKPOINT_LABELS: Record<SeoChangeCheckpointSummary["kind"], string> = {
  baseline: "Baseline",
  day_14: "+14 days",
  day_28: "+28 days",
};

const NOISE_LABELS: Record<SeoChangeNoiseFlag, string> = {
  low_volume: "Low volume",
  matches_site_trend: "Moved with the site",
};

function signedPct(value: number | null): string {
  if (value === null) return "new";
  return `${value > 0 ? "+" : ""}${value.toFixed(0)}%`;
}

function deltaTone(value: number, higherIsBetter = true): string {
  if (Math.abs(value) < 1e-9) return "text-base-content/60";
  return value > 0 === higherIsBetter ? "text-success" : "text-error";
}

function CheckpointStatus({
  checkpoint,
}: {
  checkpoint: SeoChangeCheckpointSummary;
}) {
  const text =
    checkpoint.status === "pending"
      ? `due ${checkpoint.dueAt.slice(0, 10)}`
      : checkpoint.status;
  return (
    <div className="rounded-lg border border-base-300 px-3 py-2">
      <p className="text-xs font-medium">
        {CHECKPOINT_LABELS[checkpoint.kind]}
      </p>
      <p className="text-xs text-base-content/60 tabular-nums">
        {checkpoint.windowStart} – {checkpoint.windowEnd}
      </p>
      <p
        className={`text-xs ${
          checkpoint.status === "measured"
            ? "text-success"
            : checkpoint.status === "failed"
              ? "text-error"
              : "text-base-content/60"
        }`}
        title={checkpoint.error ?? undefined}
      >
        {text}
      </p>
    </div>
  );
}

function DeltaCells({ delta }: { delta: SeoChangeDelta }) {
  return (
    <>
      <td className="tabular-nums">
        {delta.clicksPerDay.before.toFixed(1)} →{" "}
        {delta.clicksPerDay.after.toFixed(1)}{" "}
        <span className={deltaTone(delta.clicksPerDay.change)}>
          ({signedPct(delta.clicksPerDay.changePct)})
        </span>
      </td>
      <td className="tabular-nums">
        {formatCount(delta.impressionsPerDay.before)} →{" "}
        {formatCount(delta.impressionsPerDay.after)}{" "}
        <span className={deltaTone(delta.impressionsPerDay.change)}>
          ({signedPct(delta.impressionsPerDay.changePct)})
        </span>
      </td>
      <td className="tabular-nums">
        {formatCtr(delta.ctr.before)} → {formatCtr(delta.ctr.after)}
      </td>
      <td className="tabular-nums">
        {formatPosition(delta.position.before)} →{" "}
        {formatPosition(delta.position.after)}{" "}
        <span className={deltaTone(delta.position.change, false)}>
          ({delta.position.change > 0 ? "+" : ""}
          {delta.position.change.toFixed(1)})
        </span>
      </td>
    </>
  );
}

function ResultTable({
  result,
}: {
  result: SeoChangeImpact["results"][number];
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        {CHECKPOINT_LABELS[result.kind]} vs baseline{" "}
        <span className="font-normal text-base-content/60">
          ({result.windowStart} – {result.windowEnd}, per day, all devices)
        </span>
      </h3>
      <div className="overflow-x-auto rounded-lg border border-base-300">
        <table className="table table-xs">
          <thead>
            <tr>
              <th>Target</th>
              <th>Clicks / day</th>
              <th>Impressions / day</th>
              <th>CTR</th>
              <th>Position</th>
              <th>vs site</th>
              <th>Read</th>
            </tr>
          </thead>
          <tbody>
            {result.targets.map((row) => {
              const all = row.deltas.find((delta) => delta.device === "all");
              if (!all) return null;
              return (
                <tr key={row.target?.id ?? "site"}>
                  <td className="max-w-[240px] truncate">
                    {row.target ? (
                      row.target.value
                    ) : (
                      <span className="text-base-content/60">Whole site</span>
                    )}
                  </td>
                  <DeltaCells delta={all} />
                  <td className="tabular-nums">
                    {row.clicksVsSitePts === null
                      ? "—"
                      : `${row.clicksVsSitePts > 0 ? "+" : ""}${row.clicksVsSitePts.toFixed(0)} pts`}
                  </td>
                  <td>
                    {row.target === null ? (
                      "—"
                    ) : row.noise.length > 0 ? (
                      <span className="badge badge-ghost badge-sm">
                        {row.noise.map((flag) => NOISE_LABELS[flag]).join(", ")}
                      </span>
                    ) : (
                      <span className="badge badge-success badge-outline badge-sm">
                        Signal
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BeforeAfter({
  label,
  before,
  after,
}: {
  label: string;
  before: string | null;
  after: string | null;
}) {
  if (!before && !after) return null;
  return (
    <div className="grid gap-1 text-sm sm:grid-cols-[120px_1fr]">
      <span className="text-xs text-base-content/60">{label}</span>
      <div className="space-y-0.5">
        {before ? (
          <p className="text-base-content/60 line-through">{before}</p>
        ) : null}
        {after ? <p>{after}</p> : null}
      </div>
    </div>
  );
}

export function ChangeImpactPanel({
  projectId,
  changeId,
  onClose,
}: {
  projectId: string;
  changeId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const impactQuery = useQuery({
    queryKey: ["seoChangeImpact", projectId, changeId],
    queryFn: () => getSeoChangeImpact({ data: { projectId, changeId } }),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["seoChanges", projectId] }),
      queryClient.invalidateQueries({
        queryKey: ["seoChangeImpact", projectId, changeId],
      }),
    ]);

  const update = useMutation({
    mutationFn: (
      data: Omit<
        Parameters<typeof updateSeoChange>[0]["data"],
        "projectId" | "changeId"
      >,
    ) => updateSeoChange({ data: { projectId, changeId, ...data } }),
    onSuccess: async () => {
      setNote("");
      await refresh();
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't update the change")),
  });

  const remove = useMutation({
    mutationFn: () => deleteSeoChange({ data: { projectId, changeId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["seoChanges", projectId],
      });
      onClose();
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't delete the change")),
  });

  if (impactQuery.isPending) {
    return (
      <div className="flex justify-center rounded-xl border border-base-300 py-10">
        <span className="loading loading-spinner loading-md" />
      </div>
    );
  }
  if (impactQuery.isError) {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          {getStandardErrorMessage(impactQuery.error, "Failed to load change")}
        </span>
      </div>
    );
  }

  const { change, checkpoints, results } = impactQuery.data;
  const reverted = change.status === "reverted";

  return (
    <section className="space-y-4 rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs text-base-content/60">
            {change.shipDate} · {SEO_CHANGE_TYPE_LABELS[change.type]} · by{" "}
            {change.author}
            {reverted ? (
              <span className="badge badge-warning badge-sm ml-2">
                Reverted {change.revertedAt?.slice(0, 10)}
              </span>
            ) : null}
          </p>
          <h2 className="text-lg font-semibold">{change.summary}</h2>
          <p className="text-xs text-base-content/60">
            {change.targets
              .map((t) => (t.kind === "query" ? `“${t.value}”` : t.value))
              .join(" · ")}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>

      <BeforeAfter
        label="Title"
        before={change.titleBefore}
        after={change.titleAfter}
      />
      <BeforeAfter
        label="Description"
        before={change.metaDescriptionBefore}
        after={change.metaDescriptionAfter}
      />

      {change.commitHash || change.deployId || change.prUrl ? (
        <p className="flex flex-wrap gap-3 text-xs text-base-content/60">
          {change.commitHash ? <span>commit {change.commitHash}</span> : null}
          {change.deployId ? <span>deploy {change.deployId}</span> : null}
          {change.prUrl ? (
            <a
              href={change.prUrl}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-1"
            >
              PR <ExternalLink className="size-3" />
            </a>
          ) : null}
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        {checkpoints.map((checkpoint) => (
          <CheckpointStatus key={checkpoint.kind} checkpoint={checkpoint} />
        ))}
      </div>

      {results.length === 0 ? (
        <p className="text-sm text-base-content/60">
          Results appear once the first post-change window has settled in Search
          Console, about 17 days after the ship date.
        </p>
      ) : (
        results.map((result) => (
          <ResultTable key={result.kind} result={result} />
        ))
      )}

      {change.notes ? (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Notes</h3>
          <p className="whitespace-pre-wrap text-sm text-base-content/80">
            {change.notes}
          </p>
        </div>
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (note.trim()) update.mutate({ appendNote: note.trim() });
        }}
      >
        <input
          className="input input-bordered input-sm flex-1"
          placeholder="Add a note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={4000}
        />
        <button
          type="submit"
          className="btn btn-sm"
          disabled={!note.trim() || update.isPending}
        >
          Add
        </button>
      </form>

      <div className="flex flex-wrap justify-end gap-2 border-t border-base-300 pt-3">
        <button
          type="button"
          className="btn btn-ghost btn-sm gap-1"
          disabled={update.isPending}
          onClick={() => update.mutate({ reverted: !reverted })}
        >
          {update.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Undo2 className="size-3.5" />
          )}
          {reverted ? "Mark as live again" : "Mark reverted"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm gap-1 text-error"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-3.5" /> Delete
        </button>
      </div>

      {confirmDelete ? (
        <ConfirmDeleteModal
          title="Delete this change?"
          detail="Its baseline and measurements are deleted with it. Search Console data older than 16 months can't be measured again."
          confirmLabel="Delete change"
          isPending={remove.isPending}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </section>
  );
}
