import type { CSSProperties, ReactNode } from "react"
import { GradientInitialAvatar } from "./Avatars"
import { IconCircle, RowChevron } from "./GlassCircle"
import { GradientText } from "./GradientText"

export interface SettingsRowProps {
  /** Leading icon inside a glass circle; omit to drop it. */
  icon?: string
  /** Custom leading node; takes precedence over `icon`. */
  leading?: ReactNode
  label: string
  labelSize?: number
  /** Secondary content under the label; the leading icon then aligns to the top. */
  description?: ReactNode
  disabled?: boolean
  onClick?: () => void
  /** Trailing view: RowChevron, GradientToggle, value text, pill… */
  trailing?: ReactNode
  className?: string
}

/** Settings/profile row: optional glass icon circle, label, arbitrary trailing view. Min height 44. */
export function SettingsRow({
  icon,
  leading,
  label,
  labelSize = 16,
  description,
  disabled = false,
  onClick,
  trailing,
  className,
}: SettingsRowProps) {
  const labelNode = (
    <span
      className="zkm-settings-row__label"
      style={{
        fontSize: labelSize,
        color: disabled ? "rgba(255,255,255,0.4)" : "var(--text-primary)",
      }}
    >
      {label}
    </span>
  )
  const leadingNode = leading ?? (icon ? <IconCircle name={icon} /> : null)
  // The described row is a grid; its slots are wrapped so a stylesheet can place them.
  const content = description ? (
    <>
      {leadingNode && <span className="zkm-settings-row__leading">{leadingNode}</span>}
      {labelNode}
      <span className="zkm-settings-row__description">{description}</span>
      {trailing && <span className="zkm-settings-row__trailing">{trailing}</span>}
    </>
  ) : (
    <>
      {leadingNode}
      {labelNode}
      <span className="zkm-row-spacer" />
      {trailing}
    </>
  )
  const classes = [
    "zkm-settings-row",
    description ? "zkm-settings-row--described" : undefined,
    className,
  ]
  if (onClick && !disabled) {
    return (
      <button
        type="button"
        className={["zkm-btn-reset", ...classes].filter(Boolean).join(" ")}
        onClick={onClick}
      >
        {content}
      </button>
    )
  }
  return <div className={classes.filter(Boolean).join(" ")}>{content}</div>
}

export interface ContactRowProps {
  /** Handle ("@cyphergirl" or "cyphergirl.zk.money") or truncated L1 address. */
  tag: string
  /** L1 wallet label, or the name a user gave an L2 contact (shown over its full tag). */
  name?: string
  isL1?: boolean
  colors?: readonly [string, string]
  onClick?: () => void
  /** Optional avatar presentation; the default size and style remain unchanged. */
  avatarStyle?: CSSProperties
  /** Custom trailing content; defaults to the row chevron. */
  trailing?: ReactNode
  className?: string
}

/** Contact list row: gradient initial avatar, gradient handle, muted subtitle, trailing chevron. */
export function ContactRow({ tag, name, isL1 = false, colors, onClick, avatarStyle, trailing, className }: ContactRowProps) {
  const handle = tag.replace(/^@/, "").split(".")[0]
  const label = name?.trim()
  // An L2 contact saves under its tag, or its messaging address before the tag resolves.
  const hasLabel = isL1
    ? !!label && label !== "External Wallet"
    : !!label && label !== handle && !/^0x[0-9a-f]+$/i.test(label)
  const title = hasLabel ? label! : isL1 ? tag : `@${handle}`
  const subtitle = isL1 ? (hasLabel ? tag : "Ethereum wallet") : hasLabel ? `@${handle}.zk.money` : "zk.money"
  const initialSource = hasLabel ? label! : tag.replace(/^@/, "")
  return (
    <button type="button" className={["zkm-btn-reset zkm-contact-row", className].filter(Boolean).join(" ")} onClick={onClick}>
      <GradientInitialAvatar name={initialSource} colors={colors} size={44} style={avatarStyle} />
      <span className="zkm-contact-row__text">
        <GradientText size={16} weight={500} className={hasLabel ? undefined : "zkm-contact-row__tag"}>
          {title}
        </GradientText>
        <span className="zkm-contact-row__subtitle">{subtitle}</span>
      </span>
      <span className="zkm-row-spacer" />
      {trailing ?? <RowChevron />}
    </button>
  )
}

export interface SearchResultRowProps {
  title: string
  subtitle: string
  onClick?: () => void
  className?: string
}

/** Tappable search-result row with placeholder dot avatar on a dark translucent card. */
export function SearchResultRow({ title, subtitle, onClick, className }: SearchResultRowProps) {
  return (
    <button type="button" className={["zkm-btn-reset zkm-search-row", className].filter(Boolean).join(" ")} onClick={onClick}>
      <span className="zkm-search-row__avatar">
        <span className="zkm-search-row__dot" />
      </span>
      <span className="zkm-search-row__text">
        <span className="zkm-search-row__title">{title}</span>
        <span className="zkm-search-row__subtitle">{subtitle}</span>
      </span>
    </button>
  )
}

export interface ListRowProps {
  title: string
  subtitle: string
  /** Dims title/subtitle and drops the title gradient. */
  disabled?: boolean
  leading?: ReactNode
  trailing?: ReactNode
  /** Float the trailing node top-right (e.g. a ComingSoonPill) so the subtitle gets full width. */
  floatingTrailing?: boolean
  className?: string
}

/** Payment-method picker row: leading icon + gradient title/subtitle + trailing chrome. */
export function ListRow({ title, subtitle, disabled = false, leading, trailing, floatingTrailing = false, className }: ListRowProps) {
  return (
    <div className={["zkm-list-row", className].filter(Boolean).join(" ")}>
      {leading}
      <span className="zkm-list-row__text">
        {disabled ? (
          <span className="zkm-list-row__title" style={{ color: "#565656" }}>
            {title}
          </span>
        ) : (
          <GradientText size={16} weight={500} className="zkm-list-row__title">
            {title}
          </GradientText>
        )}
        <span className="zkm-list-row__subtitle" style={disabled ? { color: "#565656" } : undefined}>
          {subtitle}
        </span>
      </span>
      {!floatingTrailing && <span className="zkm-row-spacer" />}
      {trailing && (
        <span className={floatingTrailing ? "zkm-list-row__floating-trailing" : undefined}>{trailing}</span>
      )}
    </div>
  )
}

/** "Coming soon" gradient capsule badge. */
export function ComingSoonPill({ label = "Coming soon" }: { label?: string }) {
  return <span className="zkm-coming-soon">{label}</span>
}
