// A planted violation of no-compat-event-alias: compat reads this colour swatch's onChange as input.
export const Planted = ({ recolour }: { recolour: (value: string) => void }) => (
  <input aria-label="Colour" type="color" onChange={(event) => recolour(event.currentTarget.value)} />
)
