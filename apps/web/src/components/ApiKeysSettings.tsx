import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { api, type Agent, type ApiKey } from "../lib/api";
import { useI18n } from "../lib/i18n";

const durations = [30, 90, 180, 365] as const;

/**
 * Clés (administrateurs), montrées une fois ; ensuite, seuls leur début et leur
 * usage restent visibles :
 * - « api » : une application tierce appelle des agents choisis ;
 * - « scim » : l'annuaire de l'entreprise pousse les comptes (sans agent).
 * Dans les deux cas, la clé agit au nom de l'administrateur qui la crée.
 */
export default function ApiKeysSettings({
  onError,
  kind = "api",
}: {
  onError: (message: string) => void;
  kind?: "api" | "scim";
}) {
  const { t, locale } = useI18n();
  const scim = kind === "scim";
  const label = (key: string) =>
    t(`${scim ? "scim" : "apiKeys"}.${key}` as Parameters<typeof t>[0]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [days, setDays] = useState<(typeof durations)[number]>(90);
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Instant de référence (expiration), fixé à l'ouverture : le rendu reste pur.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listApiKeys(),
      scim ? Promise.resolve([]) : api.listAgents(),
    ])
      .then(([items, list]) => {
        if (cancelled) return;
        // Chaque carte ne montre que ses clés (API ou SCIM).
        setKeys(items.filter((item) => (item.kind ?? "api") === kind));
        setAgents(list);
      })
      .catch(
        (cause: unknown) =>
          !cancelled &&
          onError(cause instanceof Error ? cause.message : String(cause)),
      );
    return () => {
      cancelled = true;
    };
  }, [onError, kind, scim]);

  const fail = (cause: unknown) =>
    onError(cause instanceof Error ? cause.message : String(cause));
  const agentName = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? t("apiKeys.agentGone");
  const date = (value: string) =>
    new Date(value).toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const state = (key: ApiKey) =>
    key.revokedAt
      ? "revoked"
      : Date.parse(key.expiresAt) <= now
        ? "expired"
        : "active";

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || (!scim && !chosen.length)) return;
    setBusy(true);
    onError("");
    try {
      const created = await api.createApiKey(
        scim
          ? { kind: "scim", name: name.trim(), expiresInDays: days }
          : { name: name.trim(), agentIds: chosen, expiresInDays: days },
      );
      setKeys((current) => [created.record, ...current]);
      setFresh({ key: created.key, name: created.record.name });
      setCopied(false);
      setName("");
      setChosen([]);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKey) {
    if (armed !== key.id) return setArmed(key.id);
    try {
      await api.revokeApiKey(key.id);
      setKeys((current) =>
        current.map((item) =>
          item.id === key.id
            ? { ...item, revokedAt: new Date().toISOString() }
            : item,
        ),
      );
      setArmed(null);
    } catch (cause) {
      fail(cause);
    }
  }

  return (
    <section className="settings-card api-keys" aria-label={label("title")}>
      <h3>{label("title")}</h3>
      <p className="settings-hint">{label("hint")}</p>
      {scim && (
        <div className="api-key-value" aria-label={t("scim.endpoint")}>
          <code>{`${window.location.origin}/api/scim/v2`}</code>
        </div>
      )}

      {fresh && (
        <div className="api-key-fresh" role="status">
          <strong>{t("apiKeys.freshTitle", { name: fresh.name })}</strong>
          <p>{t("apiKeys.freshHint")}</p>
          <div className="api-key-value">
            <code>{fresh.key}</code>
            <button
              type="button"
              className="icon-button"
              aria-label={t("apiKeys.copy")}
              title={t("apiKeys.copy")}
              onClick={() =>
                void navigator.clipboard
                  .writeText(fresh.key)
                  .then(() => setCopied(true))
                  .catch(() => undefined)
              }
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <button
            type="button"
            className="settings-secondary"
            onClick={() => setFresh(null)}
          >
            {t("apiKeys.done")}
          </button>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="api-key-list">
          {keys.map((key) => (
            <li
              key={key.id}
              className={state(key) === "active" ? "" : "inactive"}
            >
              <KeyRound size={14} />
              <span className="api-key-main">
                <strong>{key.name}</strong>
                <small>
                  <code>{key.prefix}…</code>
                  {!scim && ` · ${key.agentIds.map(agentName).join(", ")}`}
                </small>
                <small>
                  {state(key) === "revoked"
                    ? t("apiKeys.revoked")
                    : state(key) === "expired"
                      ? t("apiKeys.expired")
                      : t("apiKeys.expires", { date: date(key.expiresAt) })}
                  {" · "}
                  {key.lastUsedAt
                    ? t("apiKeys.lastUsed", { date: date(key.lastUsedAt) })
                    : t("apiKeys.neverUsed")}
                </small>
              </span>
              {state(key) === "active" && (
                <button
                  type="button"
                  className={`settings-icon ${armed === key.id ? "armed" : ""}`}
                  aria-label={
                    armed === key.id
                      ? t("apiKeys.confirmRevoke", { name: key.name })
                      : t("apiKeys.revoke", { name: key.name })
                  }
                  title={t("apiKeys.revoke", { name: key.name })}
                  onBlur={() => setArmed(null)}
                  onClick={() => void revoke(key)}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="api-key-form"
        aria-label={label("new")}
        onSubmit={(event) => void create(event)}
      >
        <input
          aria-label={label("name")}
          placeholder={label("name")}
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        {!scim && (
          <fieldset>
            <legend>{t("apiKeys.agents")}</legend>
            {agents.length === 0 && (
              <p className="settings-hint">{t("apiKeys.noAgents")}</p>
            )}
            {agents.map((agent) => (
              <label key={agent.id} className="settings-row">
                <input
                  type="checkbox"
                  checked={chosen.includes(agent.id)}
                  onChange={() =>
                    setChosen(
                      chosen.includes(agent.id)
                        ? chosen.filter((id) => id !== agent.id)
                        : [...chosen, agent.id],
                    )
                  }
                />
                <span>{agent.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="settings-row">
          <span>{t("apiKeys.duration")}</span>
          <select
            value={days}
            onChange={(event) =>
              setDays(Number(event.target.value) as (typeof durations)[number])
            }
          >
            {durations.map((value) => (
              <option key={value} value={value}>
                {t("apiKeys.days", { count: value })}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="settings-save"
          disabled={busy || !name.trim() || (!scim && !chosen.length)}
        >
          <Plus size={14} />
          {label("create")}
        </button>
      </form>
    </section>
  );
}
