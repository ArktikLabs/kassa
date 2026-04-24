import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { useSyncActions, useSyncStatus } from "../lib/sync-provider";

export function AdminScreen() {
  const status = useSyncStatus();
  const { triggerRefresh } = useSyncActions();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await triggerRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const lastSuccessAt =
    status.phase.kind === "idle" ? status.phase.lastSuccessAt : null;
  const syncingTable =
    status.phase.kind === "syncing" ? status.phase.table : null;
  const errorMessage =
    status.phase.kind === "error" ? status.phase.message : null;

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-bold text-neutral-900">
        <FormattedMessage id="admin.heading" />
      </h1>
      <p className="text-neutral-600">
        <FormattedMessage id="admin.placeholder" />
      </p>
      <div className="rounded-lg border border-neutral-200 bg-white p-4 space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900">
          <FormattedMessage id="admin.sync.heading" />
        </h2>
        <dl className="grid grid-cols-2 gap-2 text-sm text-neutral-700">
          <dt className="font-medium">
            <FormattedMessage id="admin.sync.phase" />
          </dt>
          <dd data-testid="sync-phase">{status.phase.kind}</dd>
          {syncingTable ? (
            <>
              <dt className="font-medium">
                <FormattedMessage id="admin.sync.table" />
              </dt>
              <dd data-testid="sync-table">{syncingTable}</dd>
            </>
          ) : null}
          {lastSuccessAt ? (
            <>
              <dt className="font-medium">
                <FormattedMessage id="admin.sync.lastSuccess" />
              </dt>
              <dd data-testid="sync-last-success">{lastSuccessAt}</dd>
            </>
          ) : null}
          {errorMessage ? (
            <>
              <dt className="font-medium">
                <FormattedMessage id="admin.sync.error" />
              </dt>
              <dd className="text-danger-fg" data-testid="sync-error">
                {errorMessage}
              </dd>
            </>
          ) : null}
        </dl>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || status.phase.kind === "syncing"}
          className="inline-flex items-center justify-center rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
          data-testid="sync-refresh"
        >
          <FormattedMessage
            id={refreshing ? "admin.sync.refreshing" : "admin.sync.refresh"}
          />
        </button>
      </div>
    </section>
  );
}
