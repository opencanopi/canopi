import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { appCommandGraphChromeProjection, commandPaletteOpen } from "../../commands/registry";
import { saveProblem } from "../../app/document-session/save-problem";
import { t } from "../../i18n";
import { useModalLayer } from "./useModalLayer";
import styles from "./CommandPalette.module.css";

/**
 * The palette mounts only while open, so it can hold the modal layer like
 * every other dialog: the chrome behind it is inert, shortcuts and F6 stand
 * down, and focus goes back to the control that opened it when it closes.
 */
export function CommandPalette() {
  if (!commandPaletteOpen.value) return null;
  return <CommandPaletteDialog />;
}

function CommandPaletteDialog() {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = "command-palette-list";

  const releaseModalLayer = useModalLayer();
  // Focus goes in as the palette commits, with its modal layer, so an Esc at once is the palette's
  // (canopi-f47t.52.228.20).
  useLayoutEffect(() => { inputRef.current?.focus(); }, []);

  // A save problem asks over everything; the palette must not run commands under it.
  useSignalEffect(() => {
    if (saveProblem.value !== null) commandPaletteOpen.value = false;
  });

  const commands = appCommandGraphChromeProjection.value.paletteCommands;
  const filtered = commands.filter((cmd) =>
    cmd.label().toLowerCase().includes(query.toLowerCase())
  );

  function execute(idx: number) {
    const cmd = filtered[idx];
    if (!cmd || cmd.disabled()) return;
    // Release the chrome before the command runs: a command that focuses the
    // title bar or a panel (Find plants, Search a place) must find it live, and
    // the palette's unmount must not send focus back over it.
    releaseModalLayer();
    commandPaletteOpen.value = false;
    cmd.action();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute(activeIdx);
    } else if (e.key === "Escape") {
      // The palette takes its Esc: it unmounts and releases the modal layer
      // before the key router's bubble listener, which would otherwise run the
      // Esc chain too and close a popover or the inspection under it.
      e.preventDefault();
      e.stopPropagation();
      commandPaletteOpen.value = false;
    }
  }

  const activeItemId = filtered[activeIdx]
    ? `cmd-${filtered[activeIdx]!.id}`
    : undefined;

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) commandPaletteOpen.value = false;
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t("commands.commandPalette")}
    >
      <div className={styles.palette}>
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          placeholder={t("commands.searchPlaceholder")}
          value={query}
          onInput={(e) => {
            setQuery((e.target as HTMLInputElement).value);
            setActiveIdx(0);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-controls={listId}
          aria-expanded="true"
          aria-activedescendant={activeItemId}
        />
        <div className={styles.list} role="listbox" id={listId}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>{t("commands.noResults")}</div>
          ) : (
            filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                id={`cmd-${cmd.id}`}
                className={`${styles.item} ${i === activeIdx ? styles.active : ""}`}
                onClick={() => execute(i)}
                role="option"
                aria-selected={i === activeIdx}
                aria-disabled={cmd.disabled()}
              >
                <span>{cmd.label()}</span>
                {cmd.shortcut && (
                  <span className={styles.shortcut}>{cmd.shortcut}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
