// Planted violation for the tsc-strict family (2.1-M188, 2.1-M225): under exactOptionalPropertyTypes an optional
// property takes no explicit `undefined`, so TypeScript 7 run on desktop/web/tsconfig.strict.json reports TS2375 here,
// an unlisted site of policy/ratchets/tsc-strict.json. Self-contained: it imports nothing from the product tree.
interface PlantedLabel {
  text?: string;
}

export const planted: PlantedLabel = { text: undefined };
