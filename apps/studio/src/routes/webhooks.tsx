import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, Webhook, AlertCircle, CheckCircle2 } from "lucide-react";
import { fetchWebhooks, createWebhook, deleteWebhook } from "@/lib/api";
import { EmptyState } from "@/components/shared/EmptyState";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/webhooks")({
  component: WebhooksPage,
});

const AVAILABLE_EVENTS = [
  { value: "run.started", label: "Run Started" },
  { value: "run.completed", label: "Run Completed" },
  { value: "run.failed", label: "Run Failed" },
];

function WebhooksPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["run.completed", "run.failed"]);
  const [formError, setFormError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["webhooks"],
    queryFn: fetchWebhooks,
    refetchInterval: 10000,
  });

  const addMutation = useMutation({
    mutationFn: createWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks"] });
      setShowForm(false);
      setUrl("");
      setSecret("");
      setSelectedEvents(["run.completed", "run.failed"]);
      setFormError(null);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to create webhook");
    },
  });

  const removeMutation = useMutation({
    mutationFn: deleteWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!url.trim()) {
      setFormError("URL is required");
      return;
    }

    try {
      new URL(url);
    } catch {
      setFormError("Invalid URL format");
      return;
    }

    if (selectedEvents.length === 0) {
      setFormError("Select at least one event");
      return;
    }

    addMutation.mutate({
      url: url.trim(),
      events: selectedEvents,
      secret: secret.trim() || undefined,
    });
  };

  const toggleEvent = (event: string) => {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  };

  const webhooks = data?.webhooks ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Webhooks</h1>
          <p className="text-sm text-zinc-500">
            Get notified when workflow runs complete or fail.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Webhook
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 space-y-4"
        >
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">
              Endpoint URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              className="w-full px-3 py-2 rounded-md bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">
              Secret (optional)
            </label>
            <input
              type="text"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Used for HMAC-SHA256 signature verification"
              className="w-full px-3 py-2 rounded-md bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
            />
            <p className="text-[11px] text-zinc-600 mt-1">
              If set, requests include an X-Blok-Signature header.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-2">
              Events
            </label>
            <div className="flex gap-2">
              {AVAILABLE_EVENTS.map((evt) => (
                <button
                  key={evt.value}
                  type="button"
                  onClick={() => toggleEvent(evt.value)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                    selectedEvents.includes(evt.value)
                      ? "border-blue-500 bg-blue-500/10 text-blue-400"
                      : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600",
                  )}
                >
                  {evt.label}
                </button>
              ))}
            </div>
          </div>

          {formError && (
            <p className="text-sm text-red-400">{formError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={addMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
            >
              {addMutation.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
              Create Webhook
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setFormError(null); }}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Webhook list */}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 text-zinc-500 animate-spin" />
        </div>
      ) : webhooks.length === 0 ? (
        <EmptyState
          icon={<Webhook className="w-10 h-10" />}
          title="No webhooks"
          description="Add a webhook to get notified about workflow run events."
        />
      ) : (
        <div className="space-y-2">
          {webhooks.map((wh) => (
            <div
              key={wh.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3"
            >
              <div className={cn(
                "w-2 h-2 rounded-full shrink-0",
                wh.active ? "bg-green-500" : "bg-red-500",
              )} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-zinc-200 font-mono truncate">{wh.url}</div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-[11px] text-zinc-500">
                    {wh.events.join(", ")}
                  </span>
                  {wh.lastTriggeredAt && (
                    <span className="text-[11px] text-zinc-600 flex items-center gap-1">
                      {wh.lastStatus && wh.lastStatus < 400 ? (
                        <CheckCircle2 className="w-3 h-3 text-green-500" />
                      ) : (
                        <AlertCircle className="w-3 h-3 text-red-500" />
                      )}
                      Last fired {formatRelativeTime(wh.lastTriggeredAt)}
                      {wh.lastStatus && <span>(HTTP {wh.lastStatus})</span>}
                    </span>
                  )}
                  {!wh.active && (
                    <span className="text-[11px] text-red-400">
                      Disabled after {wh.failCount} failures
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeMutation.mutate(wh.id)}
                disabled={removeMutation.isPending}
                className="p-1.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-colors"
                title="Delete webhook"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
