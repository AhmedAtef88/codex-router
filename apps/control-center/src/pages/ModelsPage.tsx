import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Filter, KeyRound, Link2, LogIn, MoreHorizontal, Pencil, Plus, SearchX, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, CatalogSkeleton, Dialog, EmptyState, PageHeader, PanelSkeleton, SearchField, SkeletonBlock, Toggle } from "../components";
import { BrandLogo, ProviderLogo, brandForModel } from "../provider-branding";
import { formatContext, formatDateTime } from "../lib";
import {
  addPendingCatalogModels,
  beginCatalogRequest,
  catalogRequestIsCurrent,
  clearProviderCatalogStates,
  invalidateProviderCatalogRequests,
  loadedCatalogModels,
  modelRouteKind,
  pendingCatalogModelIds,
  removePendingCatalogModels,
  type PendingCatalogModels,
} from "../model-catalog-search.mjs";
import { groupModelFamilies, preferredFamilyRoute } from "../model-families.mjs";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";
import type {
  CustomEndpointResult,
  ModelViewFocusRequest,
  ProviderCatalog,
  ProviderSetup,
  ProviderSetupSnapshot,
  ProviderUsageSnapshot,
  RouterCatalogSnapshot,
  RouterControlApi,
  RouterDataReady,
  RouterKnownModel,
  RouterModel,
  RouterTarget,
} from "../types";
import "./providers-models.css";

type StatusFilter = "all" | "on" | "off" | "blocked";
const CATALOG_ADD_BATCH_LIMIT = 200;

/** One model, and every provider route that can serve it. */
interface ModelFamily {
  id: string;
  displayName: string;
  routes: RouterModel[];
}

/** A model a connected provider offers but the router has not registered yet. */
interface CatalogModel {
  key: string;
  modelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
  sourceId: string;
  sourceName: string;
  registered: boolean;
  addable: boolean;
  blockedReason?: string;
  contextWindow?: number;
  isFree: boolean;
}

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "All models",
  on: "On",
  off: "Off",
  blocked: "Needs a provider",
};

const ALL_PROVIDERS_LABEL = "All providers";

/** Below this, a list is short enough to read whole; filters and bulk switches
 *  would be more chrome than the list they act on. */
const CROWDED_LIST = 8;

/** Picking between two or three providers is slower through a menu than by
 *  reading the provider each row already names. */
const CROWDED_PROVIDERS = 3;

interface ModelsPageProps {
  target?: RouterTarget;
  /** Shared router policy; client probes remain available for native details. */
  catalog?: RouterCatalogSnapshot;
  setup?: ProviderSetupSnapshot;
  usage?: ProviderUsageSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  dataReady: RouterDataReady;
  onRefresh: () => void;
  runAction: RunAction;
  focusRequest?: ModelViewFocusRequest;
}

interface ProviderDirectoryEntry {
  id: string;
  displayName: string;
  setup?: ProviderSetup;
  models: RouterModel[];
  knownModels: RouterKnownModel[];
}

interface CatalogViewState {
  status: "idle" | "loading" | "ready" | "error";
  /** A refresh keeps the list on screen instead of replacing it with a skeleton. */
  refreshing: boolean;
  data?: ProviderCatalog;
  error?: string;
}

function catalogEligible(entry: ProviderDirectoryEntry): boolean {
  return Boolean(entry.setup?.configured && entry.setup.catalogSources?.length);
}

// The capability the catalog published wins over the registry's provenance: a
// route the operator selected is v2 to Codex even though the registry never
// certified it, and asking the registry first described it as unusable.
function subagentCertification(model: RouterModel): "v1" | "v2" | "unknown" | string {
  if (model.multiAgentVersion === "v2") return "v2";
  return model.subagentCertification
    ?? (model.multiAgentVersion === "v1" ? "v1" : "unknown");
}

function subagentEnabled(target: RouterTarget, slug: string, settings = target.modelSettings?.subagents): boolean {
  if (!settings) return false;
  if (settings.disabled.includes(slug)) return false;
  const model = target.models.find((entry) => entry.slug === slug);
  if (!model || model.visible === false) return false;
  // Certified routes remain active unless explicitly disabled; selected mode
  // does not silently turn off every other registry-v2 route. For an unknown
  // route, a selected-mode entry means only that its compatibility test was
  // requested — it never becomes an active subagent here.
  if (subagentCertification(model) === "v2") {
    return true;
  }
  return settings.mode === "selected" && settings.enabled.includes(slug);
}

function nativeClientManaged(model: RouterModel): boolean {
  return model.native === true && model.nativeClientManaged !== false;
}

function routeUsable(model: RouterModel): boolean {
  return model.available !== false;
}

