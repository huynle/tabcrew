import { loadPlacement, parsePlacement, savePlacement, type Placement } from "../config.js";

/** The bits of an `<input type="radio">` the placement setting uses. */
export interface RadioLike {
  value: string;
  checked: boolean;
  addEventListener(type: "change", listener: () => void): void;
}

/**
 * Check the radio matching the stored placement and persist the user's choice on change (then
 * report it to `onChange`). Returns the stored placement. The setting only applies to sessions
 * that have not created a tab yet.
 */
export async function bindPlacementRadios(radios: readonly RadioLike[], onChange?: (placement: Placement) => void): Promise<Placement> {
  const current = await loadPlacement();
  for (const radio of radios) {
    radio.checked = radio.value === current;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const placement = parsePlacement(radio.value);
      void savePlacement(placement);
      onChange?.(placement);
    });
  }
  return current;
}
