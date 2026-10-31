// A planted presence branch (ADR 0030): an absent Desktop-only prop stands for "the other edition".
export const Planted = ({ windowControls }: { windowControls?: unknown }) => <header>{windowControls && <span />}</header>
