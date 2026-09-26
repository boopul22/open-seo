import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/client/components/Modal";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { logSeoChange } from "@/serverFunctions/seoChanges";
import {
  SEO_CHANGE_TYPE_LABELS,
  SEO_CHANGE_TYPES,
  type SeoChangeType,
} from "@/shared/seo-changes";
import {
  SEO_CHANGE_MAX_QUERIES,
  SEO_CHANGE_MAX_URLS,
} from "@/types/schemas/seoChanges";

// datetime-local wants "YYYY-MM-DDTHH:mm" in the browser's zone.
function nowLocalInput(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const optional = (value: string) => value.trim() || undefined;

function isChangeType(value: string): value is SeoChangeType {
  return SEO_CHANGE_TYPES.some((type) => type === value);
}

export function LogChangeModal({
  projectId,
  onClose,
  onLogged,
}: {
  projectId: string;
  onClose: () => void;
  onLogged: (changeId: string) => void;
}) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (data: Parameters<typeof logSeoChange>[0]["data"]) =>
      logSeoChange({ data }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: ["seoChanges", projectId],
      });
      toast.success(
        result.baseline.status === "measured"
          ? "Change logged with its Search Console baseline"
          : "Change logged. The baseline will be taken once Search Console is reachable.",
      );
      onLogged(result.change.id);
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't log the change")),
  });

  const form = useForm({
    defaultValues: {
      shippedAt: nowLocalInput(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      type: "title_meta" as SeoChangeType,
      summary: "",
      urls: "",
      queries: "",
      titleBefore: "",
      titleAfter: "",
      metaDescriptionBefore: "",
      metaDescriptionAfter: "",
      commitHash: "",
      deployId: "",
      prUrl: "",
      notes: "",
    },
    onSubmit: ({ value }) => {
      const urls = lines(value.urls);
      const queries = lines(value.queries);
      save.mutate({
        projectId,
        // The input is wall-clock time in the browser's zone.
        shippedAt: new Date(value.shippedAt).toISOString(),
        timezone: value.timezone.trim() || "UTC",
        type: value.type,
        summary: value.summary.trim(),
        urls,
        queries: queries.length > 0 ? queries : undefined,
        titleBefore: optional(value.titleBefore),
        titleAfter: optional(value.titleAfter),
        metaDescriptionBefore: optional(value.metaDescriptionBefore),
        metaDescriptionAfter: optional(value.metaDescriptionAfter),
        commitHash: optional(value.commitHash),
        deployId: optional(value.deployId),
        prUrl: optional(value.prUrl),
        notes: optional(value.notes),
      });
    },
  });

  const input = "input input-bordered input-sm w-full";
  const textarea = "textarea textarea-bordered textarea-sm w-full";

  return (
    <Modal maxWidth="max-w-2xl" onClose={onClose} labelledBy="log-change-title">
      <h3 id="log-change-title" className="text-lg font-semibold">
        Log a change
      </h3>
      <p className="text-sm text-base-content/70">
        OpenSEO stores Search Console numbers for the 28 days before the ship
        date now, then measures the same pages and queries 14 and 28 days after.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <form.Field name="shippedAt">
            {(field) => (
              <label className="form-control">
                <span className="label-text mb-1 text-xs">
                  Shipped at (your time)
                </span>
                <input
                  type="datetime-local"
                  className={input}
                  required
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </label>
            )}
          </form.Field>
          <form.Field name="timezone">
            {(field) => (
              <label className="form-control">
                <span className="label-text mb-1 text-xs">Site time zone</span>
                <input
                  className={input}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Asia/Kolkata"
                />
              </label>
            )}
          </form.Field>
          <form.Field name="type">
            {(field) => (
              <label className="form-control">
                <span className="label-text mb-1 text-xs">Type</span>
                <select
                  className="select select-bordered select-sm w-full"
                  value={field.state.value}
                  onChange={(e) => {
                    if (isChangeType(e.target.value)) {
                      field.handleChange(e.target.value);
                    }
                  }}
                >
                  {SEO_CHANGE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {SEO_CHANGE_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>
        </div>

        <form.Field name="summary">
          {(field) => (
            <label className="form-control">
              <span className="label-text mb-1 text-xs">What changed</span>
              <input
                className={input}
                required
                maxLength={500}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Rewrote the homepage title around 'image downloader'"
              />
            </label>
          )}
        </form.Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <form.Field
            name="urls"
            validators={{
              onSubmit: ({ value }) => {
                const count = lines(value).length;
                if (count === 0) return "Add at least one page";
                if (count > SEO_CHANGE_MAX_URLS) {
                  return `At most ${SEO_CHANGE_MAX_URLS} pages`;
                }
                return undefined;
              },
            }}
          >
            {(field) => (
              <label className="form-control">
                <span className="label-text mb-1 text-xs">
                  Affected pages, one per line
                </span>
                <textarea
                  className={textarea}
                  rows={3}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={"/\n/image-downloader\n/tools/*"}
                />
                {field.state.meta.errors.length > 0 ? (
                  <span className="mt-1 text-xs text-error">
                    {field.state.meta.errors.join(", ")}
                  </span>
                ) : null}
              </label>
            )}
          </form.Field>
          <form.Field
            name="queries"
            validators={{
              onSubmit: ({ value }) =>
                lines(value).length > SEO_CHANGE_MAX_QUERIES
                  ? `At most ${SEO_CHANGE_MAX_QUERIES} queries`
                  : undefined,
            }}
          >
            {(field) => (
              <label className="form-control">
                <span className="label-text mb-1 text-xs">
                  Target queries (optional)
                </span>
                <textarea
                  className={textarea}
                  rows={3}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.length > 0 ? (
                  <span className="mt-1 text-xs text-error">
                    {field.state.meta.errors.join(", ")}
                  </span>
                ) : null}
              </label>
            )}
          </form.Field>
        </div>

        <details className="rounded-lg border border-base-300 px-3 py-2">
          <summary className="cursor-pointer text-sm">
            Title and description, before and after
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {(
              [
                ["titleBefore", "Title before"],
                ["titleAfter", "Title after"],
                ["metaDescriptionBefore", "Description before"],
                ["metaDescriptionAfter", "Description after"],
              ] as const
            ).map(([name, label]) => (
              <form.Field key={name} name={name}>
                {(field) => (
                  <label className="form-control">
                    <span className="label-text mb-1 text-xs">{label}</span>
                    <textarea
                      className={textarea}
                      rows={2}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </label>
                )}
              </form.Field>
            ))}
          </div>
        </details>

        <details className="rounded-lg border border-base-300 px-3 py-2">
          <summary className="cursor-pointer text-sm">
            References and notes
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {(
              [
                ["commitHash", "Commit"],
                ["deployId", "Deploy / version ID"],
                ["prUrl", "PR link"],
              ] as const
            ).map(([name, label]) => (
              <form.Field key={name} name={name}>
                {(field) => (
                  <label className="form-control">
                    <span className="label-text mb-1 text-xs">{label}</span>
                    <input
                      className={input}
                      type={name === "prUrl" ? "url" : "text"}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </label>
                )}
              </form.Field>
            ))}
          </div>
          <form.Field name="notes">
            {(field) => (
              <label className="form-control mt-3">
                <span className="label-text mb-1 text-xs">Notes</span>
                <textarea
                  className={textarea}
                  rows={2}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </label>
            )}
          </form.Field>
        </details>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm gap-1"
            disabled={save.isPending}
          >
            {save.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : null}
            Log change
          </button>
        </div>
      </form>
    </Modal>
  );
}
