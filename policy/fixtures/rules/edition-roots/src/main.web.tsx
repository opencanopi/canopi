// edition-roots:web-root-reaches-no-desktop: the Web root reaches an ipc/ module (the Web graph).
import { plantedIpc } from './ipc/planted';
export const plantedWeb = plantedIpc;
