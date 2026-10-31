// type-cycles: two type modules import each other's types only.
import type { PlantedB } from './planted-b';
export interface PlantedA { b?: PlantedB }
