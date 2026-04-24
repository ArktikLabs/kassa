import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FormattedMessage, useIntl } from "react-intl";
import {
  getSnapshot,
  hydrateEnrolment,
  resetDevice,
  subscribe,
  type EnrolmentSnapshot,
} from "../lib/enrolment";
import { showToast } from "../components/Toast";
import { useSyncActions, useSyncStatus } from "../lib/sync-provider";

const BOOT_STATE: EnrolmentSnapshot = { state: "loading" };

export function AdminScreen() {
  const intl = useIntl();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<EnrolmentSnapshot>(() => getSnapshot() ?? BOOT_STATE);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const status = useSyncStatus();
  const { triggerRefresh } = useSyncActions();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void hydrateEnrolment();
    return subscribe(setSnapshot);
  }, []);

  async function handleReset(): Promise<void> {
    setResetting(true);
    try {
      await resetDevice();
      showToast(intl.formatMessage({ id: "admin.reset.toast" }), "info");
      setConfirmingReset(false);
      await navigate({ to: "/enrol", replace: true });
    } finally {
      setResetting(false);
    }
  }

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
    <section className="mx-auto max-w-xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-neutral-900">
          <FormattedMessage id="admin.heading" />
        </h1>
        <p className="text-neutral-600">
          <FormattedMessage id="admin.placeholder" />
        </p>
      </header>

      <section className="space-y-3 rounded-md border border-neutral-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-neutral-900">
          <FormattedMessage id="admin.device.heading" />
        </h2>
        {snapshot.state === "enrolled" ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-neutral-500">
              <FormattedMessage id="admin.device.outlet" />
            </dt>
            <dd className="font-semibold text-neutral-800">{snapshot.device.outlet.name}</dd>
            <dt className="text-neutral-500">
              <FormattedMessage id="admin.device.merchant" />
            </dt>
            <dd className="font-semibold text-neutral-800">{snapshot.device.merchant.name}</dd>
            <dt className="text-neutral-500">
              <FormattedMessage id="admin.device.id" />
            </dt>
            <dd className="font-mono text-xs break-all text-neutral-700">
              {snapshot.device.deviceId}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-neutral-600">
            <FormattedMessage id="admin.device.unenrolled" />
          </p>
        )}
      </section>

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

      {snapshot.state === "enrolled" ? (
        <section className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4">
          <h2 className="text-lg font-semibold text-red-800">
            <FormattedMessage id="admin.reset.heading" />
          </h2>
          <p className="text-sm text-red-900">
            <FormattedMessage id="admin.reset.description" />
          </p>
          {confirmingReset ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleReset()}
                disabled={resetting}
                className="h-11 flex-1 rounded-md bg-red-700 font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:bg-red-300"
              >
                <FormattedMessage
                  id={resetting ? "admin.reset.confirming" : "admin.reset.confirm"}
                />
              </button>
              <button
                type="button"
                onClick={() => setConfirmingReset(false)}
                disabled={resetting}
                className="h-11 flex-1 rounded-md border border-red-300 bg-white font-semibold text-red-800 hover:bg-red-100 disabled:cursor-not-allowed"
              >
                <FormattedMessage id="admin.reset.cancel" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingReset(true)}
              className="h-11 w-full rounded-md border border-red-500 bg-white font-semibold text-red-700 hover:bg-red-100"
            >
              <FormattedMessage id="admin.reset.cta" />
            </button>
          )}
        </section>
      ) : null}
    </section>
  );
}
