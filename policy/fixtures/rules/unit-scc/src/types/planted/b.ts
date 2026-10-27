import { plantedA } from '../../utils/planted/a';
export const plantedB = (): number => (plantedA.length > 0 ? 0 : 1);
