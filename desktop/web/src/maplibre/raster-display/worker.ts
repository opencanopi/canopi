/**
 * Raster display worker: wires its scope to one lane (`lane.ts`), which holds
 * all of the worker's state. `pool.ts` starts it.
 */
import type { RasterWorkerReply, RasterWorkerRequest } from './protocol'
import { createRasterLane } from './lane'

/** The dedicated worker scope, typed narrowly so the DOM program stays unchanged. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RasterWorkerRequest>) => void) | null
  postMessage(message: RasterWorkerReply, transfer?: Transferable[]): void
}

const lane = createRasterLane((reply, transfer) => scope.postMessage(reply, transfer))
scope.onmessage = (event) => lane.receive(event.data)