export function ModelsPage({ target, catalog, setup, usage, api, refreshing, dataReady, onRefresh, runAction, focusRequest }: ModelsPageProps) {
  const [modelSearch, setModelSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const [providerFilter, setProviderFilter] = useState("all");
  const [providerFilterMenuOpen, setProviderFilterMenuOpen] = useState(false);
  const providerFilterMenuRef = useRef<HTMLDivElement | null>(null);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement | null>(null);
  // The connect menu lives in the connections strip but is also the first-run
  // call to action, so the page owns whether it is open.
  const [connectMenuOpen, setConnectMenuOpen] = useState(false);
  const [expandedFamilyId, setExpandedFamilyId] = useState<string | null>(null);
  const [managedProviderId, setManagedProviderId] = useState<string | null>(null);
  const [addModelsOpen, setAddModelsOpen] = useState(false);
  const [loadingConnectedCatalogs, setLoadingConnectedCatalogs] = useState(false);
  const [credentialProvider, setCredentialProvider] = useState<ProviderSetup | null>(null);
  const [configurationProvider, setConfigurationProvider] = useState<ProviderSetup | null>(null);
  const [removeProvider, setRemoveProvider] = useState<ProviderSetup | null>(null);
  const [customEndpointOpen, setCustomEndpointOpen] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<ProviderSetup | null>(null);
  const [addModelsQuery, setAddModelsQuery] = useState("");
  const [namedModelEndpoint, setNamedModelEndpoint] = useState<ProviderSetup | null>(null);
  // A saved endpoint whose first live check failed. The endpoint is kept --
  // an unreachable host is usually a network or key problem the operator fixes
  // next -- so this says what happened and offers the two ways forward.
  const [endpointNotice, setEndpointNotice] = useState<{ id: string; displayName: string; reason: string } | null>(null);
  // Set once a new endpoint is saved; the model picker opens as soon as the
  // refreshed snapshot shows that endpoint with a catalog to browse.
  const [awaitingEndpointId, setAwaitingEndpointId] = useState<string | null>(null);
  const [catalogStates, setCatalogStates] = useState<Record<string, CatalogViewState>>({});
  const catalogRequestGenerations = useRef<Record<string, number>>({});
  // Slugs committed to the picker but not yet published, per provider. Adding
  // republishes the whole catalog to every installed client, which is the
  // slowest thing this page starts; without a placeholder the models simply are
  // not there for the length of it and the click reads as having done nothing.
  const [pendingModels, setPendingModels] = useState<PendingCatalogModels>({});

  // External model identity and picker visibility come from the router-owned
  // catalog. Native entries remain a Codex-only adapter concern and are merged
  // in for the convenience of the Codex client view.
  const models = useMemo(() => {
    const clientModels = target?.models ?? [];
    if (!catalog) return clientModels;
    const nativeModels = clientModels.filter((model) => model.native);
    const seen = new Set(nativeModels.map((model) => model.slug));
    return [
      ...nativeModels,
      ...catalog.models.filter((model) => !seen.has(model.slug)),
    ];
  }, [catalog, target?.models]);
  const enabledProviders = useMemo(
    () => new Set(catalog?.enabledProviders ?? target?.enabledProviders ?? []),
    [catalog?.enabledProviders, target?.enabledProviders],
  );
  const subagentSettings = catalog?.subagents ?? target?.modelSettings?.subagents;
  // One list covers configured routes and routes that are only known to the
  // registry. A model nobody can reach yet is still the answer to "can I use
  // this model", so it stays on the page with the connection it is waiting for.
  const allModels = useMemo<RouterModel[]>(() => {
    const activeSlugs = new Set(models.map((model) => model.slug));
    return [
      ...models,
      ...(catalog?.knownModels ?? [])
        .filter((model) => !activeSlugs.has(model.slug))
        .map((model) => ({
          ...model,
          enabled: false,
          visible: false,
          available: false,
          subagentCertification: "unknown" as const,
        })),
    ];
  }, [catalog?.knownModels, models]);
  const families = useMemo<ModelFamily[]>(() => groupModelFamilies(allModels), [allModels]);
  const usageById = useMemo(
    () => new Map((usage?.providers ?? []).map((provider) => [provider.id, provider])),
    [usage?.providers],
  );
  const directory = useMemo<ProviderDirectoryEntry[]>(() => {
    const entries = new Map<string, ProviderDirectoryEntry>();
    for (const provider of [...(setup?.providers ?? []), ...(setup?.customEndpoints ?? [])]) {
      entries.set(provider.id, { id: provider.id, displayName: provider.displayName, setup: provider, models: [], knownModels: [] });
    }
    for (const provider of target?.providers ?? []) {
      const current = entries.get(provider.id);
      entries.set(provider.id, {
        id: provider.id,
        displayName: current?.displayName || provider.displayName,
        setup: current?.setup,
        models: current?.models ?? [],
        knownModels: current?.knownModels ?? [],
      });
    }
    for (const model of models) {
      const current = entries.get(model.provider);
      entries.set(model.provider, {
        id: model.provider,
        displayName: current?.displayName || providerDisplayName(model.provider),
        setup: current?.setup,
        models: [...(current?.models ?? []), model],
        knownModels: current?.knownModels ?? [],
      });
    }
    for (const model of catalog?.knownModels ?? []) {
      const current = entries.get(model.provider);
      entries.set(model.provider, {
        id: model.provider,
        displayName: current?.displayName || providerDisplayName(model.provider),
        setup: current?.setup,
        models: current?.models ?? [],
        knownModels: [...(current?.knownModels ?? []), model],
      });
    }
    return [...entries.values()].sort((left, right) => {
      const leftConnected = providerConnected(left, enabledProviders);
      const rightConnected = providerConnected(right, enabledProviders);
      return Number(rightConnected) - Number(leftConnected) || left.displayName.localeCompare(right.displayName);
    });
  }, [catalog?.knownModels, enabledProviders, models, setup?.customEndpoints, setup?.providers, target?.providers]);
  const directoryById = useMemo(() => new Map(directory.map((entry) => [entry.id, entry])), [directory]);
  const providerStates = useMemo(() => new Map(directory.map((entry) => [
    entry.id,
    enabledProviders.has(entry.id) || entry.models.some((model) => model.native),
  ])), [directory, enabledProviders]);
  const providerNames = useMemo(
    () => new Map(directory.map((entry) => [entry.id, entry.displayName])),
    [directory],
  );
  // Ordered by the directory, so the menu lists providers in the same order as
  // the connections strip: connected first, then alphabetical.
  const filterProviders = useMemo(() => {
    const routed = new Set(families.flatMap((family) => family.routes.map((model) => model.provider)));
    return directory.filter((entry) => routed.has(entry.id));
  }, [directory, families]);
  const providerCrowded = filterProviders.length > CROWDED_PROVIDERS;
  // A filter whose chip is not on screen -- because the provider left the list,
  // or because there are too few providers left to warrant the chip -- would go
  // on narrowing the list with nothing there to undo it.
  const activeProviderFilter = providerCrowded && filterProviders.some((entry) => entry.id === providerFilter)
    ? providerFilter
    : "all";
  const pickerStates = useMemo(() => new Map(models.map((model) => [model.slug, model.visible])), [models]);
  const subagentStates = useMemo(() => new Map(models.map((model) => [
    model.slug,
    Boolean(target && subagentEnabled(target, model.slug, subagentSettings)),
  ])), [models, subagentSettings, target]);
  const subagentEffortStates = useMemo(() => new Map(models.map((model) => [
    model.slug,
    subagentSettings?.efforts?.[model.slug] ?? "default",
  ])), [models, subagentSettings?.efforts]);
  const optimisticProviders = useOptimisticValues(providerStates, runAction);
  const optimisticPicker = useOptimisticValues(pickerStates, runAction);
  const optimisticSubagents = useOptimisticValues(subagentStates, runAction);
  const optimisticSubagentEfforts = useOptimisticValues(subagentEffortStates, runAction);

  useEffect(() => {
    if (!filterMenuOpen && !providerFilterMenuOpen && !bulkMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterMenuOpen(false);
      if (!providerFilterMenuRef.current?.contains(event.target as Node)) setProviderFilterMenuOpen(false);
      if (!bulkMenuRef.current?.contains(event.target as Node)) setBulkMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFilterMenuOpen(false);
      setProviderFilterMenuOpen(false);
      setBulkMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [bulkMenuOpen, filterMenuOpen, providerFilterMenuOpen]);

  const updateCatalogState = (sourceId: string, update: (current: CatalogViewState) => CatalogViewState) => {
    setCatalogStates((current) => ({
      ...current,
      [sourceId]: update(current[sourceId] ?? { status: "idle", refreshing: false }),
    }));
  };

  const runProviderCredentialAction = async (
    provider: ProviderSetup,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    const invalidateCatalogs = () => {
      invalidateProviderCatalogRequests(catalogRequestGenerations.current, provider.catalogSources);
      setCatalogStates((current) => clearProviderCatalogStates(current, provider.catalogSources));
    };
    // Clear at both boundaries. The command may have changed the credential
    // before a later refresh/publish step rejects, and a discovery that lands
    // while the mutation is running must not show the previous account.
    invalidateCatalogs();
    try {
      await runAction(label, async () => {
        await action();
      });
    } finally {
      invalidateCatalogs();
    }
  };

  const discoverCatalog = async (
    entry: ProviderDirectoryEntry,
    sourceId: string,
    { refresh = false, keepOnFailure = false } = {},
  ) => {
    if (!api || !catalogEligible(entry) || !sourceId) return;
    const generation = beginCatalogRequest(catalogRequestGenerations.current, sourceId);
    updateCatalogState(sourceId, (current) => ({
      ...current,
      status: "loading",
      refreshing: refresh && Boolean(current.data),
      error: undefined,
    }));
    try {
      const data = await api.discoverProviderModels(sourceId, { refresh });
      if (!catalogRequestIsCurrent(catalogRequestGenerations.current, sourceId, generation)) return;
      updateCatalogState(sourceId, (current) => ({ ...current, status: "ready", refreshing: false, data, error: undefined }));
      // A stored list past its trust window is shown immediately and re-read
      // behind it, so a model the provider shipped since the last visit does
      // not stay invisible until somebody thinks to press Reload. A failed
      // re-read leaves the list that is already on screen in place.
      if (!refresh && data.stale) void discoverCatalog(entry, sourceId, { refresh: true, keepOnFailure: true });
    } catch (error) {
      if (!catalogRequestIsCurrent(catalogRequestGenerations.current, sourceId, generation)) return;
      updateCatalogState(sourceId, (current) => keepOnFailure && current.data
        ? { ...current, status: "ready", refreshing: false }
        : {
          ...current,
          status: "error",
          refreshing: false,
          error: error instanceof Error ? error.message : "Provider catalog could not be loaded.",
        });
    }
  };

  const catalogRequests = () => directory.flatMap((entry) => !catalogEligible(entry) || !providerConnected(entry, enabledProviders)
    ? []
    : (entry.setup?.catalogSources ?? []).map((source) => ({ entry, sourceId: source.id })));

  // Opening the picker loads every connected provider at once, so one search
  // box can cover them all. Stored lists answer immediately; only an explicit
  // reload re-asks the providers.
  const loadConnectedCatalogs = async ({ refresh = false } = {}) => {
    if (!api || loadingConnectedCatalogs) return;
    const requests = catalogRequests().filter(({ sourceId }) => refresh || (catalogStates[sourceId]?.status ?? "idle") === "idle");
    if (!requests.length) return;
    setLoadingConnectedCatalogs(true);
    try {
      await Promise.all(requests.map(({ entry, sourceId }) => discoverCatalog(entry, sourceId, { refresh })));
    } finally {
      setLoadingConnectedCatalogs(false);
    }
  };

  const publishCatalogModels = async (entry: ProviderDirectoryEntry, sourceId: string, selected: string[]) => {
    if (!api || !sourceId || !selected.length) return;
    let published = false;
    setPendingModels((current) => addPendingCatalogModels(current, entry.id, selected));
    try {
      await runAction(`Add ${selected.length} ${entry.displayName} model${selected.length === 1 ? "" : "s"}`, async () => {
        await api.addProviderModels(sourceId, selected);
        published = true;
      });
      if (!published) return;
      await discoverCatalog(entry, sourceId);
    } finally {
      // Cleared on failure too: a placeholder left behind after a failed add
      // would claim the model arrived. runAction reports the error itself.
      setPendingModels((current) => removePendingCatalogModels(current, entry.id, selected));
    }
  };

  const addCatalogModels = async (selection: CatalogModel[]) => {
    const bySource = new Map<string, { entry: ProviderDirectoryEntry; modelIds: string[] }>();
    for (const model of selection) {
      const entry = directoryById.get(model.providerId);
      if (!entry) continue;
      const group = bySource.get(model.sourceId) ?? { entry, modelIds: [] };
      group.modelIds.push(model.modelId);
      bySource.set(model.sourceId, group);
    }
    for (const [sourceId, { entry, modelIds }] of bySource) {
      await publishCatalogModels(entry, sourceId, modelIds);
    }
  };

  const openAddModels = (query = "") => {
    setAddModelsQuery(query);
    setAddModelsOpen(true);
    void loadConnectedCatalogs();
  };

  const removeEndpointModel = (entry: ProviderDirectoryEntry, model: RouterModel) => {
    if (!api) return;
    void runAction(`Remove ${model.displayName}`, () => api.removeCustomEndpointModels(entry.id, [model.slug]));
  };

  useEffect(() => {
    if (!awaitingEndpointId) return;
    const entry = directoryById.get(awaitingEndpointId);
    if (!entry || !catalogEligible(entry)) return;
    setAwaitingEndpointId(null);
    openAddModels(entry.displayName);
    // openAddModels reads the directory this render just produced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingEndpointId, directoryById]);

  const openProviderMenu = (providerId: string) => {
    setManagedProviderId((current) => (current === providerId ? null : providerId));
  };

  const renderConnections = () => !dataReady.providers && !setup ? (
    <section className="pm-connections pm-connections-loading" aria-label="Loading provider connections" aria-busy="true">
      <SkeletonBlock />
      <SkeletonBlock />
      <SkeletonBlock />
    </section>
  ) : (
    <ConnectionsBar
      directory={directory}
      enabledProviders={enabledProviders}
      usageById={usageById}
      apiAvailable={Boolean(api)}
      platform={api?.platform}
      openProviderId={managedProviderId}
      onOpenProvider={openProviderMenu}
      onCloseProvider={() => setManagedProviderId(null)}
      connectMenuOpen={connectMenuOpen}
      onConnectMenuOpen={setConnectMenuOpen}
      isEnabled={(entry) => optimisticProviders.value(entry.id, entry.setup?.generic
        ? entry.setup.enabled !== false
        : enabledProviders.has(entry.id) || entry.models.some((model) => model.native))}
      onAddEndpoint={() => { setManagedProviderId(null); setEditingEndpoint(null); setCustomEndpointOpen(true); }}
      onEditEndpoint={(entry) => { if (!entry.setup) return; setManagedProviderId(null); setEditingEndpoint(entry.setup); setCustomEndpointOpen(true); }}
      onAddEndpointModels={(entry) => { setManagedProviderId(null); openAddModels(entry.displayName); }}
      onAddNamedModel={(entry) => { if (!entry.setup) return; setManagedProviderId(null); setNamedModelEndpoint(entry.setup); }}
      onRemoveEndpointModel={removeEndpointModel}
      onEnabledChange={(entry, checked) => {
        if (!api) return;
        void optimisticProviders.mutate(entry.id, checked, `${checked ? "Enable" : "Disable"} ${entry.displayName}`, () => api.setProviderEnabled(entry.id, checked));
      }}
      onSignIn={(entry) => {
        if (!api || !entry.setup) return;
        const label = entry.setup.action === "probe"
          ? `Run ${entry.displayName} live compatibility test`
          : `Start ${entry.displayName} sign-in`;
        void runProviderCredentialAction(entry.setup, label, () => api.connectProvider(entry.id));
      }}
      onConfigure={(entry) => entry.setup && setConfigurationProvider(entry.setup)}
      onKey={(entry) => entry.setup && setCredentialProvider(entry.setup)}
      onRemove={(entry) => entry.setup && setRemoveProvider(entry.setup)}
    />
  );
  const renderConnectionDialogs = () => (
    <>
      <Dialog
        open={Boolean(endpointNotice)}
        title={`${endpointNotice?.displayName || "Endpoint"} saved, but it did not answer`}
        description="The endpoint and its key are stored. Its model list cannot be read until it responds, so there is nothing to choose from yet."
        onClose={() => setEndpointNotice(null)}
      >
        <div className="pm-credential-warning">
          <ShieldCheck aria-hidden size={17} strokeWidth={1.7} />
          <p>{endpointNotice?.reason} Check the base URL, the API key, and whether a VPN or firewall is blocking this address. You can still add a model by name and use it once the endpoint responds.</p>
        </div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setEndpointNotice(null)}>Close</Button>
          <Button
            variant="primary"
            onClick={() => {
              const target = endpointNotice;
              setEndpointNotice(null);
              const entry = target ? directoryById.get(target.id) : undefined;
              if (entry?.setup) setNamedModelEndpoint(entry.setup);
            }}
          >
            <Plus aria-hidden size={14} strokeWidth={1.7} /> Add a model by name
          </Button>
        </div>
      </Dialog>
      <NamedModelDialog
        provider={namedModelEndpoint}
        onClose={() => setNamedModelEndpoint(null)}
        onSave={async (provider, modelId) => {
          if (!api) return;
          await runAction(`Add ${provider.id}/${modelId}`, () => api.addCustomEndpointModel(provider.id, modelId));
        }}
      />
      <CustomEndpointDialog
        open={customEndpointOpen}
        editing={editingEndpoint}
        onClose={() => { setCustomEndpointOpen(false); setEditingEndpoint(null); }}
        onSave={async (endpoint, editing) => {
          if (!api) return;
          if (editing) {
            let editCheck: CustomEndpointResult["check"];
            await runProviderCredentialAction(editing, `Update ${endpoint.displayName}`, async () => {
              const { credential, ...fields } = endpoint;
              const result = await api.editCustomEndpoint(editing.id, fields);
              if (credential) await api.saveProviderCredential(editing.id, credential);
              editCheck = result.check;
            });
            if (editCheck && !editCheck.ok) {
              setEndpointNotice({ id: editing.id, displayName: endpoint.displayName, reason: editCheck.reason || "The endpoint did not respond." });
            }
            return;
          }
          let saved: CustomEndpointResult | undefined;
          await runAction(`Add ${endpoint.displayName}`, async () => {
            saved = await api.addCustomEndpoint(endpoint);
          });
          if (!saved) return;
          onRefresh();
          // Only browse a catalog the endpoint just proved it can serve.
          if (saved.check && !saved.check.ok) {
            setEndpointNotice({
              id: saved.providerId,
              displayName: endpoint.displayName,
              reason: saved.check.reason || "The endpoint did not respond.",
            });
            return;
          }
          setAwaitingEndpointId(saved.providerId);
        }}
      />
      <CredentialDialog
        provider={credentialProvider}
        onSave={(provider, secret) => api
          ? runProviderCredentialAction(provider, `Save ${provider.displayName} credential`, () => api.saveProviderCredential(provider.id, secret))
          : Promise.resolve()}
        onClose={() => setCredentialProvider(null)}
      />
      <Dialog
        open={Boolean(configurationProvider)}
        title={`Configure ${configurationProvider?.displayName || "provider"}`}
        description="This provider uses local configuration rather than an API key."
        onClose={() => setConfigurationProvider(null)}
      >
        <div className="pm-credential-warning">
          <ShieldCheck aria-hidden size={17} strokeWidth={1.7} />
          <p>{configurationProvider?.configurationNote || "Run the provider's local configuration command, then refresh this page."}</p>
        </div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfigurationProvider(null)}>Close</Button>
        </div>
      </Dialog>
      <Dialog open={Boolean(removeProvider)} title="Disconnect provider" description="The provider is withdrawn from installed clients before its managed credential is deleted." onClose={() => setRemoveProvider(null)}>
        <div className="pm-credential-warning"><ShieldCheck aria-hidden size={17} strokeWidth={1.7} /><p>{removeProvider?.generic
          ? "This removes the endpoint, its saved API key, and every model you added from it."
          : removeProvider?.id === "antigravity-oauth"
          ? "This removes only the router-owned OAuth client, session, and live proof. Official Antigravity or agy credentials are never read or changed."
          : "If a credential also exists in the environment or Keychain, the router will still report it as connected."}</p></div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoveProvider(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { const provider = removeProvider; setRemoveProvider(null); if (provider && api) void runProviderCredentialAction(provider, `Remove ${provider.displayName} credential`, () => api.removeProviderCredential(provider.id)); }}><Trash2 aria-hidden size={14} strokeWidth={1.7} /> Disconnect</Button>
        </div>
      </Dialog>
    </>
  );

  const filteredFamilies = useMemo(() => {
    const needle = modelSearch.trim().toLowerCase();
    if (!needle && activeProviderFilter === "all") return families;
    return families.filter((family) => {
      if (activeProviderFilter !== "all" && !family.routes.some((model) => model.provider === activeProviderFilter)) return false;
      if (!needle) return true;
      return `${family.displayName} ${family.routes.map((model) => `${model.displayName} ${model.slug} ${providerDisplayName(model.provider)}`).join(" ")}`
        .toLowerCase()
        .includes(needle);
    });
  }, [activeProviderFilter, families, modelSearch]);

  // Row order never depends on a switch. Sorting by on/off would throw the row
  // you just clicked to the other end of the list, at the exact moment you are
  // looking at it to confirm the click did what you meant.
  const rows = useMemo(() => filteredFamilies.map((family) => {
    const usable = family.routes.filter(routeUsable);
    const inPicker = usable.filter((model) => optimisticPicker.value(model.slug, model.visible));
    return { family, usable, inPicker, on: inPicker.length > 0 };
  }), [filteredFamilies, optimisticPicker]);
  const visibleRows = useMemo(() => rows.filter((row) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "blocked") return !row.usable.length;
    if (!row.usable.length) return false;
    return statusFilter === "on" ? row.on : !row.on;
  }), [rows, statusFilter]);
  const readyRows = visibleRows.filter((row) => row.usable.length);
  const blockedRows = visibleRows.filter((row) => !row.usable.length);

  useEffect(() => {
    if (!focusRequest) return;
    const id = focusRequest.region === "providers" ? "model-provider-directory" : "model-catalog-controls";
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  if (!target) {
    return (
      <>
        <div className="providers-models-page models-page">
          <PageHeader
            eyebrow="Models"
            title="Models"
            description="Choose which models your installed clients can use, and connect the accounts that serve them."
            onRefresh={onRefresh}
            refreshing={refreshing}
          />
          {renderConnections()}
          {!dataReady.snapshot ? (
            <section className="panel-section pm-models-loading" aria-label="Loading models" aria-busy="true">
              <PanelSkeleton label="Loading model routes" count={6} />
            </section>
          ) : (
            <EmptyState icon={<SearchX size={22} />} title="Router snapshot unavailable" body="Start the router or refresh after setup completes." />
          )}
        </div>
        {renderConnectionDialogs()}
      </>
    );
  }

  const connectedProviderCount = directory.filter((entry) => providerConnected(entry, enabledProviders)).length;
  const pendingSlugs = directory.flatMap((entry) => pendingCatalogModelIds(pendingModels, entry.id)
    .filter((slug) => !entry.models.some((model) => model.slug === slug)));

  const updatePicker = (slug: string, visible: boolean) => api
    ? optimisticPicker.mutate(slug, visible, `${visible ? "Show" : "Hide"} ${slug}`, () => api.setPickerModel(slug, visible))
    : Promise.resolve();
  const updateSubagent = (slug: string, enabled: boolean) => api
    ? optimisticSubagents.mutate(slug, enabled, `${enabled ? "Enable" : "Disable"} ${slug} as subagent`, () => api.setSubagentModel(slug, enabled))
    : Promise.resolve();
  const updateSubagentEffort = (slug: string, effort: string) => api
    ? optimisticSubagentEfforts.mutate(slug, effort, `Set ${slug} subagent thinking to ${effortLabel(effort)}`, () => api.setSubagentEffort(slug, effort))
    : Promise.resolve();

  // The row-level switch speaks for the whole model: turning it on publishes
  // the route the router would pick anyway, turning it off withdraws every
  // route. Choosing between routes stays inside the expanded row.
  const updateFamilyPicker = (family: ModelFamily, usable: RouterModel[], inPicker: RouterModel[], visible: boolean) => {
    if (!api) return Promise.resolve();
    const selectable = usable.filter((model) => !nativeClientManaged(model));
    if (visible) {
      const route = preferredFamilyRoute({ ...family, routes: selectable }) ?? selectable[0];
      if (!route) return Promise.resolve();
      return optimisticPicker.mutate(route.slug, true, `Show ${family.displayName}`, () => api.setPickerModel(route.slug, true));
    }
    const withdraw = inPicker.filter((model) => !nativeClientManaged(model));
    if (!withdraw.length) return Promise.resolve();
    return optimisticPicker.mutateMany(
      withdraw.map((model) => [model.slug, false] as const),
      `Hide ${family.displayName}`,
      async () => {
        for (const model of withdraw) await api.setPickerModel(model.slug, false);
      },
    );
  };

  // The switch is the whole interaction: it runs the checks, and the router
  // promotes the route only if every one of them passed. A refusal comes back
  // as one sentence rather than a state the reader has to decode.
  const renderRow = ({ family, usable, inPicker, on }: (typeof rows)[number]) => (
    <ModelFamilyRow
      key={family.id}
      family={family}
      usable={usable}
      inPicker={inPicker}
      on={on}
      expanded={expandedFamilyId === family.id}
      onToggleExpanded={() => setExpandedFamilyId(expandedFamilyId === family.id ? null : family.id)}
      apiAvailable={Boolean(api)}
      providerNames={providerNames}
      pickerValue={(model) => optimisticPicker.value(model.slug, model.visible)}
      subagentValue={(model) => optimisticSubagents.value(model.slug, Boolean(subagentEnabled(target, model.slug, subagentSettings)))}
      effortValue={(model) => optimisticSubagentEfforts.value(model.slug, subagentSettings?.efforts?.[model.slug] ?? "default")}
      onFamilyPicker={(visible) => void updateFamilyPicker(family, usable, inPicker, visible)}
      onRoutePicker={(model, visible) => void updatePicker(model.slug, visible)}
      onSubagent={(model, enabled) => void updateSubagent(model.slug, enabled)}
      onEffort={(model, effort) => void updateSubagentEffort(model.slug, effort)}
      onConnect={(providerId) => {
        const entry = directoryById.get(providerId);
        if (!entry?.setup) return;
        if (entry.setup.kind === "oauth" || entry.setup.signIn) openProviderMenu(providerId);
        else if (entry.setup.kind === "configuration") setConfigurationProvider(entry.setup);
        else setCredentialProvider(entry.setup);
      }}
    />
  );

  const crowded = rows.length > CROWDED_LIST;

  return (
    <>
      <div className="providers-models-page models-page">
        <PageHeader
          eyebrow="Models"
          title="Models"
          description="Choose which models your installed clients can use, and connect the accounts that serve them."
          onRefresh={onRefresh}
          refreshing={refreshing}
        />

        {renderConnections()}

        <section className="panel-section pm-model-catalog" id="model-catalog-controls">
          <div className="pm-model-toolbar">
            <SearchField value={modelSearch} onChange={setModelSearch} placeholder="Search models" />
            {/* The count describes the list underneath it. Reporting the whole
                catalogue while a filter is narrowing the view made the filter
                look broken. */}
            <span className="pm-results-count" aria-live="polite">
              {modelSearch || statusFilter !== "all" || activeProviderFilter !== "all"
                ? `${visibleRows.length} of ${families.length} models`
                : `${families.length} models`}
            </span>
            {/* A short list reads whole. Filters and bulk switches only earn
                their space once scrolling starts. */}
            {crowded ? (
              <div className="pm-filter-menu-wrap" ref={filterMenuRef}>
                <button
                  type="button"
                  className="pm-filter-trigger"
                  aria-haspopup="menu"
                  aria-expanded={filterMenuOpen}
                  onClick={() => setFilterMenuOpen((open) => !open)}
                >
                  <Filter aria-hidden size={14} strokeWidth={1.7} />
                  <span>Show</span>
                  <strong>{STATUS_LABELS[statusFilter]}</strong>
                  <ChevronDown aria-hidden size={14} strokeWidth={1.7} className={filterMenuOpen ? "is-open" : ""} />
                </button>
                {filterMenuOpen ? (
                  <div className="pm-filter-menu" role="menu" aria-label="Filter models">
                    {(["all", "on", "off", "blocked"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={statusFilter === value}
                        className={statusFilter === value ? "is-selected" : ""}
                        onClick={() => {
                          setStatusFilter(value);
                          setFilterMenuOpen(false);
                        }}
                      >
                        <span>{STATUS_LABELS[value]}</span>
                        {statusFilter === value ? <Check aria-hidden size={14} strokeWidth={1.9} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {/* Which account serves a model matters most where several of them
                serve overlapping catalogues; below that the list already names
                the provider on every row. */}
            {providerCrowded ? (
              <div className="pm-filter-menu-wrap" ref={providerFilterMenuRef}>
                <button
                  type="button"
                  className="pm-filter-trigger"
                  aria-haspopup="menu"
                  aria-expanded={providerFilterMenuOpen}
                  onClick={() => setProviderFilterMenuOpen((open) => !open)}
                >
                  <Filter aria-hidden size={14} strokeWidth={1.7} />
                  <span>Provider</span>
                  <strong>{activeProviderFilter === "all" ? ALL_PROVIDERS_LABEL : providerNames.get(activeProviderFilter) || activeProviderFilter}</strong>
                  <ChevronDown aria-hidden size={14} strokeWidth={1.7} className={providerFilterMenuOpen ? "is-open" : ""} />
                </button>
                {providerFilterMenuOpen ? (
                  <div className="pm-filter-menu pm-provider-filter-menu" role="menu" aria-label="Filter models by provider">
                    {[{ id: "all", displayName: ALL_PROVIDERS_LABEL }, ...filterProviders].map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={activeProviderFilter === entry.id}
                        className={activeProviderFilter === entry.id ? "is-selected" : ""}
                        onClick={() => {
                          setProviderFilter(entry.id);
                          setProviderFilterMenuOpen(false);
                        }}
                      >
                        <span>{entry.displayName}</span>
                        {activeProviderFilter === entry.id ? <Check aria-hidden size={14} strokeWidth={1.9} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="pm-filter-menu-wrap" ref={bulkMenuRef}>
              <button
                type="button"
                className="pm-icon-trigger"
                aria-haspopup="menu"
                aria-expanded={bulkMenuOpen}
                aria-label="More model actions"
                disabled={!api}
                onClick={() => setBulkMenuOpen((open) => !open)}
              >
                <MoreHorizontal aria-hidden size={15} strokeWidth={1.9} />
              </button>
              {bulkMenuOpen ? (
                <div className="pm-filter-menu" role="menu" aria-label="Bulk model actions">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setBulkMenuOpen(false);
                      if (api) void optimisticPicker.mutateMany(models.filter((model) => !nativeClientManaged(model)).map((model) => [model.slug, true] as const), "Show all router models", () => api.setPickerModels(true));
                    }}
                  >
                    <span>Turn all on</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setBulkMenuOpen(false);
                      if (api) void optimisticPicker.mutateMany(models.filter((model) => !nativeClientManaged(model)).map((model) => [model.slug, false] as const), "Hide all router models", () => api.setPickerModels(false));
                    }}
                  >
                    <span>Turn all off</span>
                  </button>
                </div>
              ) : null}
            </div>
            <Button variant="primary" disabled={!api || !connectedProviderCount} onClick={() => openAddModels()}>
              <Plus aria-hidden size={14} strokeWidth={1.9} /> Add models
            </Button>
          </div>

          {!connectedProviderCount && !families.length ? (
            <EmptyState
              icon={<Plus size={20} />}
              title="Connect a provider to get started"
              body="A provider is the account the router calls on your behalf. Connect one and its models appear here, ready to switch on."
              action={<Button variant="primary" disabled={!api} onClick={() => setConnectMenuOpen(true)}>Connect provider</Button>}
            />
          ) : readyRows.length || blockedRows.length || pendingSlugs.length ? (
            <>
              {readyRows.length || pendingSlugs.length ? (
                <div className="pm-family-list">
                  {pendingSlugs.length ? <PendingModelRows slugs={pendingSlugs} /> : null}
                  {readyRows.map(renderRow)}
                </div>
              ) : null}
              {blockedRows.length ? (
                <section className="pm-group" data-group="blocked">
                  <h3 className="pm-group-heading">
                    <span>Needs a provider</span>
                    <small>{blockedRows.length}</small>
                  </h3>
                  <div className="pm-family-list">{blockedRows.map(renderRow)}</div>
                </section>
              ) : null}
            </>
          ) : (
            <EmptyState
              icon={<SearchX size={20} />}
              title="No models match"
              body={modelSearch || statusFilter !== "all" || activeProviderFilter !== "all"
                ? "Clear the search or the filters, or add models from a connected provider."
                : "Add models from a connected provider to fill this list."}
            />
          )}
        </section>
      </div>

      <AddModelsDialog
        open={addModelsOpen}
        directory={directory}
        catalogStates={catalogStates}
        loading={loadingConnectedCatalogs}
        disabled={!api}
        pendingModels={pendingModels}
        onReload={() => void loadConnectedCatalogs({ refresh: true })}
        initialQuery={addModelsQuery}
        onAdd={(selection) => void addCatalogModels(selection)}
        onClose={() => setAddModelsOpen(false)}
      />
      {renderConnectionDialogs()}
    </>
  );
}

function ConnectionsBar({
  directory,
  enabledProviders,
  usageById,
  apiAvailable,
  platform,
  openProviderId,
  onOpenProvider,
  onCloseProvider,
  connectMenuOpen,
  onConnectMenuOpen,
  isEnabled,
  onEnabledChange,
  onSignIn,
  onConfigure,
  onKey,
  onRemove,
  onAddEndpoint,
  onEditEndpoint,
  onAddEndpointModels,
  onAddNamedModel,
  onRemoveEndpointModel,
}: {
  directory: ProviderDirectoryEntry[];
  enabledProviders: Set<string>;
  usageById: Map<string, NonNullable<ProviderUsageSnapshot["providers"]>[number]>;
  apiAvailable: boolean;
  platform?: string;
  openProviderId: string | null;
  onOpenProvider: (providerId: string) => void;
  onCloseProvider: () => void;
  connectMenuOpen: boolean;
  onConnectMenuOpen: (open: boolean) => void;
  isEnabled: (entry: ProviderDirectoryEntry) => boolean;
  onEnabledChange: (entry: ProviderDirectoryEntry, checked: boolean) => void;
  onSignIn: (entry: ProviderDirectoryEntry) => void;
  onConfigure: (entry: ProviderDirectoryEntry) => void;
  onKey: (entry: ProviderDirectoryEntry) => void;
  onRemove: (entry: ProviderDirectoryEntry) => void;
  onAddEndpoint: () => void;
  onEditEndpoint: (entry: ProviderDirectoryEntry) => void;
  onAddEndpointModels: (entry: ProviderDirectoryEntry) => void;
  onAddNamedModel: (entry: ProviderDirectoryEntry) => void;
  onRemoveEndpointModel: (entry: ProviderDirectoryEntry, model: RouterModel) => void;
}) {
  const barRef = useRef<HTMLElement | null>(null);
  const setConnectMenuOpen = onConnectMenuOpen;
  // Every operator-added endpoint lives under the Custom container: one chip
  // for the lot, with the endpoints listed inside it, instead of a chip each.
  const container = directory.find((entry) => entry.setup?.kind === "per-model");
  const endpoints = container ? directory.filter((entry) => entry.setup?.generic) : [];
  const chips = directory.filter((entry) => !endpoints.includes(entry));
  const isConnected = (entry: ProviderDirectoryEntry) => providerConnected(entry, enabledProviders) || (entry === container && endpoints.length > 0);
  const connected = chips.filter(isConnected);
  const available = chips.filter((entry) => !isConnected(entry));
  const openEndpoint = endpoints.find((entry) => entry.id === openProviderId);

  useEffect(() => {
    if (!openProviderId && !connectMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (barRef.current?.contains(event.target as Node)) return;
      onCloseProvider();
      onConnectMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onCloseProvider();
      onConnectMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [connectMenuOpen, onCloseProvider, onConnectMenuOpen, openProviderId]);

  return (
    <section className="panel-section pm-connections" id="model-provider-directory" ref={barRef} aria-label="Provider connections">
      <div className="pm-connections-label">
        <strong>Connections</strong>
        <small>{connected.length} of {chips.length} connected</small>
      </div>
      <div className="pm-connections-chips">
        {connected.map((entry) => (
          <div className="pm-chip-wrap" key={entry.id}>
            <button
              type="button"
              className="pm-chip"
              data-state="connected"
              aria-haspopup="dialog"
              aria-expanded={openProviderId === entry.id || (entry === container && Boolean(openEndpoint))}
              onClick={() => { setConnectMenuOpen(false); onOpenProvider(entry.id); }}
            >
              <ProviderLogo providerId={entry.id} displayName={entry.displayName} size="small" />
              <span>{entry.displayName}</span>
              <i className="pm-chip-dot" data-enabled={entry === container && endpoints.length ? endpoints.some(isEnabled) || (entry.models.length > 0 && isEnabled(entry)) : isEnabled(entry)} aria-hidden />
            </button>
            {[openProviderId === entry.id ? entry : entry === container ? openEndpoint : undefined].map((shown) => shown ? (
              <ProviderMenu
                key={shown.id}
                entry={shown}
                usage={usageById.get(shown.id)}
                apiAvailable={apiAvailable}
                platform={platform}
                enabled={isEnabled(shown)}
                endpoints={shown === container ? endpoints : undefined}
                isEndpointEnabled={isEnabled}
                onOpenEndpoint={onOpenProvider}
                onBack={shown === openEndpoint ? () => onOpenProvider(entry.id) : undefined}
                backLabel={entry.displayName}
                onEnabledChange={(checked) => onEnabledChange(shown, checked)}
                onSignIn={() => onSignIn(shown)}
                onKey={() => onKey(shown)}
                onRemove={() => onRemove(shown)}
                onAddEndpoint={onAddEndpoint}
                onEditEndpoint={() => onEditEndpoint(shown)}
                onAddModels={() => onAddEndpointModels(shown)}
                onAddNamedModel={() => onAddNamedModel(shown)}
                onRemoveModel={(model) => onRemoveEndpointModel(shown, model)}
              />
            ) : null)}
          </div>
        ))}
        {available.length ? (
          <div className="pm-chip-wrap">
            <button
              type="button"
              className="pm-chip pm-chip-add"
              aria-haspopup="menu"
              aria-expanded={connectMenuOpen}
              onClick={() => { onCloseProvider(); onConnectMenuOpen(!connectMenuOpen); }}
            >
              <Plus aria-hidden size={13} strokeWidth={2} />
              <span>Connect provider</span>
            </button>
            {connectMenuOpen ? (
              <div className="pm-connect-menu" role="menu" aria-label="Providers you can connect">
                {available.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitem"
                    disabled={!apiAvailable || !entry.setup}
                    onClick={() => {
                      setConnectMenuOpen(false);
                      if (!entry.setup) return;
                      if (entry.setup.kind === "oauth" || entry.setup.signIn) onSignIn(entry);
                      else if (entry.setup.kind === "configuration") onConfigure(entry);
                      else if (entry.setup.kind === "anonymous") onEnabledChange(entry, true);
                      else if (entry.setup.kind === "per-model") onAddEndpoint();
                      else onKey(entry);
                    }}
                  >
                    <ProviderLogo providerId={entry.id} displayName={entry.displayName} size="small" />
                    <span>{entry.displayName}</span>
                    <small>{connectionMethod(entry)}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ProviderMenu({
  entry,
  usage,
  apiAvailable,
  platform,
  enabled,
  endpoints,
  isEndpointEnabled,
  onOpenEndpoint,
  onBack,
  backLabel,
  onEnabledChange,
  onSignIn,
  onKey,
  onRemove,
  onAddEndpoint,
  onEditEndpoint,
  onAddModels,
  onAddNamedModel,
  onRemoveModel,
}: {
  entry: ProviderDirectoryEntry;
  endpoints?: ProviderDirectoryEntry[];
  isEndpointEnabled: (entry: ProviderDirectoryEntry) => boolean;
  onOpenEndpoint: (providerId: string) => void;
  onBack?: () => void;
  backLabel?: string;
  usage?: NonNullable<ProviderUsageSnapshot["providers"]>[number];
  apiAvailable: boolean;
  platform?: string;
  enabled: boolean;
  onEnabledChange: (checked: boolean) => void;
  onSignIn: () => void;
  onKey: () => void;
  onRemove: () => void;
  onAddEndpoint: () => void;
  onEditEndpoint: () => void;
  onAddModels: () => void;
  onAddNamedModel: () => void;
  onRemoveModel: (model: RouterModel) => void;
}) {
  const setup = entry.setup;
  // The Custom container is a launcher, not an account: until it holds models
  // of its own there is nothing to switch off and no traffic to report.
  const launcher = setup?.kind === "per-model";
  const emptyLauncher = launcher && entry.models.length === 0;
  return (
    <div className="pm-connection-menu" role="dialog" aria-label={`${entry.displayName} connection`}>
      {onBack ? (
        <button type="button" className="pm-connection-menu-back" onClick={onBack}>
          <ChevronLeft aria-hidden size={12} strokeWidth={1.8} /> {backLabel}
        </button>
      ) : null}
      <div className="pm-connection-menu-head">
        <ProviderLogo providerId={entry.id} displayName={entry.displayName} size="large" />
        <div>
          <strong>{entry.displayName}</strong>
          <small>{launcher ? launcherSummary(entry, endpoints?.length ?? 0) : connectionMethod(entry)}</small>
        </div>
      </div>
      <p className="pm-connection-menu-copy">
        {setup?.generic
          ? `${setup.baseUrl} · ${setup.adapter === "openai-responses" ? "Responses API" : "Chat Completions"}${setup.hasKey ? "" : " · no API key"}`
          : setup?.kind === "per-model"
            ? "Add any OpenAI-compatible endpoint with its base URL and API key, then choose which of its models appear in the picker."
            : setup?.planNote || connectionDetail(entry, usage?.account?.status, usage?.account?.message, platform === "darwin")}
      </p>
      {usage?.requests && !emptyLauncher ? <small className="pm-connection-menu-usage">{usage.requests} {usage.requests === 1 ? "request" : "requests"} so far</small> : null}
      {setup ? (
        <>
          {emptyLauncher ? null : (
            <label className="pm-connection-menu-enable">
              <span>Available to installed clients</span>
              <Toggle
                checked={enabled}
                disabled={!apiAvailable || !setup.configured}
                label={`Make ${entry.displayName} available to installed clients`}
                onChange={onEnabledChange}
              />
            </label>
          )}
          {setup.generic ? (
            <div className="pm-endpoint-models" aria-label={`${entry.displayName} models`}>
              <div className="pm-endpoint-models-head">
                <strong>Models</strong>
                <span className="pm-endpoint-models-buttons">
                  <Button variant="ghost" disabled={!apiAvailable || !setup.configured || setup.enabled === false} onClick={onAddModels}>
                    <Plus aria-hidden size={13} strokeWidth={1.8} /> Add models
                  </Button>
                  <Button variant="ghost" disabled={!apiAvailable || setup.enabled === false} onClick={onAddNamedModel}>
                    <Pencil aria-hidden size={13} strokeWidth={1.8} /> By name
                  </Button>
                </span>
              </div>
              {entry.models.length ? (
                <ul>
                  {entry.models.map((model) => (
                    <li key={model.slug}>
                      <div>
                        <span>{model.displayName}</span>
                        <small>{model.slug}</small>
                      </div>
                      <button
                        type="button"
                        className="pm-endpoint-model-remove"
                        disabled={!apiAvailable}
                        aria-label={`Remove ${model.displayName}`}
                        title="Remove this model"
                        onClick={() => onRemoveModel(model)}
                      >
                        <Trash2 aria-hidden size={13} strokeWidth={1.7} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <small>No models added yet.</small>
              )}
            </div>
          ) : null}
          {launcher && endpoints?.length ? (
            <div className="pm-endpoint-models pm-endpoint-list" aria-label="Custom endpoints">
              <div className="pm-endpoint-models-head"><strong>Endpoints</strong></div>
              <ul>
                {endpoints.map((endpoint) => (
                  <li key={endpoint.id}>
                    <button type="button" onClick={() => onOpenEndpoint(endpoint.id)}>
                      <i className="pm-chip-dot" data-enabled={isEndpointEnabled(endpoint)} aria-hidden />
                      <div>
                        <span>{endpoint.displayName}</span>
                        <small>{endpoint.setup?.baseUrl} · {endpoint.models.length} {endpoint.models.length === 1 ? "model" : "models"}</small>
                      </div>
                      <ChevronRight aria-hidden size={12} strokeWidth={1.8} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="pm-connection-menu-actions" data-solo={launcher}>
            {setup.generic ? (
              <Button variant="ghost" disabled={!apiAvailable} onClick={onEditEndpoint}>
                <Pencil aria-hidden size={14} strokeWidth={1.7} /> Edit endpoint
              </Button>
            ) : null}
            {setup.kind === "oauth" || setup.signIn ? (
              <Button
                variant="ghost"
                disabled={!apiAvailable || setup.action === "blocked" || (entry.id !== "antigravity-oauth" && platform !== "darwin")}
                title={entry.id === "antigravity-oauth" || platform === "darwin" ? undefined : "Open the provider CLI in your own terminal on Windows or Linux."}
                onClick={onSignIn}
              >
                <LogIn aria-hidden size={14} strokeWidth={1.7} />
                {setup.action === "probe" ? "Run live test" : setup.configured ? "Sign in again" : "Open sign-in"}
              </Button>
            ) : null}
            {setup.kind === "per-model" ? (
              <Button variant="secondary" disabled={!apiAvailable} onClick={onAddEndpoint}>
                <Plus aria-hidden size={14} strokeWidth={1.7} /> Add endpoint
              </Button>
            ) : null}
            {setup.kind === "api" && entry.id !== "local" ? (
              <Button variant="ghost" disabled={!apiAvailable} onClick={onKey}>
                <KeyRound aria-hidden size={14} strokeWidth={1.7} /> {setup.configured ? "Replace key" : "Add key"}
              </Button>
            ) : null}
            {((setup.kind === "api" && setup.configured) || setup.disconnectable) && entry.id !== "local" ? (
              <Button variant="ghost" disabled={!apiAvailable} onClick={onRemove}>
                <Trash2 aria-hidden size={14} strokeWidth={1.7} /> {setup.generic ? "Remove endpoint" : "Disconnect"}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ModelFamilyRow({
  family,
  usable,
  inPicker,
  on,
  expanded,
  onToggleExpanded,
  apiAvailable,
  providerNames,
  pickerValue,
  subagentValue,
  effortValue,
  onFamilyPicker,
  onRoutePicker,
  onSubagent,
  onEffort,
  onConnect,
}: {
  family: ModelFamily;
  usable: RouterModel[];
  inPicker: RouterModel[];
  on: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  apiAvailable: boolean;
  providerNames: Map<string, string>;
  pickerValue: (model: RouterModel) => boolean;
  subagentValue: (model: RouterModel) => boolean;
  effortValue: (model: RouterModel) => string;
  onFamilyPicker: (visible: boolean) => void;
  onRoutePicker: (model: RouterModel, visible: boolean) => void;
  onSubagent: (model: RouterModel, enabled: boolean) => void;
  onEffort: (model: RouterModel, effort: string) => void;
  onConnect: (providerId: string) => void;
}) {
  const preferred = preferredFamilyRoute(family);
  const maker = brandForModel(preferred);
  const providerIds = [...new Set(family.routes.map((model) => model.provider))];
  const multiRoute = family.routes.length > 1;
  const blocked = usable.length === 0;
  const managedByClient = usable.length > 0 && usable.every(nativeClientManaged);
  const triggerId = `family-trigger-${safeId(family.id)}`;
  const panelId = `family-panel-${safeId(family.id)}`;

  // One muted line under the name instead of a row of columns. Reading left to
  // right beats hunting the same fact in four different x-positions.
  const facts = [
    providerIds.length > 1 ? `${providerIds.length} providers` : providerNames.get(providerIds[0]) || maker.name,
    preferred?.contextWindow ? formatContext(preferred.contextWindow) : undefined,
    family.routes.some((model) => model.inputModalities?.includes("image")) ? "Text + image" : "Text",
    family.routes.some((model) => model.isFree) ? "Free" : undefined,
    multiRoute ? `${family.routes.length} routes` : undefined,
  ].filter(Boolean);

  return (
    <article className="pm-family-row" data-expanded={expanded} data-on={on} data-blocked={blocked}>
      <div className="pm-family-summary">
        <button
          id={triggerId}
          className="pm-family-open"
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggleExpanded}
        >
          {/* The disclosure sits at the far left, where a caret means "open
              this". Beside the switch it only ever read as part of it. */}
          <ChevronDown className="pm-accordion-chevron" aria-hidden size={14} strokeWidth={2} />
          <BrandLogo brand={maker} size="large" />
          <span className="pm-family-main">
            <strong>{family.displayName}</strong>
            <small>{facts.join(" · ")}</small>
          </span>
        </button>
        <div className="pm-family-action">
          {blocked ? (
            <Button variant="secondary" disabled={!apiAvailable} onClick={() => onConnect(providerIds[0])}>
              {providerIds.length > 1 ? "Connect a provider" : `Connect ${providerNames.get(providerIds[0]) || providerIds[0]}`}
            </Button>
          ) : (
            <>
              <span className="pm-family-state" aria-hidden>{on ? "On" : "Off"}</span>
              <Toggle
                checked={on}
                disabled={!apiAvailable || managedByClient}
                label={managedByClient ? `${family.displayName} is managed by Codex` : `Use ${family.displayName} in Codex`}
                onChange={onFamilyPicker}
              />
            </>
          )}
        </div>
      </div>
      <div id={panelId} className="pm-family-panel" role="region" aria-labelledby={triggerId} hidden={!expanded}>
        {multiRoute ? (
          <>
            <div className="pm-family-route-note">
              The same model reaches you through more than one account. Each one has its own credential, quota, and pricing.
            </div>
            {/* Labelling every row cost 12 words for 4 switches, and every row
                sized its own columns so nothing lined up down the list. One
                header, one shared grid. */}
            <div className="pm-route-table" role="list" aria-label={`${family.displayName} routes`}>
              <div className="pm-route-head" aria-hidden="true">
                <span>Account</span>
                <span>Context</span>
                <span>Input</span>
                <span>In picker</span>
                <span>Subagents</span>
                <span>Thinking</span>
              </div>
              {family.routes.map((model) => (
                <ModelRouteRow
                  key={model.slug}
                  model={model}
                  providerName={providerNames.get(model.provider) || providerDisplayName(model.provider)}
                  pickerVisible={pickerValue(model)}
                  selectedInSettings={subagentValue(model)}
                  subagentEffort={effortValue(model)}
                  apiAvailable={apiAvailable}
                  onPickerChange={(checked) => onRoutePicker(model, checked)}
                  onSubagentChange={(checked) => onSubagent(model, checked)}
                  onEffortChange={(effort) => onEffort(model, effort)}
                  onConnect={() => onConnect(model.provider)}
                />
              ))}
            </div>
          </>
        ) : (
          // A single-route model already showed its name and provider in the
          // row above. Repeating that row inside itself explains nothing, so
          // the panel carries only what the summary had to leave out.
          <ModelDetails
            model={family.routes[0]}
            providerName={providerNames.get(family.routes[0].provider) || providerDisplayName(family.routes[0].provider)}
            selectedInSettings={subagentValue(family.routes[0])}
            subagentEffort={effortValue(family.routes[0])}
            apiAvailable={apiAvailable}
            onSubagentChange={(checked) => onSubagent(family.routes[0], checked)}
            onEffortChange={(effort) => onEffort(family.routes[0], effort)}
          />
        )}
      </div>
    </article>
  );
}

function ModelDetails({
  model,
  providerName,
  selectedInSettings,
  subagentEffort,
  apiAvailable,
  onSubagentChange,
  onEffortChange,
}: {
  model: RouterModel;
  providerName: string;
  selectedInSettings: boolean;
  subagentEffort: string;
  apiAvailable: boolean;
  onSubagentChange: (checked: boolean) => void;
  onEffortChange: (effort: string) => void;
}) {
  return (
    <dl className="pm-model-details">
      <div>
        <dt>Model id</dt>
        <dd className="pm-model-details-mono">{model.slug}</dd>
      </div>
      <div>
        <dt>Route</dt>
        <dd>{providerName} · {modelRouteKind(model)}</dd>
      </div>
      {routeUsable(model) ? (
        <div>
          <dt>Subagents</dt>
          {/* The effort popup extends below this definition-list cell. Keep
              this cell visibly overflowing; the generic text cells still
              ellipsize long ids and route descriptions. */}
          <dd className="pm-model-details-controls">
            <div className="pm-subagent-controls">
              <SubagentToggle
                model={model}
                providerName={providerName}
                selectedInSettings={selectedInSettings}
                apiAvailable={apiAvailable}
                onSubagentChange={onSubagentChange}
              />
              <SubagentEffort
                model={model}
                providerName={providerName}
                selectedInSettings={selectedInSettings}
                subagentEffort={subagentEffort}
                apiAvailable={apiAvailable}
                onEffortChange={onEffortChange}
              />
            </div>
          </dd>
        </div>
      ) : (
        <div>
          <dt>Status</dt>
          <dd>Connect {providerName} to use this route.</dd>
        </div>
      )}
    </dl>
  );
}

// Turning the switch on adds the route to the subagent selection, and the
// router publishes it as v2 with an agent definition Codex can spawn by name.
// That is the whole mechanism -- documented in
// .claude/skills/codex-subagents/SKILL.md as "proven models plus ones you
// explicitly turn on" -- so the switch needs no certification run behind it.
//
// A registry-proven route and one the operator chose look the same here on
// purpose: both are spawnable, and which of the two it is belongs in the
// application record, not in front of someone picking a model.
function subagentControl(model: RouterModel, selectedInSettings: boolean) {
  return {
    checked: selectedInSettings,
    hint: subagentCertification(model) === "v2"
      ? "Codex can spawn subagents on this route."
      : "Switch on to let Codex spawn subagents on this route. Verify it with an agent check before relying on it.",
  };
}

function ModelRouteRow({
  model,
  providerName,
  pickerVisible,
  selectedInSettings,
  subagentEffort,
  apiAvailable,
  onPickerChange,
  onSubagentChange,
  onEffortChange,
  onConnect,
}: {
  model: RouterModel;
  providerName: string;
  pickerVisible: boolean;
  selectedInSettings: boolean;
  subagentEffort: string;
  apiAvailable: boolean;
  onPickerChange: (checked: boolean) => void;
  onSubagentChange: (checked: boolean) => void;
  onEffortChange: (effort: string) => void;
  onConnect: () => void;
}) {
  const identity = (
    <div className="pm-route-identity">
      <ProviderLogo providerId={model.provider} displayName={providerName} size="medium" />
      <div>
        <strong>{providerName}</strong>
        {model.isFree ? <span className="pm-route-free">Free</span> : null}
        <small title={model.slug}>{model.slug}</small>
      </div>
    </div>
  );
  const context = model.contextWindow ? formatContext(model.contextWindow) : "—";
  const input = model.inputModalities?.includes("image") ? "Text + image" : "Text";

  if (!routeUsable(model)) {
    return (
      <article className="pm-route-row" role="listitem" data-availability="known">
        {identity}
        <span className="pm-route-cell">{context}</span>
        <span className="pm-route-cell">{input}</span>
        {/* The same slot the switches occupy, so the right edge answers one
            question all the way down: what can I do with this route. */}
        <span className="pm-route-cell pm-route-connect">
          <Button variant="secondary" disabled={!apiAvailable} onClick={onConnect}>Connect {providerName}</Button>
        </span>
      </article>
    );
  }

  const subagent = subagentControl(model, selectedInSettings);
  return (
    <article className="pm-route-row" role="listitem" data-subagent={subagent.checked ? "enabled" : "disabled"}>
      {identity}
      <span className="pm-route-cell">{context}</span>
      <span className="pm-route-cell">{input}</span>
      <span className="pm-route-cell pm-route-control">
        <Toggle
          checked={pickerVisible}
          disabled={!apiAvailable || nativeClientManaged(model)}
          label={nativeClientManaged(model) ? `${model.displayName} is managed by Codex` : `Show ${model.displayName} through ${providerName} in the picker`}
          onChange={onPickerChange}
        />
      </span>
      <span className="pm-route-cell pm-route-control">
        <SubagentToggle
          model={model}
          providerName={providerName}
          selectedInSettings={selectedInSettings}
          apiAvailable={apiAvailable}
          onSubagentChange={onSubagentChange}
        />
      </span>
      <span className="pm-route-cell pm-route-control">
        <SubagentEffort
          model={model}
          providerName={providerName}
          selectedInSettings={selectedInSettings}
          subagentEffort={subagentEffort}
          apiAvailable={apiAvailable}
          onEffortChange={onEffortChange}
        />
      </span>
    </article>
  );
}

// The route row and the single-route details panel must say the same thing
// about subagents, so they share the control rather than the wording.
// Two cells, so the table keeps one row per route. Stacking the switch and the
// effort menu made every row two lines tall and repeated the word "Thinking"
// down the whole list -- the same noise the column headers removed.
function SubagentToggle({
  model,
  providerName,
  selectedInSettings,
  apiAvailable,
  onSubagentChange,
}: {
  model: RouterModel;
  providerName: string;
  selectedInSettings: boolean;
  apiAvailable: boolean;
  onSubagentChange: (checked: boolean) => void;
}) {
  const subagent = subagentControl(model, selectedInSettings);
  return (
    <div className="pm-model-control" title={subagent.hint}>
      <Toggle
        checked={subagent.checked}
        disabled={!apiAvailable}
        label={`Use ${model.displayName} through ${providerName} as a subagent`}
        onChange={onSubagentChange}
      />
      <span>{subagent.checked ? "On" : "Off"}</span>
    </div>
  );
}

// A native <select> draws its menu shifted left to make room for the macOS
// checkmark gutter, which reads as misalignment inside a table. This page
// already has its own menu pattern for the filter and the connections chips;
// using it here keeps the popup anchored to the control it belongs to.
function SubagentEffort({
  model,
  providerName,
  selectedInSettings,
  subagentEffort,
  apiAvailable,
  onEffortChange,
}: {
  model: RouterModel;
  providerName: string;
  selectedInSettings: boolean;
  subagentEffort: string;
  apiAvailable: boolean;
  onEffortChange: (effort: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const effortOptions = model.reasoningLevels ?? [];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // Nothing to choose on a route that is off, or one with a single-level
  // ladder. An empty cell reads better than a menu nobody can use.
  if (!selectedInSettings || effortOptions.length < 2) {
    return <span className="pm-route-none">—</span>;
  }
  const choices = ["default", ...effortOptions];
  return (
    <div className="pm-effort-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="pm-effort-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${model.displayName} ${providerName} subagent thinking effort`}
        disabled={!apiAvailable}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{effortLabel(subagentEffort)}</span>
        <ChevronDown aria-hidden size={12} strokeWidth={1.8} className={open ? "is-open" : ""} />
      </button>
      {open ? (
        <div className="pm-effort-menu" role="menu">
          {choices.map((effort) => (
            <button
              key={effort}
              type="button"
              role="menuitemradio"
              aria-checked={subagentEffort === effort}
              className={subagentEffort === effort ? "is-selected" : ""}
              onClick={() => {
                setOpen(false);
                if (effort !== subagentEffort) onEffortChange(effort);
              }}
            >
              <span>{effortLabel(effort)}</span>
              {subagentEffort === effort ? <Check aria-hidden size={13} strokeWidth={1.9} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Placeholder rows for models being published to the picker. They carry the
// slug rather than a bare shimmer: the operator picked those names a moment
// ago, and seeing them is what says the click landed on the right ones. Only
// the controls that do not exist yet are left as blanks.
function PendingModelRows({ slugs }: { slugs: string[] }) {
  if (!slugs.length) return null;
  return (
    <>
      {slugs.map((slug) => (
        <article className="pm-model-row pm-model-row-pending" role="listitem" key={`pending-${slug}`}>
          <div className="pm-model-identity">
            <SkeletonBlock className="pm-pending-logo" />
            <div>
              <strong>{slug}</strong>
              <small>Adding…</small>
            </div>
          </div>
          <div className="pm-pending-meta" aria-hidden="true">
            <SkeletonBlock className="pm-pending-line" />
          </div>
          <div className="pm-pending-controls" aria-hidden="true">
            <SkeletonBlock className="pm-pending-control" />
          </div>
        </article>
      ))}
    </>
  );
}

function effortLabel(effort: string): string {
  return effort === "default" ? "Default" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

// One place to add a model, searching every connected provider at once. The
// per-provider catalog browsers this replaces made the same list reachable
// only after picking the right provider first.
function AddModelsDialog({
  open,
  directory,
  catalogStates,
  loading,
  disabled,
  pendingModels,
  onReload,
  onAdd,
  onClose,
  initialQuery = "",
}: {
  open: boolean;
  initialQuery?: string;
  directory: ProviderDirectoryEntry[];
  catalogStates: Record<string, CatalogViewState>;
  loading: boolean;
  disabled: boolean;
  pendingModels: PendingCatalogModels;
  onReload: () => void;
  onAdd: (selection: CatalogModel[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [shownLimit, setShownLimit] = useState(120);

  useEffect(() => {
    if (open) { setQuery(initialQuery); return; }
    setQuery("");
    setSelected([]);
    setShownLimit(120);
  }, [open]);

  const catalogModels = useMemo(
    (): CatalogModel[] => (open ? loadedCatalogModels(directory, catalogStates) : []),
    [catalogStates, directory, open],
  );
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalogModels;
    return catalogModels.filter((model) => (
      `${model.displayName} ${model.modelId} ${model.providerName} ${model.sourceName}`.toLowerCase().includes(needle)
    ));
  }, [catalogModels, query]);
  // Freshness belongs next to the list it describes: a stored catalog can be
  // up to a day old, and nothing else on this surface would say so.
  const lastRead = useMemo(() => Object.values(catalogStates)
    .map((state) => state.data?.fetchedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1), [catalogStates]);
  const selectedKeys = new Set(selected);
  const selectedModels = catalogModels.filter((model) => selectedKeys.has(model.key));
  const errors = Object.values(catalogStates).filter((state) => state.status === "error");
  const shown = matching.slice(0, shownLimit);

  const toggle = (model: CatalogModel, checked: boolean) => {
    setSelected((current) => {
      if (!checked) return current.filter((key) => key !== model.key);
      if (current.length >= CATALOG_ADD_BATCH_LIMIT || current.includes(model.key)) return current;
      return [...current, model.key];
    });
  };

  return (
    <Dialog
      open={open}
      title="Add models"
      description="Everything your connected providers offer. Adding a model makes it available to the router; use the picker switch to show it in your clients."
      onClose={onClose}
    >
      <div className="pm-add-models">
        <div className="pm-add-models-toolbar">
          <SearchField value={query} onChange={setQuery} placeholder="Search every connected provider" />
          <span className="pm-results-count" aria-live="polite">
            {loading
              ? "Loading catalogs"
              : `${matching.length} of ${catalogModels.length} models${lastRead ? ` · read ${formatDateTime(lastRead)}` : ""}`}
          </span>
          <Button variant="ghost" disabled={disabled || loading} onClick={onReload}>
            {loading ? "Asking providers" : "Reload"}
          </Button>
        </div>

        {loading && !catalogModels.length ? <CatalogSkeleton label="Loading provider catalogs" /> : null}

        {!loading && !catalogModels.length ? (
          <EmptyState
            icon={<SearchX size={20} />}
            title={errors.length ? "Catalogs could not be loaded" : "No catalogs available"}
            body={errors[0]?.error || "Connect a provider that publishes a model catalog, then reload."}
          />
        ) : null}

        {shown.length ? (
          <div className="pm-add-models-list" role="list" aria-label="Provider catalog models">
            {shown.map((model) => {
              const adding = (pendingModels[model.providerId]?.[model.modelId] ?? 0) > 0;
              const checked = model.registered || selectedKeys.has(model.key);
              const blocked = !model.registered && !model.addable;
              return (
                <label
                  className="pm-add-models-row"
                  role="listitem"
                  key={model.key}
                  data-published={model.registered}
                  data-blocked={blocked}
                  title={model.blockedReason}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || model.registered || blocked || adding
                      || (!selectedKeys.has(model.key) && selected.length >= CATALOG_ADD_BATCH_LIMIT)}
                    onChange={(event) => toggle(model, event.target.checked)}
                  />
                  <ProviderLogo providerId={model.providerId} displayName={model.providerName} size="medium" />
                  <div className="pm-add-models-identity">
                    <strong>{model.displayName}</strong>
                    <small title={model.modelId}>{model.modelId}</small>
                    {model.blockedReason ? <small className="pm-catalog-block-reason">{model.blockedReason}</small> : null}
                  </div>
                  <span className="pm-add-models-provider">{model.providerName}</span>
                  <div className="pm-add-models-meta">
                    {model.contextWindow ? <span>{formatContext(model.contextWindow)}</span> : null}
                    {model.isFree ? <Badge tone="success">Free</Badge> : null}
                  </div>
                  {adding ? <Badge tone="neutral">Adding</Badge>
                    : model.registered ? <Badge tone="neutral">Added</Badge>
                    : blocked ? <Badge tone="neutral">Not yet supported</Badge>
                    : null}
                </label>
              );
            })}
          </div>
        ) : null}

        {matching.length > shown.length ? (
          <div className="pm-add-models-more">
            <span>{matching.length - shown.length} more models</span>
            <Button variant="ghost" onClick={() => setShownLimit((current) => current + 120)}>Show 120 more</Button>
          </div>
        ) : null}

        {catalogModels.length && !matching.length ? (
          <div className="pm-add-models-empty">No catalog model matches this search.</div>
        ) : null}

        <div className="dialog-actions">
          <span className="pm-add-models-hint">
            Lists are stored locally and re-read in the background once a day. Up to {CATALOG_ADD_BATCH_LIMIT} at a time.
          </span>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={disabled || !selectedModels.length}
            onClick={() => { onAdd(selectedModels); setSelected([]); onClose(); }}
          >
            {selectedModels.length ? `Add ${selectedModels.length} model${selectedModels.length === 1 ? "" : "s"}` : "Add models"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CredentialDialog({ provider, onSave, onClose }: { provider: ProviderSetup | null; onSave: (provider: ProviderSetup, secret: string) => Promise<void>; onClose: () => void }) {
  const [credential, setCredential] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || !credential.trim()) return;
    const secret = credential;
    setCredential("");
    onClose();
    await onSave(provider, secret);
  }
  function close() { setCredential(""); onClose(); }
  return (
    <Dialog open={Boolean(provider)} title={provider?.configured ? `Replace ${provider.displayName} credential` : `Connect ${provider?.displayName || "provider"}`} description="The secret is sent once to the router's hidden standard-input prompt. It is never added to a command." onClose={close}>
      <form className="pm-credential-form" onSubmit={(event) => void submit(event)}>
        {provider ? <div className="pm-credential-provider"><ProviderLogo providerId={provider.id} displayName={provider.displayName} size="large" /><div><strong>{provider.displayName}</strong><small>{provider.id}</small></div></div> : null}
        <label htmlFor="provider-credential">{provider?.credentialLabel || "API key"}</label>
        <input id="provider-credential" type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Enter credential" autoFocus />
        <p><Link2 aria-hidden size={13} strokeWidth={1.7} /> The value is not placed in logs, command arguments, localStorage, or saved renderer state.</p>
        <div className="dialog-actions"><Button type="button" variant="secondary" onClick={close}>Cancel</Button><Button type="submit" variant="primary" disabled={!credential.trim()}>Save credential</Button></div>
      </form>
    </Dialog>
  );
}

function NamedModelDialog({ provider, onSave, onClose }: { provider: ProviderSetup | null; onSave: (provider: ProviderSetup, modelId: string) => Promise<void>; onClose: () => void }) {
  const [modelId, setModelId] = useState("");
  const trimmed = modelId.trim();
  function close() { setModelId(""); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || !trimmed) return;
    const target = provider;
    setModelId("");
    onClose();
    await onSave(target, trimmed);
  }
  return (
    <Dialog
      open={Boolean(provider)}
      title="Add a model by name"
      description="For a model the endpoint does not list, such as a private or preview one. Type the id exactly as the provider gave it to you; nothing checks it against their catalog."
      onClose={close}
    >
      <form className="pm-credential-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="named-model-id">Model id</label>
        <input id="named-model-id" value={modelId} onChange={(event) => setModelId(event.target.value)} autoComplete="off" spellCheck={false} placeholder="provider-model-id" autoFocus />
        <p><Link2 aria-hidden size={13} strokeWidth={1.7} /> It joins the picker as {provider ? `${provider.id}/` : ""}{trimmed || "<model id>"}. A wrong id fails on its first request, and you can remove it here.</p>
        <div className="dialog-actions"><Button type="button" variant="secondary" onClick={close}>Cancel</Button><Button type="submit" variant="primary" disabled={!trimmed}>Add model</Button></div>
      </form>
    </Dialog>
  );
}

type CustomEndpointInput = { displayName: string; baseUrl: string; adapter: "openai-chat" | "openai-responses"; credential?: string };

function CustomEndpointDialog({ open, editing, onSave, onClose }: { open: boolean; editing: ProviderSetup | null; onSave: (endpoint: CustomEndpointInput, editing: ProviderSetup | null) => Promise<void>; onClose: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [adapter, setAdapter] = useState<CustomEndpointInput["adapter"]>("openai-chat");
  const [credential, setCredential] = useState("");
  useEffect(() => {
    if (!open || !editing) return;
    setDisplayName(editing.displayName);
    setBaseUrl(editing.baseUrl || "");
    setAdapter(editing.adapter === "openai-responses" ? "openai-responses" : "openai-chat");
    setCredential("");
  }, [editing, open]);
  const urlValid = (() => {
    try { return ["http:", "https:"].includes(new URL(baseUrl.trim()).protocol); } catch { return false; }
  })();
  const ready = Boolean(displayName.trim()) && urlValid;
  function reset() { setDisplayName(""); setBaseUrl(""); setAdapter("openai-chat"); setCredential(""); }
  function close() { reset(); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    const endpoint: CustomEndpointInput = {
      displayName: displayName.trim(),
      baseUrl: baseUrl.trim(),
      adapter,
      ...(credential.trim() ? { credential } : {}),
    };
    const target = editing;
    reset();
    onClose();
    await onSave(endpoint, target);
  }
  return (
    <Dialog
      open={open}
      title={editing ? `Edit ${editing.displayName}` : "Add custom endpoint"}
      description={editing
        ? `Model names keep their ${editing.id}/ prefix, so models you already added stay where they are.`
        : "Any OpenAI-compatible API. After saving, choose which of its models appear in the picker; each is named after this endpoint so it never clashes with another provider's."}
      onClose={close}
    >
      <form className="pm-credential-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="custom-endpoint-name">Name</label>
        <input id="custom-endpoint-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="off" spellCheck={false} placeholder="My provider" maxLength={120} autoFocus />
        <label htmlFor="custom-endpoint-url">Base URL</label>
        <input id="custom-endpoint-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" />
        <label htmlFor="custom-endpoint-adapter">API format</label>
        <select id="custom-endpoint-adapter" value={adapter} onChange={(event) => setAdapter(event.target.value as CustomEndpointInput["adapter"])}>
          <option value="openai-chat">Chat Completions (/chat/completions)</option>
          <option value="openai-responses">Responses (/responses)</option>
        </select>
        <label htmlFor="custom-endpoint-key">API key</label>
        <input id="custom-endpoint-key" type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" spellCheck={false} placeholder={editing ? (editing.hasKey ? "Leave empty to keep the current key" : "Leave empty to stay keyless") : "Leave empty for a keyless local server"} />
        <p><Link2 aria-hidden size={13} strokeWidth={1.7} /> The key is sent once to the router over standard input and stored in its protected local credential file. It is never placed in logs or command arguments.</p>
        <div className="dialog-actions"><Button type="button" variant="secondary" onClick={close}>Cancel</Button><Button type="submit" variant="primary" disabled={!ready}>{editing ? "Save changes" : "Save and choose models"}</Button></div>
      </form>
    </Dialog>
  );
}

function providerConnected(entry: ProviderDirectoryEntry, enabledProviders: Set<string>): boolean {
  // An anonymous endpoint has no stored account or credential that can make it
  // connected on its own. Treating `configured: true` as a connection here
  // both mislabels an unselected provider and includes its off-box catalog in
  // the bulk "connected" request. Its explicit provider selection is the
  // connection boundary instead.
  if (entry.setup?.kind === "anonymous") return enabledProviders.has(entry.id);
  // The Custom container is always "configured" because it needs no key. It is
  // only a connection once it holds models; empty, it belongs in the connect
  // menu as the way to add an endpoint.
  if (entry.setup?.kind === "per-model") return entry.models.length > 0;
  if (entry.setup) return entry.setup.configured || entry.setup.signedIn === true;
  return entry.models.some((model) => model.native) || enabledProviders.has(entry.id);
}

function providerDisplayName(providerId: string): string {
  return providerId === "openai" ? "OpenAI native" : providerId;
}

function launcherSummary(entry: ProviderDirectoryEntry, endpointCount: number): string {
  const parts = [
    endpointCount ? `${endpointCount} ${endpointCount === 1 ? "endpoint" : "endpoints"}` : "",
    entry.models.length ? `${entry.models.length} ${entry.models.length === 1 ? "model" : "models"}` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "Bring your own endpoint";
}

function connectionMethod(entry: ProviderDirectoryEntry): string {
  if (entry.id === "openai") return "ChatGPT session";
  if (entry.id === "local") return "Local runtime";
  if (!entry.setup) return "Managed catalog";
  if (entry.setup.action === "probe") return "Live test required";
  if (entry.setup.action === "blocked") return "Disconnect required";
  if (entry.setup.kind === "oauth") return "Sign-in";
  if (entry.setup.kind === "configuration") return "Local configuration";
  if (entry.setup.kind === "anonymous") return "No key needed";
  if (entry.setup.generic) return "Custom endpoint";
  if (entry.setup.kind === "per-model") return "Add an endpoint";
  if (entry.setup.signIn) return "Key or sign-in";
  return entry.setup.credentialLabel || "API key";
}

function connectionDetail(entry: ProviderDirectoryEntry, accountStatus?: string, accountMessage?: string, canOpenTerminal?: boolean): string {
  if (entry.id === "openai") return "Uses the signed-in ChatGPT session available to this Codex installation.";
  if (!entry.setup) return "This provider catalog is managed by the router and has no separate credential action here.";
  if (entry.setup.kind === "configuration") {
    return entry.setup.configured
      ? "Google Cloud Application Default Credentials and the protected Vertex project/location are ready."
      : entry.setup.configurationNote || "Run the provider's local configuration command, then refresh this page.";
  }
  if (entry.setup.kind === "anonymous") return "No API key is required. Make it available before routed prompts or catalog loading can use its endpoint.";
  if (entry.setup.action === "probe") return entry.setup.probeNote || "Run the explicit live compatibility test; it sends a small prompt and uses provider quota.";
  if (entry.setup.action === "blocked") return entry.setup.blockedNote || "Disconnect the incompatible router record before signing in again.";
  if (accountStatus === "unavailable") return accountMessage || "Account usage is unavailable. Sign in again if the session expired.";
  if (entry.setup.configured) return "Credential ready. You can take it away from your clients without disconnecting the account.";
  if (entry.setup.kind === "oauth") {
    if (!canOpenTerminal) return "Run the official provider sign-in command in your own terminal, then refresh this page.";
    return entry.setup.cliInstalled === false ? "The official CLI will be installed, then sign-in will open in your system terminal." : "Sign in through the official provider CLI in your system terminal, then refresh.";
  }
  if (entry.setup.signIn) return `Add ${entry.setup.credentialLabel || "an API key"}, or use the provider's browser sign-in.`;
  return `Add ${entry.setup.credentialLabel || "an API key"} to connect this provider.`;
}

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "-"); }
