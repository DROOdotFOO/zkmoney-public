import { Icon, IconCircle } from "@obsidion/web-ds"
import type { SignInKeyChoice } from "@obsidion/passkey-web"

/** What a card reads aloud: the action, the key, its provider and whether this browser last used it. */
export const keyCardLabel = (verb: string, choice: SignInKeyChoice): string =>
  `${verb} with the ${choice.label.toLowerCase()}${choice.provider ? `, ${choice.provider}` : ""}${
    choice.lastUsed ? ", last used on this browser" : ""
  }`

/**
 * An account's keys as equal cards, each opening the prompt for that key alone. Either key opens
 * the same wallet, so the cards differ only by name; the key this browser last used is tagged.
 */
export function KeyCards({
  caption,
  verb,
  choices,
  disabled,
  onChoose,
  testId,
}: {
  caption: string
  verb: string
  choices: SignInKeyChoice[]
  disabled: boolean
  onChoose: (credentialId: string) => void
  testId: string
}) {
  return (
    <div className="ww-key-choice">
      <span className="ww-key-choice__caption">{caption}</span>
      <ul className="ww-key-cards" data-testid={testId} aria-label={caption}>
        {choices.map((choice) => (
          <li key={choice.credentialId}>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-key-card"
              data-testid="sign-in-key"
              aria-label={keyCardLabel(verb, choice)}
              disabled={disabled}
              onClick={() => onChoose(choice.credentialId)}
            >
              <IconCircle name="key" size={40} glyphSize={18} />
              <span className="ww-key-card__text">
                <span className="ww-key-card__title">{choice.provider ?? choice.label}</span>
                {choice.provider && <span className="ww-key-card__sub">{choice.label}</span>}
                {choice.lastUsed && (
                  <span className="ww-key-card__last" data-testid="sign-in-key-last-used">
                    <Icon name="history-clock" size={10} />
                    Last used
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="ww-key-choice__hint">
        {choices.length > 2
          ? "Any of them opens the same wallet."
          : "Either passkey opens the same wallet."}
      </p>
    </div>
  )
}
