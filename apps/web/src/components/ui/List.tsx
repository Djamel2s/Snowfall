import { useState, type ReactNode } from 'react'
import { ArrowLeft, Check, LayoutGrid, List, Plus, Search } from 'lucide-react'
import type { CatalogView } from '../../lib/catalog-view'
import { useI18n } from '../../lib/i18n'

// Briques communes des panneaux de la barre latérale (Conversations, Projets,
// Agents, Prompts, Compétences, Connecteurs) : un bouton « Nouveau … », une
// recherche, des sections, des lignes. Même rendu partout ; une fonction
// nouvelle se compose avec elles au lieu d'inventer sa mise en page.

/** Action principale du panneau (« Nouvelle conversation », « Nouvel agent »…). */
export function PanelNew({ label, onClick, disabled, icon }: { label: string; onClick: () => void; disabled?: boolean; icon?: ReactNode }) {
  return (
    <button type="button" className="new-chat-button" onClick={onClick} disabled={disabled}>
      {icon ?? <Plus size={17} />}
      <span>{label}</span>
    </button>
  )
}

/** Recherche du panneau (filtre immédiat). */
export function PanelSearch({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label?: string }) {
  const { t } = useI18n()
  return (
    <label className="search-box">
      <Search size={16} />
      <input aria-label={label ?? placeholder} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      {value && (
        <button className="search-clear" type="button" aria-label={t('sidebar.searchClear')} onClick={() => onChange('')}>
          ×
        </button>
      )}
    </label>
  )
}

/** Retour à la liste depuis une fiche (agent du catalogue, connecteur, projet). */
export function PanelBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="connector-back panel-back" onClick={onClick}>
      <ArrowLeft size={14} />
      {label}
    </button>
  )
}

/** Section titrée (« MES AGENTS », « CATALOGUE »…), avec des actions discrètes à droite. */
export function ListSection({ label, actions, children, ariaLabel }: { label: string; actions?: ReactNode; children: ReactNode; ariaLabel?: string }) {
  return (
    <section className="list-section" aria-label={ariaLabel ?? label}>
      <div className="sidebar-section-label list-section-head">
        <span>{label.toUpperCase()}</span>
        {actions && <span className="list-section-actions">{actions}</span>}
      </div>
      {children}
    </section>
  )
}

/** Petit bouton d'icône d'un en-tête de section. */
export function SectionAction({ label, onClick, children, pressed, disabled }: { label: string; onClick: () => void; children: ReactNode; pressed?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={`projects-add-button${pressed ? ' on' : ''}`} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

type RowProps = {
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** Nom accessible du bouton principal (par défaut : le titre s'il est du texte). */
  label?: string
  tooltip?: string
  onClick?: () => void
  selected?: boolean
  expanded?: boolean
  /** Pastille ou indicateur toujours visible (état, taux de 👍…). */
  trailing?: ReactNode
  /** Actions révélées au survol (modifier, partager, supprimer…). */
  actions?: ReactNode
  /** Contenu déplié sous la ligne (fichiers, partage…). */
  children?: ReactNode
}

/** Une ligne, comme une conversation de l'historique. */
export function ListRow({ icon, title, subtitle, label, tooltip, onClick, selected, expanded, trailing, actions, children }: RowProps) {
  return (
    <li className="list-row-wrap">
      <div className={`conversation-item list-row${selected ? ' selected' : ''}`}>
        <button type="button" className="conversation-select" title={tooltip} aria-label={label} aria-expanded={expanded} onClick={onClick}>
          <span className="list-row-icon">{icon}</span>
          <span className="list-row-text">
            <span className="conversation-title">{title}</span>
            {subtitle && <small>{subtitle}</small>}
          </span>
          {trailing}
        </button>
        {actions && <span className="list-row-actions">{actions}</span>}
      </div>
      {children}
    </li>
  )
}

/** Bouton d'action d'une ligne (révélé au survol, comme « ⋯ » d'une conversation). */
export function RowAction({ label, onClick, children, armed, title, expanded, onBlur }: { label: string; onClick: () => void; children: ReactNode; armed?: boolean; title?: string; expanded?: boolean; onBlur?: () => void }) {
  return (
    <button type="button" className={`conversation-delete${armed ? ' armed' : ''}`} aria-label={label} title={title ?? label} aria-expanded={expanded} onBlur={onBlur} onClick={onClick}>
      {children}
    </button>
  )
}

/** Liste de lignes. */
export function ListRows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="list-rows" aria-label={label}>
      {children}
    </ul>
  )
}

/** Rien à montrer : une phrase, pas un encart. */
export function ListEmpty({ children }: { children: ReactNode }) {
  return <p className="empty-search">{children}</p>
}

/** Catalogue en grille : une tuile par élément, l'icône et le nom dessous. */
export function ListGrid({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="list-grid" aria-label={label}>
      {children}
    </ul>
  )
}

export function GridTile({ icon, title, label, tooltip, onClick, badge }: { icon: ReactNode; title: string; label?: string; tooltip?: string; onClick: () => void; badge?: ReactNode }) {
  return (
    <li className="grid-tile-wrap">
      <button type="button" className="grid-tile" title={tooltip ?? title} aria-label={label ?? title} onClick={onClick}>
        <span className="grid-tile-icon">{icon}</span>
        <span className="grid-tile-title">{title}</span>
        {badge && <span className="grid-tile-badge">{badge}</span>}
      </button>
    </li>
  )
}

/** Bascule grille / liste détaillée, à droite du titre d'un catalogue. */
export function ViewToggle({ view, onChange }: { view: CatalogView; onChange: (view: CatalogView) => void }) {
  const { t } = useI18n()
  return view === 'grid' ? (
    <SectionAction label={t('catalog.showList')} onClick={() => onChange('list')}>
      <List size={14} />
    </SectionAction>
  ) : (
    <SectionAction label={t('catalog.showGrid')} onClick={() => onChange('grid')}>
      <LayoutGrid size={14} />
    </SectionAction>
  )
}

/** Champ de saisie en place (nouveau projet, renommage). */
export function InlineEdit({ initial, label, icon, onSubmit, onCancel }: { initial: string; label: string; icon: ReactNode; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  return (
    <form
      className="project-draft"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = value.trim()
        if (trimmed && trimmed !== initial) onSubmit(trimmed)
        else onCancel()
      }}
    >
      {icon}
      <input
        autoFocus
        aria-label={label}
        placeholder={label}
        maxLength={120}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        onBlur={() => !value.trim() && onCancel()}
        onFocus={(event) => event.target.select()}
      />
      <button type="submit" aria-label={label} disabled={!value.trim()}>
        <Check size={14} />
      </button>
    </form>
  )
}
